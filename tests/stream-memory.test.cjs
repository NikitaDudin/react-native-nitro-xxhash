const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const turn = () => new Promise((resolve) => setImmediate(resolve));
const gcRequired = { skip: typeof global.gc !== 'function' && 'Run with node --expose-gc' };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture(stats) {
  const cache = new Map();
  const native = {
    createHasher() {
      const state = {
        updateString() {},
        updateBuffer() {},
        digest: () => '00000000000000000000000000000000',
        dispose() {
          stats.disposed += 1;
        },
      };
      stats.native = new WeakRef(state);
      return state;
    },
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const localRequire = (request) => {
      if (request === 'react-native-nitro-modules')
        return { NitroModules: { createHybridObject: () => native } };
      if (request.endsWith('/NativeXXHashLoader')) return { default() {} };
      assert.ok(request.startsWith('.'), `Unexpected production dependency: ${request}`);
      return load(path.resolve(path.dirname(filename), `${request}.js`));
    };
    vm.runInThisContext(
      `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
      { filename },
    )(localRequire, module, module.exports);
    return module.exports;
  }
  const compiled = process.env.NITRO_XXHASH_TEST_LIB || path.resolve(__dirname, '../lib');
  return load(path.join(compiled, 'src/hashStreamInput.js')).default;
}

function sourceFixture(read, cleanup, readerMode, stats) {
  const owner = { payload: new ArrayBuffer(1024 * 1024) };
  const close = () => {
    stats.closed += 1;
    return cleanup;
  };
  const next = () => read;
  let source;
  if (readerMode) {
    Object.assign(owner, {
      read: next,
      cancel: close,
      releaseLock() {
        stats.released += 1;
        if (stats.cannotRelease) throw new Error('A read is still pending');
      },
    });
    source = { getReader: () => owner };
  } else {
    Object.assign(owner, { next, return: close });
    source = { [Symbol.asyncIterator]: () => owner };
  }
  return {
    source,
    refs: {
      source: new WeakRef(source),
      owner: new WeakRef(owner),
      payload: new WeakRef(owner.payload),
    },
  };
}

async function collectGarbage() {
  // Cross jobs before each collection: WeakRef keeps dereferenced objects alive
  // until the end of their current job even when all application owners release.
  for (let count = 0; count < 8; count += 1) {
    await turn();
    global.gc();
  }
}

function assertReleased(refs) {
  const retained = Object.entries(refs)
    .filter(([, ref]) => ref.deref() !== undefined)
    .map(([name]) => name);
  assert.deepEqual(retained, [], 'Completed cancellation must release application owners');
}

test(
  'a hung read cannot retain closed sources, native state or abort reasons',
  gcRequired,
  async () => {
    for (const readerMode of [false, true]) {
      const pending = deferred();
      const stats = { disposed: 0, closed: 0, released: 0 };
      const hashStream = fixture(stats);
      async function start() {
        const controller = new AbortController();
        const reason = { payload: new ArrayBuffer(1024 * 1024) };
        const { source, refs } = sourceFixture(pending.promise, undefined, readerMode, stats);
        refs.signal = new WeakRef(controller.signal);
        refs.reason = new WeakRef(reason);
        const result = hashStream(source, { signal: controller.signal });
        controller.abort(reason);
        await assert.rejects(
          result,
          (error) => error.name === 'AbortError' && error.cause === reason,
        );
        return refs;
      }
      const refs = await start();
      await collectGarbage();
      assertReleased({ ...refs, native: stats.native });
      assert.equal(stats.closed, 1);
      assert.equal(stats.released, readerMode ? 1 : 0);
      assert.equal(stats.disposed, 1);
      // The externally retained source promise still rejects later; it is observed.
      pending.reject(new Error('late read failure'));
      await turn();
    }
  },
);

test(
  'hung source cleanup cannot retain a source whose reader lock was released',
  gcRequired,
  async () => {
    for (const readerMode of [false, true]) {
      const cleanup = deferred();
      const stats = { disposed: 0, closed: 0, released: 0 };
      const hashStream = fixture(stats);
      async function start() {
        const { source, refs } = sourceFixture(
          Promise.resolve({ done: false, value: [] }),
          cleanup.promise,
          readerMode,
          stats,
        );
        await assert.rejects(hashStream(source), TypeError);
        return refs;
      }
      const refs = await start();
      await collectGarbage();
      assertReleased({ ...refs, native: stats.native });
      assert.equal(stats.closed, 1);
      assert.equal(stats.released, readerMode ? 1 : 0);
      assert.equal(stats.disposed, 1);
      cleanup.reject(new Error('late cleanup failure'));
      await turn();
    }
  },
);

test(
  'only a reader still needing release stays alive until its pending read settles',
  gcRequired,
  async () => {
    const pending = deferred();
    const cleanup = deferred();
    const stats = { disposed: 0, closed: 0, released: 0, cannotRelease: true };
    const hashStream = fixture(stats);
    async function start() {
      const controller = new AbortController();
      const reason = { payload: new ArrayBuffer(1024 * 1024) };
      const { source, refs } = sourceFixture(pending.promise, cleanup.promise, true, stats);
      refs.signal = new WeakRef(controller.signal);
      refs.reason = new WeakRef(reason);
      const result = hashStream(source, { signal: controller.signal });
      controller.abort(reason);
      await assert.rejects(result, { name: 'AbortError' });
      return refs;
    }
    const refs = await start();
    await collectGarbage();
    assertReleased({ signal: refs.signal, reason: refs.reason, native: stats.native });
    assert.notEqual(refs.owner.deref(), undefined, 'Keep the owner required for release retry');
    assert.equal(stats.released, 1);
    stats.cannotRelease = false;
    pending.resolve({ done: false, value: 'late chunk' });
    await collectGarbage();
    assert.equal(stats.released, 2);
    assertReleased({ ...refs, native: stats.native });
    cleanup.reject(new Error('late cancellation failure'));
    await turn();
  },
);
