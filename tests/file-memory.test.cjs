const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');

const compiled = process.env.NITRO_XXHASH_TEST_LIB || path.resolve(__dirname, '../lib');
const runFileHash = require(path.join(compiled, 'src/runFileHash.js')).default;
const turn = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((fulfill) => {
    resolve = fulfill;
  });
  return { promise, resolve };
}

function work(result) {
  return { result: () => result, cancel() {} };
}

async function cancelWithLargeOwners(result) {
  const controller = new AbortController();
  const reason = { payload: new ArrayBuffer(1024 * 1024) };
  const owner = { payload: new ArrayBuffer(1024 * 1024) };
  const refs = {
    owner: new WeakRef(owner),
    payload: new WeakRef(owner.payload),
    reason: new WeakRef(reason),
    signal: new WeakRef(controller.signal),
  };
  const pending = runFileHash(controller.signal, () => {
    assert.equal(owner.payload.byteLength, 1024 * 1024);
    return work(result);
  });
  controller.abort(reason);
  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.cause === reason);
  return refs;
}

async function assertCollected(refs) {
  for (let count = 0; count < 8; count += 1) {
    await turn();
    global.gc();
  }
  const retained = Object.keys(refs).filter((name) => refs[name].deref() !== undefined);
  assert.deepEqual(retained, [], 'Cancelled file work must detach application owners');
}

test(
  'cancelled active and queued files detach signal, reason and source arguments',
  { skip: typeof global.gc !== 'function' && 'Run with node --expose-gc' },
  async () => {
    const active = deferred();
    const activeRefs = await cancelWithLargeOwners(active.promise);
    await assertCollected(activeRefs);
    const blocker = deferred();
    const second = runFileHash(undefined, () => work(blocker.promise));
    const queued = deferred();
    const queuedRefs = await cancelWithLargeOwners(queued.promise);
    await assertCollected(queuedRefs);
    // Cancelled active work still consumes its native permit until actual completion.
    active.resolve('done');
    blocker.resolve('done');
    await second;
    await turn();
    queued.resolve('never started');
  },
);
