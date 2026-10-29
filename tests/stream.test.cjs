const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { ReadableStream } = require('node:stream/web');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((fulfill, fail) => {
    resolve = fulfill;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture({ failCreate, failUpdate, failDigest, failDispose } = {}) {
  const events = [];
  const states = [];
  const cache = new Map();
  const native = {
    createHasher(algorithm, seed) {
      events.push('create:state');
      if (failCreate) throw failCreate;
      const state = {
        algorithm,
        seed,
        chunks: [],
        digests: 0,
        disposed: 0,
        updateString(value) {
          if (failUpdate) throw failUpdate;
          this.chunks.push(value);
          events.push('update');
        },
        updateBuffer(buffer, byteOffset, byteLength) {
          if (failUpdate) throw failUpdate;
          this.chunks.push({
            buffer,
            byteOffset,
            byteLength,
            bytes: Array.from(new Uint8Array(buffer, byteOffset, byteLength)),
          });
          events.push('update');
        },
        digest() {
          this.digests += 1;
          events.push('digest');
          if (failDigest) throw failDigest;
          if (algorithm === 'xxh32') return '0123abcd';
          if (algorithm === 'xxh3-128') return '0123456789abcdef1023456789abcdef';
          return '0123456789abcdef';
        },
        dispose() {
          this.disposed += 1;
          events.push('dispose');
          if (failDispose) throw failDispose;
        },
      };
      states.push(state);
      return state;
    },
  };
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    const requireLocal = (request) => {
      if (request === 'react-native-nitro-modules') {
        events.push('import:nitro');
        return {
          NitroModules: {
            createHybridObject(name) {
              events.push(`create:${name}`);
              return native;
            },
          },
        };
      }
      if (request.endsWith('/NativeXXHashLoader')) {
        return { default: () => events.push('load') };
      }
      if (!request.startsWith('.')) throw new Error(`Unexpected production dependency: ${request}`);
      return load(path.resolve(path.dirname(filename), `${request}.js`));
    };
    const factory = vm.runInThisContext(
      `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
      { filename },
    );
    factory(requireLocal, module, module.exports);
    return module.exports;
  }
  const compiled = process.env.NITRO_XXHASH_TEST_LIB || path.resolve(__dirname, '../lib');
  const hashStream = load(path.join(compiled, 'src/hashStreamInput.js')).default;
  return { hashStream, events, states };
}

function signalFixture() {
  const controller = new AbortController();
  let additions = 0;
  let removals = 0;
  const signal = {
    get aborted() {
      return controller.signal.aborted;
    },
    get reason() {
      return controller.signal.reason;
    },
    addEventListener(...args) {
      additions += 1;
      controller.signal.addEventListener(...args);
    },
    removeEventListener(...args) {
      removals += 1;
      controller.signal.removeEventListener(...args);
    },
  };
  return {
    controller,
    signal,
    get counts() {
      return { additions, removals };
    },
  };
}

function iterable(iterator) {
  return { [Symbol.asyncIterator]: () => iterator };
}

async function promptly(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Operation waited for hung source cleanup')),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const turn = () => new Promise((resolve) => setImmediate(resolve));

test('default async iteration consumes exact ranges in order without prefetching', async () => {
  const { hashStream, states, events } = fixture();
  const signal = signalFixture();
  const backing = new Uint8Array([255, 1, 2, 3, 255]);
  const chunks = ['hello', backing.subarray(1, 3), new DataView(backing.buffer, 3, 1)];
  let next = 0;
  let returned = 0;
  const source = iterable({
    next() {
      assert.equal(states[0].chunks.length, next, 'Each chunk is consumed before the next read');
      return Promise.resolve(
        next < chunks.length ? { value: chunks[next++], done: false } : { done: true },
      );
    },
    return() {
      returned += 1;
    },
  });
  assert.deepEqual(events, [], 'Importing the helper stays lazy');
  assert.equal(
    await hashStream(source, { signal: signal.signal }),
    '0123456789abcdef1023456789abcdef',
  );
  assert.equal(states[0].algorithm, 'xxh3-128');
  assert.equal(states[0].seed, '0');
  assert.equal(states[0].chunks[0], 'hello');
  assert.deepEqual(states[0].chunks.slice(1), [
    { buffer: backing.buffer, byteOffset: 1, byteLength: 2, bytes: [1, 2] },
    { buffer: backing.buffer, byteOffset: 3, byteLength: 1, bytes: [3] },
  ]);
  assert.equal(returned, 0, 'Completed iterators are not closed a second time');
  assert.equal(states[0].digests, 1);
  assert.equal(states[0].disposed, 1);
  assert.deepEqual(signal.counts, { additions: 1, removals: 1 });
});

test('all algorithms and output formats preserve the requested seed and canonical digest', async () => {
  for (const [algorithm, hex] of [
    ['xxh32', '0123abcd'],
    ['xxh64', '0123456789abcdef'],
    ['xxh3-64', '0123456789abcdef'],
    ['xxh3-128', '0123456789abcdef1023456789abcdef'],
  ]) {
    for (const output of ['hex', 'bytes', 'bigint']) {
      const { hashStream, states } = fixture();
      const result = await hashStream(iterable({ next: async () => ({ done: true }) }), {
        algorithm,
        output,
        seed: 42n,
      });
      const expected =
        output === 'hex'
          ? hex
          : output === 'bigint'
            ? BigInt(`0x${hex}`)
            : Uint8Array.from(Buffer.from(hex, 'hex'));
      assert.deepEqual(result, expected);
      assert.equal(states[0].seed, '42');
      assert.equal(states[0].disposed, 1);
    }
  }
});

test('a ReadableStream uses getReader even when an async-iterator hook exists', async () => {
  const { hashStream, states } = fixture();
  let cancelled = 0;
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue('one');
      controller.enqueue(new Uint8Array([2, 3]));
      controller.close();
    },
    cancel() {
      cancelled += 1;
    },
  });
  Object.defineProperty(source, Symbol.asyncIterator, {
    get() {
      return assert.fail('ReadableStream must prefer its reader protocol');
    },
  });
  await hashStream(source);
  assert.equal(source.locked, false);
  assert.equal(cancelled, 0);
  assert.equal(states[0].chunks.length, 2);
  assert.equal(states[0].disposed, 1);
});

test('pre-aborted input never acquires a source or creates Nitro state', async () => {
  const { hashStream, events } = fixture();
  const signal = signalFixture();
  const reason = new Error('stop before acquisition');
  signal.controller.abort(reason);
  const source = {
    get getReader() {
      return assert.fail('Pre-aborted input must not inspect getReader');
    },
    get [Symbol.asyncIterator]() {
      return assert.fail('Pre-aborted input must not inspect an iterator');
    },
  };
  await assert.rejects(hashStream(source, { signal: signal.signal }), (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.cause, reason);
    return true;
  });
  assert.deepEqual(events, []);
  assert.deepEqual(signal.counts, { additions: 0, removals: 0 });
});

test('invalid source/options reject before native initialization', async () => {
  const { hashStream, events } = fixture();
  for (const source of [null, undefined, 1, 'text', {}, [], { getReader: 123 }]) {
    await assert.rejects(hashStream(source), TypeError);
  }
  const source = {
    get getReader() {
      return assert.fail('Invalid options must not acquire the source');
    },
  };
  for (const options of [
    null,
    1,
    [],
    { algorithm: 'unknown' },
    { algorithm: null },
    { seed: -1 },
    { output: 'number' },
    { signal: {} },
    { unknown: true },
  ]) {
    await assert.rejects(hashStream(source, options));
  }
  assert.deepEqual(events, []);
});

test('abort while iterator.next is pending closes without waiting or consuming late chunks', async () => {
  const { hashStream, states } = fixture();
  const signal = signalFixture();
  const pending = deferred();
  let returned = 0;
  const source = iterable({
    next: () => pending.promise,
    return() {
      returned += 1;
      return new Promise(() => {});
    },
  });
  const result = hashStream(source, { signal: signal.signal });
  signal.controller.abort('stop');
  await assert.rejects(promptly(result), { name: 'AbortError', cause: 'stop' });
  assert.equal(returned, 1);
  assert.equal(states[0].disposed, 1);
  assert.equal(states[0].digests, 0);
  pending.resolve({ done: false, value: 'late' });
  await turn();
  assert.deepEqual(states[0].chunks, []);
  assert.deepEqual(signal.counts, { additions: 1, removals: 1 });
});

test('late next/cancel rejections remain observed after public cancellation', async () => {
  const { hashStream, states } = fixture();
  const signal = signalFixture();
  const read = deferred();
  const cancel = deferred();
  const release = deferred();
  let releases = 0;
  const source = {
    getReader: () => ({
      read: () => read.promise,
      cancel: () => cancel.promise,
      releaseLock: () => {
        releases += 1;
        return release.promise;
      },
    }),
  };
  const result = hashStream(source, { signal: signal.signal });
  signal.controller.abort();
  await assert.rejects(promptly(result), { name: 'AbortError' });
  read.reject(new Error('late read rejection'));
  cancel.reject(new Error('late cancellation rejection'));
  release.reject(new Error('late lock-release rejection'));
  await turn();
  assert.equal(releases, 1);
  assert.equal(states[0].disposed, 1);
  assert.equal(states[0].chunks.length, 0);
});

test('an actual pending ReadableStream is cancelled and unlocked on abort', async () => {
  const { hashStream, states } = fixture();
  const controller = new AbortController();
  let cancelled = 0;
  const source = new ReadableStream({
    cancel() {
      cancelled += 1;
    },
  });
  const pending = hashStream(source, { signal: controller.signal });
  assert.equal(source.locked, true);
  controller.abort();
  await assert.rejects(promptly(pending), { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.equal(source.locked, false);
  assert.equal(states[0].disposed, 1);
});

test('invalid chunks cancel/return sources and keep the input failure over cleanup errors', async () => {
  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture({ failDispose: new Error('dispose failed') });
    let closed = 0;
    let released = 0;
    const close = () => {
      closed += 1;
      throw new Error('cleanup failed');
    };
    const next = () => Promise.resolve({ done: false, value: [1, 2, 3] });
    const source = readerMode
      ? {
          getReader: () => ({
            read: next,
            cancel: close,
            releaseLock() {
              released += 1;
              throw new Error('release failed');
            },
          }),
        }
      : iterable({ next, return: close });
    await assert.rejects(hashStream(source), TypeError);
    assert.equal(closed, 1);
    assert.equal(released, readerMode ? 1 : 0);
    assert.equal(states[0].disposed, 1);
    assert.equal(states[0].digests, 0);
  }
});

test('read and native failures preserve their primary reason and release all ownership', async () => {
  const errors = [
    new Error('read failed'),
    new Error('native update failed'),
    new Error('digest failed'),
  ];
  for (let index = 0; index < errors.length; index += 1) {
    const reason = errors[index];
    const { hashStream, states } = fixture({
      failUpdate: index === 1 ? reason : undefined,
      failDigest: index === 2 ? reason : undefined,
      failDispose: new Error('dispose cleanup failed'),
    });
    let closed = 0;
    let calls = 0;
    const source = iterable({
      next() {
        if (index === 0) return Promise.reject(reason);
        return Promise.resolve(calls++ === 0 ? { value: 'chunk', done: false } : { done: true });
      },
      return() {
        closed += 1;
        return Promise.reject(new Error('return cleanup failed'));
      },
    });
    await assert.rejects(hashStream(source), (error) => error === reason);
    assert.equal(closed, index === 2 ? 0 : 1);
    assert.equal(states[0].disposed, 1);
  }
  await turn();
});

test('invalid reader/iterator methods close acquired sources before native creation', async () => {
  for (const missing of ['read', 'cancel', 'releaseLock']) {
    const { hashStream, events } = fixture();
    let closed = 0;
    let released = 0;
    const reader = {
      read: async () => ({ done: true }),
      cancel() {
        closed += 1;
      },
      releaseLock() {
        released += 1;
      },
    };
    delete reader[missing];
    await assert.rejects(hashStream({ getReader: () => reader }), TypeError);
    assert.equal(closed, missing === 'cancel' ? 0 : 1);
    assert.equal(released, missing === 'releaseLock' ? 0 : 1);
    assert.deepEqual(events, []);
  }
  const { hashStream, events } = fixture();
  let returned = 0;
  await assert.rejects(
    hashStream(
      iterable({
        return() {
          returned += 1;
        },
      }),
    ),
    TypeError,
  );
  assert.equal(returned, 1);
  assert.deepEqual(events, []);
});

test('abort inside source acquisition or a result getter cannot hash a chunk afterward', async () => {
  for (const duringAcquisition of [true, false]) {
    const { hashStream, events, states } = fixture();
    const controller = new AbortController();
    let returned = 0;
    const iterator = {
      next: async () => ({
        done: false,
        get value() {
          controller.abort();
          return 'late';
        },
      }),
      return() {
        returned += 1;
      },
    };
    const source = {
      [Symbol.asyncIterator]() {
        if (duringAcquisition) controller.abort();
        return iterator;
      },
    };
    await assert.rejects(hashStream(source, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(returned, 1);
    if (duringAcquisition) assert.deepEqual(events, []);
    else {
      assert.deepEqual(states[0].chunks, []);
      assert.equal(states[0].digests, 0);
      assert.equal(states[0].disposed, 1);
    }
  }
});

test('native state creation failure cancels and unlocks an already acquired reader', async () => {
  const reason = new Error('native creation failed');
  const { hashStream, events } = fixture({ failCreate: reason });
  const signal = signalFixture();
  let cancelled = 0;
  let released = 0;
  await assert.rejects(
    hashStream(
      {
        getReader: () => ({
          read: async () => ({ done: true }),
          cancel() {
            cancelled += 1;
          },
          releaseLock() {
            released += 1;
          },
        }),
      },
      { signal: signal.signal },
    ),
    (error) => error === reason,
  );
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  assert.equal(events.filter((event) => event === 'create:state').length, 1);
  assert.deepEqual(signal.counts, { additions: 1, removals: 1 });
});

test('many chunks keep one signal listener and consume each chunk before requesting another', async () => {
  const { hashStream, states } = fixture();
  const signal = signalFixture();
  let position = 0;
  const count = 2048;
  const source = iterable({
    next() {
      assert.equal(states[0].chunks.length, position);
      return Promise.resolve(position++ < count ? { done: false, value: '' } : { done: true });
    },
  });
  await hashStream(source, { signal: signal.signal });
  assert.equal(states[0].chunks.length, count);
  assert.deepEqual(signal.counts, { additions: 1, removals: 1 });
  assert.equal(states[0].disposed, 1);
});

test('callable iterator-result objects follow the standard object protocol', async () => {
  const { hashStream, states } = fixture();
  let calls = 0;
  const value = Object.assign(function result() {}, { done: false, value: 'chunk' });
  await hashStream(iterable({ next: async () => (calls++ === 0 ? value : { done: true }) }));
  assert.deepEqual(states[0].chunks, ['chunk']);
  assert.equal(states[0].disposed, 1);
});

test('reader lock release retries after a pending read settles without delaying abort', async () => {
  const { hashStream, states } = fixture();
  const controller = new AbortController();
  const pending = deferred();
  let settled = false;
  let releases = 0;
  let cancelled = 0;
  const source = {
    getReader: () => ({
      read: () => pending.promise,
      cancel() {
        cancelled += 1;
        return new Promise(() => {});
      },
      releaseLock() {
        releases += 1;
        if (!settled) throw new Error('Read is still pending');
      },
    }),
  };
  const result = hashStream(source, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promptly(result), { name: 'AbortError' });
  assert.equal(cancelled, 1);
  assert.equal(releases, 1);
  assert.equal(states[0].disposed, 1);
  await turn();
  assert.equal(releases, 1, 'abort does not settle the underlying pending read');
  settled = true;
  pending.resolve({ done: false, value: 'late' });
  await turn();
  assert.equal(releases, 2);
  assert.deepEqual(states[0].chunks, []);
});

test('a no-signal read failure still retries lock release after asynchronous cancellation', async () => {
  const { hashStream, states } = fixture();
  const cleanup = deferred();
  let canRelease = false;
  let cancelled = 0;
  let releases = 0;
  const source = {
    getReader: () => ({
      read: async () => ({ done: false, value: [] }),
      cancel() {
        cancelled += 1;
        return cleanup.promise;
      },
      releaseLock() {
        releases += 1;
        if (!canRelease) throw new Error('Cancellation is still pending');
      },
    }),
  };
  await assert.rejects(promptly(hashStream(source)), TypeError);
  assert.equal(cancelled, 1);
  assert.equal(releases, 1);
  assert.equal(states[0].disposed, 1);
  canRelease = true;
  cleanup.resolve();
  await turn();
  assert.equal(releases, 2);
  assert.deepEqual(states[0].chunks, []);
});

test('reusing and mutating one source view cannot change already consumed chunks', async () => {
  const { hashStream, states } = fixture();
  const bytes = new Uint8Array([255, 1, 2, 255]);
  const view = bytes.subarray(1, 3);
  let calls = 0;
  const source = iterable({
    async next() {
      if (calls === 1) view[0] = 3;
      return calls++ < 2 ? { done: false, value: view } : { done: true };
    },
  });
  await hashStream(source);
  assert.equal(states[0].chunks[0].buffer, bytes.buffer);
  assert.equal(states[0].chunks[1].buffer, bytes.buffer);
  assert.deepEqual(
    states[0].chunks.map((chunk) => chunk.bytes),
    [
      [1, 2],
      [3, 2],
    ],
  );
  assert.equal(states[0].disposed, 1);
});

test('async iterator next is acquired once, matching the standard iterator record', async () => {
  function sourceFixture() {
    let reads = 0;
    let calls = 0;
    const iterator = {
      get next() {
        reads += 1;
        if (reads !== 1) throw new Error('next method was acquired more than once');
        return async function next() {
          assert.equal(this, iterator);
          return calls++ < 2 ? { done: false, value: 'chunk' } : { done: true };
        };
      },
    };
    return { source: iterable(iterator), reads: () => reads };
  }
  const standard = sourceFixture();
  const chunks = [];
  for await (const chunk of standard.source) chunks.push(chunk);
  assert.deepEqual(chunks, ['chunk', 'chunk']);
  assert.equal(standard.reads(), 1);

  const { hashStream, states } = fixture();
  const candidate = sourceFixture();
  await hashStream(candidate.source);
  assert.equal(candidate.reads(), 1);
  assert.deepEqual(states[0].chunks, chunks);
  assert.equal(states[0].disposed, 1);
});

test('source protocol invocation ignores methods own call properties', async () => {
  function method(body) {
    Object.defineProperty(body, 'call', {
      value() {
        assert.fail('Protocol methods must use their internal call behavior');
      },
    });
    return body;
  }
  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture();
    let closed = 0;
    let released = 0;
    const next = method(async function next() {
      return { done: false, value: [1, 2, 3] };
    });
    const close = method(function close() {
      closed += 1;
    });
    let source;
    if (readerMode) {
      const reader = {
        read: next,
        cancel: close,
        releaseLock: method(function releaseLock() {
          assert.equal(this, reader);
          released += 1;
        }),
      };
      source = {
        getReader: method(function getReader() {
          assert.equal(this, source);
          return reader;
        }),
      };
    } else {
      const iterator = { next, return: close };
      source = {
        [Symbol.asyncIterator]: method(function getIterator() {
          assert.equal(this, source);
          return iterator;
        }),
      };
    }
    await assert.rejects(hashStream(source), TypeError);
    assert.equal(closed, 1);
    assert.equal(released, readerMode ? 1 : 0);
    assert.equal(states[0].disposed, 1);
  }
});

test('source promises are awaited without reading their overridden then properties', async () => {
  function nativePromise(value) {
    const result = Promise.resolve(value);
    Object.defineProperty(result, 'then', {
      get() {
        throw new Error('Awaiting a native promise must not inspect its own then property');
      },
    });
    return result;
  }
  const expected = { done: false, value: 'chunk' };
  assert.equal(await nativePromise(expected), expected, 'The source promise is valid for await');
  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture();
    let reads = 0;
    const next = () => nativePromise(reads++ === 0 ? expected : { done: true });
    const source = readerMode
      ? { getReader: () => ({ read: next, cancel() {}, releaseLock() {} }) }
      : iterable({ next });
    await hashStream(source);
    assert.deepEqual(states[0].chunks, ['chunk']);
    assert.equal(states[0].disposed, 1);
  }
});

test('cancelled sources and cleanup promises keep late rejections observed despite own then overrides', async () => {
  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture();
    const controller = new AbortController();
    const pending = deferred();
    const cleanup = deferred();
    for (const promise of [pending.promise, cleanup.promise]) {
      Object.defineProperty(promise, 'then', {
        get() {
          throw new Error('Native promise observation must ignore an own then property');
        },
      });
    }
    let closed = 0;
    const close = () => {
      closed += 1;
      return cleanup.promise;
    };
    const next = () => pending.promise;
    const source = readerMode
      ? { getReader: () => ({ read: next, cancel: close, releaseLock() {} }) }
      : iterable({ next, return: close });
    const result = hashStream(source, { signal: controller.signal });
    controller.abort();
    await assert.rejects(promptly(result), { name: 'AbortError' });
    assert.equal(closed, 1);
    assert.equal(states[0].disposed, 1);
    pending.reject(new Error('late source rejection'));
    cleanup.reject(new Error('late cleanup rejection'));
    await turn();
    assert.deepEqual(states[0].chunks, []);
  }
});

test('already fulfilled iterator results are not re-assimilated through their later then properties', async () => {
  function sourceFixture() {
    let thenReads = 0;
    let calls = 0;
    const results = [{ done: false, value: 'chunk' }, { done: true }].map((step) => {
      const promise = Promise.resolve(step);
      Object.defineProperty(step, 'then', {
        get() {
          thenReads += 1;
          throw new Error('An already fulfilled iterator result was re-assimilated');
        },
      });
      return promise;
    });
    return { next: () => results[calls++], thenReads: () => thenReads };
  }
  const standard = sourceFixture();
  const chunks = [];
  for await (const chunk of iterable({ next: standard.next })) chunks.push(chunk);
  assert.deepEqual(chunks, ['chunk']);
  assert.equal(standard.thenReads(), 0);

  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture();
    const candidate = sourceFixture();
    let closed = 0;
    let released = 0;
    const close = () => {
      closed += 1;
    };
    const source = readerMode
      ? {
          getReader: () => ({
            read: candidate.next,
            cancel: close,
            releaseLock() {
              released += 1;
            },
          }),
        }
      : iterable({ next: candidate.next, return: close });
    await hashStream(source);
    assert.equal(candidate.thenReads(), 0);
    assert.deepEqual(states[0].chunks, chunks);
    assert.equal(closed, 0);
    assert.equal(released, readerMode ? 1 : 0);
    assert.equal(states[0].disposed, 1);
  }
});

test('faulty source and cleanup thenables reject promptly while preserving ownership cleanup', async () => {
  const marker = new Error('thenable observation failed');
  const rejected = () =>
    Object.defineProperty({}, 'then', {
      get() {
        throw marker;
      },
    });
  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture();
    let closed = 0;
    let released = 0;
    const close = () => {
      closed += 1;
      return rejected();
    };
    const source = readerMode
      ? {
          getReader: () => ({
            read: rejected,
            cancel: close,
            releaseLock() {
              released += 1;
            },
          }),
        }
      : iterable({ next: rejected, return: close });
    await assert.rejects(promptly(hashStream(source)), (error) => error === marker);
    await turn();
    assert.equal(closed, 1);
    assert.equal(released, readerMode ? 1 : 0);
    assert.equal(states[0].disposed, 1);
    assert.deepEqual(states[0].chunks, []);
  }
});

test('a cold reader thenable is observed once and hashes its first result', async () => {
  const { hashStream, states } = fixture();
  let reads = 0;
  let observations = 0;
  let released = 0;
  const source = {
    getReader: () => ({
      read() {
        const done = ++reads > 1;
        return {
          then(fulfill, reject) {
            const value = `chunk-${++observations}`;
            return Promise.resolve({ done, value }).then(fulfill, reject);
          },
        };
      },
      cancel() {
        assert.fail('successful readers must not be cancelled');
      },
      releaseLock() {
        released += 1;
      },
    }),
  };
  await hashStream(source);
  assert.equal(reads, 2);
  assert.equal(observations, 2);
  assert.deepEqual(states[0].chunks, ['chunk-1']);
  assert.equal(released, 1);
  assert.equal(states[0].disposed, 1);
});

test('post-EOF digest failures do not close an already completed source again', async () => {
  const reason = new Error('digest failed after EOF');
  let standardClosed = 0;
  const standard = iterable({
    next: async () => ({ done: true }),
    return() {
      standardClosed += 1;
    },
  });
  await assert.rejects(
    async () => {
      for await (const chunk of standard) void chunk;
      throw reason;
    },
    (error) => error === reason,
  );
  assert.equal(standardClosed, 0);

  for (const readerMode of [false, true]) {
    const { hashStream, states } = fixture({ failDigest: reason });
    let closed = 0;
    let released = 0;
    const next = async () => ({ done: true });
    const close = () => {
      closed += 1;
    };
    const source = readerMode
      ? {
          getReader: () => ({
            read: next,
            cancel: close,
            releaseLock() {
              released += 1;
            },
          }),
        }
      : iterable({ next, return: close });
    await assert.rejects(hashStream(source), (error) => error === reason);
    assert.equal(closed, 0, 'EOF already ended source ownership before digest failed');
    assert.equal(released, readerMode ? 1 : 0);
    assert.equal(states[0].disposed, 1);
  }
});

test('abort in the done getter closes only sources whose EOF was not observed', async () => {
  for (const readerMode of [false, true]) {
    for (const outcome of ['done', 'pending', 'throw']) {
      const { hashStream, states } = fixture();
      const controller = new AbortController();
      const reason = new Error('abort inside done');
      const getterError = new Error('done getter failed before reporting EOF');
      let closed = 0;
      let released = 0;
      const result = {
        get done() {
          controller.abort(reason);
          if (outcome === 'throw') throw getterError;
          return outcome === 'done';
        },
        get value() {
          return assert.fail('An aborting done getter must prevent chunk access');
        },
      };
      const next = async () => result;
      const close = () => {
        closed += 1;
      };
      const source = readerMode
        ? {
            getReader: () => ({
              read: next,
              cancel: close,
              releaseLock() {
                released += 1;
              },
            }),
          }
        : iterable({ next, return: close });
      await assert.rejects(hashStream(source, { signal: controller.signal }), (error) => {
        if (outcome === 'throw') return error === getterError;
        return error.name === 'AbortError' && error.cause === reason;
      });
      assert.equal(closed, outcome === 'done' ? 0 : 1);
      assert.equal(released, readerMode ? 1 : 0);
      assert.deepEqual(states[0].chunks, []);
      assert.equal(states[0].digests, 0);
      assert.equal(states[0].disposed, 1);
    }
  }
});
