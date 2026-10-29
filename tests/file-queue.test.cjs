const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function fixture({ trackJobs = false } = {}) {
  const stats = { jobs: [] };
  const compiled = process.env.NITRO_XXHASH_TEST_LIB || path.resolve(__dirname, '../lib');
  const filename = path.join(compiled, 'src/runFileHash.js');
  const module = { exports: {} };
  let source = fs.readFileSync(filename, 'utf8');
  if (trackJobs) {
    const anchor = /\bif \(signal\) \{/g;
    assert.equal(
      [...source.matchAll(anchor)].length,
      1,
      'Locate the single job subscription boundary',
    );
    source = source.replace(anchor, 'trackQueueJob(job); if (signal) {');
  }
  vm.runInThisContext(`(function(require,module,exports,trackQueueJob){${source}\n})`, {
    filename,
  })(
    (request) => require(path.resolve(path.dirname(filename), request)),
    module,
    module.exports,
    (job) => stats.jobs.push(new WeakRef(job)),
  );
  return { run: module.exports.default, stats };
}

const work = (promise) => ({ result: () => promise });
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('file queue preserves FIFO through cancellation, reentrant insertions and later waves', async () => {
  const { run } = fixture();
  const blockers = [deferred(), deferred()];
  const starts = [];
  const results = blockers.map((blocker, index) =>
    run(undefined, () => {
      starts.push(`blocker-${index}`);
      return work(blocker.promise);
    }),
  );
  const controllers = Array.from({ length: 60 }, () => new AbortController());
  const failure = new Error('reentrant queue setup failed');
  for (let index = 0; index < controllers.length; index += 1) {
    results.push(
      run(controllers[index].signal, () => {
        starts.push(String(index));
        if (index === 20) {
          controllers[40].abort('removed during another admission');
          results.push(
            run(undefined, () => {
              starts.push('child');
              return work(Promise.resolve('child'));
            }),
          );
        }
        if (index === 31) throw failure;
        return work(Promise.resolve(String(index)));
      }).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
    );
  }
  for (const index of [10, 11, 12]) controllers[index].abort('removed before admission');
  blockers.forEach((blocker) => blocker.resolve('done'));
  await turn();
  const settled = await Promise.all(results);
  const expected = ['blocker-0', 'blocker-1'];
  for (let index = 0; index < controllers.length; index += 1) {
    if (![10, 11, 12, 40].includes(index)) expected.push(String(index));
  }
  expected.push('child');
  assert.deepEqual(starts, expected);
  assert.equal(settled[31 + 2].error, failure);
  for (const index of [10, 11, 12, 40]) {
    assert.equal(settled[index + 2].error.name, 'AbortError');
  }
  assert.equal(await run(undefined, () => work(Promise.resolve('later wave'))), 'later wave');
});

test('large queued batches finish while another worker remains occupied', async () => {
  const { run } = fixture();
  const blockers = [deferred(), deferred()];
  const active = blockers.map((blocker) => run(undefined, () => work(blocker.promise)));
  const count = 2048;
  const starts = [];
  const queued = Array.from({ length: count }, (_, index) =>
    run(undefined, () => {
      starts.push(index);
      return work(Promise.resolve(String(index)));
    }),
  );
  blockers[0].resolve('first');
  assert.deepEqual(
    await Promise.all(queued),
    Array.from({ length: count }, (_, index) => String(index)),
  );
  assert.deepEqual(
    starts,
    Array.from({ length: count }, (_, index) => index),
  );
  blockers[1].resolve('second');
  await Promise.all(active);
});

test('cancelling the entire remaining queue allows a fresh wave', async () => {
  const { run } = fixture();
  const blockers = [deferred(), deferred(), deferred()];
  const starts = [];
  const results = blockers.slice(0, 2).map((blocker, index) =>
    run(undefined, () => {
      starts.push(`blocker-${index}`);
      return work(blocker.promise);
    }),
  );
  results.push(
    run(undefined, () => {
      starts.push('admitted');
      return work(blockers[2].promise);
    }),
  );
  const controllers = [new AbortController(), new AbortController()];
  for (const controller of controllers) {
    results.push(
      run(controller.signal, () => {
        assert.fail('Cancelled queued work must never start');
      }).catch((error) => assert.equal(error.name, 'AbortError')),
    );
  }
  blockers[0].resolve('first');
  await turn();
  controllers.forEach((controller) => controller.abort());
  results.push(
    run(undefined, () => {
      starts.push('new wave');
      return work(Promise.resolve('new wave'));
    }),
  );
  blockers[1].resolve('second');
  await turn();
  assert.deepEqual(starts, ['blocker-0', 'blocker-1', 'admitted', 'new wave']);
  blockers[2].resolve('third');
  await Promise.all(results);
});

test(
  'cancelled batches retain no job metadata while an anchor waits behind hung workers',
  { skip: typeof global.gc !== 'function' && 'Run with node --expose-gc' },
  async () => {
    const { run, stats } = fixture({ trackJobs: true });
    const gates = [deferred(), deferred(), deferred()];
    const first = run(undefined, () => work(gates[0].promise));
    const second = run(undefined, () => work(gates[1].promise));
    const admitted = run(undefined, () => work(gates[2].promise));
    const anchor = run(undefined, () => work(Promise.resolve('anchor')));
    gates[0].resolve('first');
    await first;
    const offset = stats.jobs.length;
    async function cancelWave() {
      const controllers = [];
      const results = [];
      for (let index = 0; index < 1000; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        results.push(
          run(controller.signal, () => {
            assert.fail('Cancelled queued work must not start');
          }).catch((error) => assert.equal(error.name, 'AbortError')),
        );
      }
      controllers.forEach((controller) => controller.abort());
      await Promise.all(results);
    }
    try {
      for (let wave = 0; wave < 10; wave += 1) await cancelWave();
      for (let count = 0; count < 8; count += 1) {
        await turn();
        global.gc();
      }
      const cancelled = stats.jobs.slice(offset);
      assert.equal(cancelled.length, 10000);
      assert.equal(
        cancelled.filter((ref) => ref.deref() !== undefined).length,
        0,
        'Cancellation must unlink metadata even while other jobs keep the queue alive',
      );
    } finally {
      gates[1].resolve('second');
      gates[2].resolve('admitted');
      await Promise.all([second, admitted, anchor]);
    }
  },
);
