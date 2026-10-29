const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Evaluate the compiled consumer entry with isolated module state and a fake native
// boundary. Real algorithm vectors are checked independently by the C++ suite.
function fixture({
  failLoad = 0,
  failCreate = 0,
  failures = {},
  hashResults = {},
  taskFactory,
} = {}) {
  const events = [];
  const calls = [];
  const reads = {};
  const states = [];
  const tasks = [];
  const native = {};
  function makeState(seed, algorithm, chunks = []) {
    const state = {
      chunks,
      seed,
      disposed: 0,
      resets: [],
      updateString(input) {
        this.chunks.push(input);
      },
      updateBuffer(buffer, byteOffset, byteLength) {
        this.chunks.push({ buffer, byteOffset, byteLength });
      },
      digest() {
        return hashResults[algorithm] ?? `digest:${this.chunks.length}:${this.seed}`;
      },
      reset(seed) {
        this.resets.push(seed);
        this.seed = seed;
        this.chunks = [];
      },
      clone() {
        return makeState(this.seed, algorithm, this.chunks.slice());
      },
      dispose() {
        this.disposed += 1;
      },
    };
    states.push(state);
    return state;
  }
  for (const name of ['hashString', 'hashBuffer', 'hashFile', 'createHasher', 'startFileHash']) {
    Object.defineProperty(native, name, {
      configurable: true,
      get() {
        reads[name] = (reads[name] || 0) + 1;
        return function (...args) {
          assert.equal(this, native);
          calls.push({ name, args });
          if (failures[name] > 0) {
            failures[name] -= 1;
            throw new Error('native call failed');
          }
          if (name === 'createHasher') {
            return makeState(args[1], args[0]);
          }
          if (name === 'startFileHash') {
            const task = taskFactory?.(args) ?? {
              cancelled: 0,
              result() {
                return Promise.resolve(hashResults[args[1]] ?? name);
              },
              cancel() {
                this.cancelled += 1;
              },
            };
            tasks.push(task);
            return task;
          }
          const result = hashResults[name === 'hashBuffer' ? args[3] : args[1]] ?? name;
          if (name === 'hashFile') return Promise.resolve(result);
          return result;
        };
      },
    });
  }
  const cache = new Map();
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} };
    cache.set(filename, module);
    function requireLocal(request) {
      if (request === 'react-native-nitro-modules') {
        events.push('import:nitro');
        return {
          NitroModules: {
            createHybridObject(tag) {
              events.push(`create:${tag}`);
              if (failCreate-- > 0) throw new Error('factory unavailable');
              return native;
            },
          },
        };
      }
      if (request.endsWith('/NativeNitroFileHashLoader')) {
        events.push('import:loader');
        return {
          default() {
            events.push('load');
            if (failLoad-- > 0) throw new Error('loader unavailable');
          },
        };
      }
      if (!request.startsWith('.')) throw new Error(`Unexpected dependency: ${request}`);
      return load(path.resolve(path.dirname(filename), `${request}.js`));
    }
    const factory = vm.runInThisContext(
      `(function(require,module,exports){${fs.readFileSync(filename, 'utf8')}\n})`,
      { filename },
    );
    factory(requireLocal, module, module.exports);
    return module.exports;
  }
  const compiled = process.env.NITRO_XXHASH_TEST_LIB || path.resolve(__dirname, '../lib');
  const api = load(path.join(compiled, 'index.js'));
  return { api, events, calls, reads, states, tasks, native };
}

const variants = [
  ['xxh32', 'xxh32File', 'xxh32', 0xffffffffn],
  ['xxh64', 'xxh64File', 'xxh64', 0xffffffffffffffffn],
  ['xxh3_64', 'xxh3_64File', 'xxh3-64', 0xffffffffffffffffn],
  ['xxh3_128', 'xxh3_128File', 'xxh3-128', 0xffffffffffffffffn],
];
const hashNames = variants.map(([name]) => name);

function byteViews(buffer) {
  const names = [
    'Int8Array',
    'Uint8Array',
    'Uint8ClampedArray',
    'Int16Array',
    'Uint16Array',
    'Int32Array',
    'Uint32Array',
    'Float16Array',
    'Float32Array',
    'Float64Array',
    'BigInt64Array',
    'BigUint64Array',
  ];
  const views = [];
  for (const name of names) {
    const Constructor = globalThis[name];
    if (typeof Constructor === 'function') {
      views.push([name, new Constructor(buffer, Constructor.BYTES_PER_ELEMENT * 2, 3)]);
    }
  }
  views.push(
    ['DataView', new DataView(buffer, 3, 9)],
    ['subarray', new Uint8Array(buffer, 7, 11).subarray(2, 8)],
    ['empty typed view', new Uint16Array(buffer, 4, 0)],
    ['empty DataView', new DataView(buffer, buffer.byteLength, 0)],
  );
  return views;
}

function assertByteCall(call, name, buffer, byteOffset, byteLength) {
  const algorithm = variants.find(([hash]) => hash === name)[2];
  assert.equal(call.name, 'hashBuffer');
  assert.equal(call.args[0], buffer, `${name} must borrow the original backing buffer`);
  assert.deepEqual(call.args, [buffer, byteOffset, byteLength, algorithm, '0']);
}

test('compiled package exports stay lazy and share one native object', () => {
  const { api, events, reads } = fixture();
  assert.deepEqual(
    Object.keys(api).sort(),
    ['createHasher', 'hashStream', ...variants.flatMap(([hash, file]) => [hash, file])].sort(),
  );
  for (const name of ['hash64', 'hash128', 'hashFile64', 'hashFile128']) {
    assert.equal(api[name], undefined, `${name} must not be a public export`);
  }
  assert.deepEqual(events, []);
  api.xxh3_64('one');
  api.xxh3_64('two');
  api.xxh32('three');
  api.xxh32('four');
  assert.deepEqual(events, ['import:nitro', 'import:loader', 'load', 'create:FileHasher']);
  assert.deepEqual(reads, { hashString: 2 });
});

test('algorithm functions distinguish URI text from explicit file hashing', async () => {
  const { api, calls } = fixture();
  const bytes = new ArrayBuffer(3);
  for (const [hash, file, algorithm] of variants) {
    assert.equal(api[hash]('file:///text'), 'hashString');
    assert.equal(api[hash](bytes), 'hashBuffer');
    assert.equal(await api[file]('/one'), 'hashFile');
    assert.deepEqual(calls.slice(-3), [
      { name: 'hashString', args: ['file:///text', algorithm, '0'] },
      { name: 'hashBuffer', args: [bytes, 0, 3, algorithm, '0'] },
      { name: 'hashFile', args: ['/one', algorithm, '0'] },
    ]);
  }
});

for (const [hash, file, algorithm, maximum] of variants) {
  test(`${hash} preserves exact algorithm, bytes and unsigned seeds`, async () => {
    const { api, calls } = fixture();
    const bytes = new Uint8Array([0, 1, 255]).buffer;
    api[hash]('hello');
    api[hash](bytes, maximum);
    api[hash]('seeded', 42);
    await api[file]('/a file', maximum);
    assert.deepEqual(calls, [
      { name: 'hashString', args: ['hello', algorithm, '0'] },
      { name: 'hashBuffer', args: [bytes, 0, 3, algorithm, maximum.toString()] },
      { name: 'hashString', args: ['seeded', algorithm, '42'] },
      { name: 'hashFile', args: ['/a file', algorithm, maximum.toString()] },
    ]);
  });

  test(`${hash} rejects invalid seeds before native loading`, async () => {
    const { api, events } = fixture();
    for (const seed of [-1, -1n, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, maximum + 1n]) {
      assert.throws(() => api[hash]('hello', seed), RangeError);
      await assert.rejects(api[file]('/file', seed), RangeError);
      assert.throws(() => api.createHasher(algorithm, seed), RangeError);
    }
    for (const seed of [null, '1', true]) {
      assert.throws(() => api[hash]('hello', seed), TypeError);
      await assert.rejects(api[file]('/file', seed), TypeError);
    }
    assert.deepEqual(events, []);
  });
}

test('invalid inputs and forged buffers never initialize native code', async () => {
  const { api, events } = fixture();
  const invalid = [
    null,
    undefined,
    1,
    true,
    {},
    [],
    new String('wrapped'),
    Object.create(ArrayBuffer.prototype),
    Object.create(Uint8Array.prototype),
    Object.create(DataView.prototype),
    new Proxy(new ArrayBuffer(4), {}),
    new Proxy(new Uint8Array(4), {}),
    new Proxy(new DataView(new ArrayBuffer(4)), {}),
    { byteLength: 4, [Symbol.toStringTag]: 'ArrayBuffer' },
    {
      buffer: new ArrayBuffer(4),
      byteOffset: 0,
      byteLength: 4,
      [Symbol.toStringTag]: 'Uint8Array',
    },
  ];
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new SharedArrayBuffer(4);
    invalid.push(shared, new Uint8Array(shared), new DataView(shared));
  }
  for (const input of invalid) {
    for (const name of hashNames) {
      assert.throws(() => api[name](input), TypeError);
    }
  }
  for (const [, file] of variants) await assert.rejects(api[file](null), TypeError);
  for (const algorithm of [undefined, null, 'xxh3', {}, 64]) {
    assert.throws(() => api.createHasher(algorithm), TypeError);
  }
  assert.deepEqual(events, []);
});

test('every file helper rejects invalid path types before loading or coercing inputs', async () => {
  const { api, events, calls } = fixture({ failLoad: 1 });
  let coercions = 0;
  const invalid = [
    undefined,
    null,
    123,
    true,
    [],
    new String('/wrapped'),
    {
      toString() {
        coercions += 1;
        throw new Error('File input must not be coerced');
      },
    },
  ];
  for (const [, name] of variants) {
    for (const input of invalid) {
      await assert.rejects(api[name](input), TypeError, `${name} rejects an invalid path type`);
    }
  }
  assert.equal(coercions, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(calls, []);
  // Rejected arguments must not consume the first real initialization attempt.
  await assert.rejects(api.xxh3_64File('/first'), /loader unavailable/);
  assert.equal(await api.xxh3_64File('/retry'), 'hashFile');
});

test('all ordinary functions borrow every byte-view range without copying or element conversion', () => {
  const { api, calls, reads, events } = fixture();
  const buffer = new ArrayBuffer(64);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 17) & 255;
  for (const [label, view] of byteViews(buffer)) {
    for (const name of hashNames) {
      api[name](view);
      const call = calls.at(-1);
      assertByteCall(call, name, buffer, view.byteOffset, view.byteLength);
      assert.deepEqual(
        Array.from(new Uint8Array(call.args[0], call.args[1], call.args[2])),
        Array.from(bytes.subarray(view.byteOffset, view.byteOffset + view.byteLength)),
        `${name}/${label} forwards raw bytes instead of numeric values`,
      );
    }
  }
  assert.deepEqual(reads, { hashBuffer: 4 });
  assert.deepEqual(events, ['import:nitro', 'import:loader', 'load', 'create:FileHasher']);
});

test('ordinary functions accept empty buffers and cross-realm byte views', () => {
  const { api, calls } = fixture();
  const empty = new ArrayBuffer(0);
  const foreign = vm.runInNewContext('new Uint8Array(new ArrayBuffer(16), 5, 6)');
  for (const name of hashNames) {
    api[name](empty);
    assertByteCall(calls.at(-1), name, empty, 0, 0);
    api[name](foreign);
    assertByteCall(calls.at(-1), name, foreign.buffer, 5, 6);
  }
});

test('pooled and sliced Buffer inputs use the Uint8Array contract without a Node dependency', () => {
  const { api, calls, states } = fixture();
  const pooled = Buffer.allocUnsafe(128).fill(0xed);
  const sliced = pooled.subarray(7, 19);
  assert.ok(
    pooled.buffer.byteLength > pooled.byteLength,
    'Fixture must exercise pooled backing storage',
  );
  for (const input of [pooled, sliced]) {
    for (const name of hashNames) {
      api[name](input);
      assertByteCall(calls.at(-1), name, input.buffer, input.byteOffset, input.byteLength);
    }
  }
  const stream = api.createHasher('xxh64');
  stream.update(sliced);
  assert.equal(states[0].chunks[0].buffer, pooled.buffer);
  assert.deepEqual(states[0].chunks[0], {
    buffer: pooled.buffer,
    byteOffset: sliced.byteOffset,
    byteLength: sliced.byteLength,
  });
  stream.dispose();
});

test('React Native Buffer polyfill inputs preserve their original backing ranges', () => {
  const { Buffer: PolyfillBuffer } = require('buffer/');
  const { api, calls, states } = fixture();
  const backing = new ArrayBuffer(64);
  const input = PolyfillBuffer.from(backing, 7, 23).subarray(3, 9);
  assert.equal(input.buffer, backing);
  assert.equal(input.byteOffset, 10);
  for (const name of hashNames) {
    api[name](input);
    assertByteCall(calls.at(-1), name, backing, 10, 6);
  }
  const stream = api.createHasher('xxh3-128');
  stream.update(input);
  assert.deepEqual(states[0].chunks, [{ buffer: backing, byteOffset: 10, byteLength: 6 }]);
  stream.dispose();
});

test('shadowed view and backing properties cannot invoke user getters or change hashed ranges', () => {
  const { api, calls, states } = fixture();
  const buffer = new ArrayBuffer(32);
  const inputs = [new Uint16Array(buffer, 4, 3), new DataView(buffer, 5, 7), buffer];
  const expected = [
    [4, 6],
    [5, 7],
    [0, 32],
  ];
  let getterCalls = 0;
  for (const input of inputs) {
    for (const property of [
      'buffer',
      'byteOffset',
      'byteLength',
      'length',
      'constructor',
      Symbol.toStringTag,
      Symbol.iterator,
    ]) {
      Object.defineProperty(input, property, {
        get() {
          getterCalls += 1;
          throw new Error('User getter must not run while borrowing input');
        },
      });
    }
  }
  const stream = api.createHasher('xxh32');
  for (let index = 0; index < inputs.length; index += 1) {
    for (const name of hashNames) {
      api[name](inputs[index]);
      assertByteCall(calls.at(-1), name, buffer, ...expected[index]);
    }
    stream.update(inputs[index]);
    const chunk = states[0].chunks.at(-1);
    assert.equal(chunk.buffer, buffer);
    assert.equal(chunk.byteOffset, expected[index][0]);
    assert.equal(chunk.byteLength, expected[index][1]);
  }
  assert.equal(getterCalls, 0);
  stream.dispose();
});

test('captured intrinsic accessors remain authoritative after prototype overrides', () => {
  const { api, calls, states } = fixture();
  const buffer = new ArrayBuffer(24);
  const typed = new Uint32Array(buffer, 4, 3);
  const data = new DataView(buffer, 3, 9);
  const stream = api.createHasher('xxh64');
  const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype);
  const properties = [
    [ArrayBuffer, 'isView'],
    [ArrayBuffer.prototype, 'byteLength'],
    [typedPrototype, 'values'],
    ...[typedPrototype, DataView.prototype].flatMap((prototype) =>
      ['buffer', 'byteOffset', 'byteLength'].map((name) => [prototype, name]),
    ),
  ];
  const originals = properties.map(([owner, name]) => Object.getOwnPropertyDescriptor(owner, name));
  function overridden() {
    throw new Error('Overridden intrinsic must not run');
  }
  try {
    properties.forEach(([owner, name], index) => {
      const descriptor = originals[index];
      Object.defineProperty(
        owner,
        name,
        descriptor.get ? { ...descriptor, get: overridden } : { ...descriptor, value: overridden },
      );
    });
    api.xxh3_64(typed);
    api.xxh64(data);
    stream.update(typed).update(data);
  } finally {
    properties.forEach(([owner, name], index) =>
      Object.defineProperty(owner, name, originals[index]),
    );
  }
  assertByteCall(calls[1], 'xxh3_64', buffer, 4, 12);
  assertByteCall(calls[2], 'xxh64', buffer, 3, 9);
  assert.deepEqual(states[0].chunks, [
    { buffer, byteOffset: 4, byteLength: 12 },
    { buffer, byteOffset: 3, byteLength: 9 },
  ]);
  stream.dispose();
});

test('invalid brands and proxies are rejected without reading their properties', () => {
  const { api, events } = fixture();
  let propertyReads = 0;
  const invalid = [
    new Proxy(new Uint8Array(8), {
      get() {
        propertyReads += 1;
        throw new Error('Proxy trap');
      },
    }),
    new Proxy(new DataView(new ArrayBuffer(8)), {
      get() {
        propertyReads += 1;
        throw new Error('Proxy trap');
      },
    }),
    Object.create(Uint8Array.prototype, {
      buffer: {
        get() {
          propertyReads += 1;
          throw new Error('Forged getter');
        },
      },
    }),
  ];
  for (const input of invalid) {
    for (const name of hashNames) assert.throws(() => api[name](input), TypeError);
  }
  assert.equal(propertyReads, 0);
  assert.deepEqual(events, []);
});

test(
  'detached buffers and views are rejected before native initialization',
  { skip: typeof structuredClone !== 'function' },
  () => {
    const { api, events } = fixture();
    const buffer = new ArrayBuffer(16);
    const inputs = [buffer, new Uint8Array(buffer, 2, 5), new DataView(buffer, 3, 7)];
    structuredClone(buffer, { transfer: [buffer] });
    for (const input of inputs) {
      for (const name of hashNames) assert.throws(() => api[name](input), TypeError);
    }
    assert.deepEqual(events, []);
  },
);

test(
  'out-of-bounds resizable views reject and recover when their range becomes valid again',
  {
    skip: typeof ArrayBuffer.prototype.resize !== 'function',
  },
  () => {
    const { api, calls, events, states } = fixture();
    const buffer = new ArrayBuffer(24, { maxByteLength: 48 });
    const typed = new Uint16Array(buffer, 8, 4);
    const data = new DataView(buffer, 10, 6);
    buffer.resize(4);
    for (const input of [typed, data]) {
      for (const name of hashNames) assert.throws(() => api[name](input), TypeError);
    }
    assert.deepEqual(events, []);
    // A genuinely empty in-bounds view is still valid, including at the buffer end.
    const empty = new Uint8Array(buffer, 4, 0);
    api.xxh3_64(empty);
    assertByteCall(calls.at(-1), 'xxh3_64', buffer, 4, 0);
    buffer.resize(32);
    for (const name of hashNames) {
      api[name](typed);
      assertByteCall(calls.at(-1), name, buffer, 8, 8);
      api[name](data);
      assertByteCall(calls.at(-1), name, buffer, 10, 6);
    }
    const tracking = new Uint8Array(buffer, 6);
    const stream = api.createHasher('xxh64').update(tracking);
    assert.deepEqual(states[0].chunks, [{ buffer, byteOffset: 6, byteLength: 26 }]);
    buffer.resize(4);
    for (const input of [typed, data, tracking])
      assert.throws(() => stream.update(input), TypeError);
    assert.equal(states[0].chunks.length, 1);
    stream.dispose();
  },
);

for (const [, , algorithm] of variants) {
  test(`${algorithm} streams consume the exact ranges of all supported views`, () => {
    const { api, states } = fixture();
    const buffer = new ArrayBuffer(64);
    const views = byteViews(buffer);
    const stream = api.createHasher(algorithm);
    stream.update('prefix');
    for (const [, view] of views) assert.equal(stream.update(view), stream);
    assert.equal(states[0].chunks[0], 'prefix');
    views.forEach(([, view], index) => {
      const chunk = states[0].chunks[index + 1];
      assert.equal(chunk.buffer, buffer);
      assert.deepEqual(chunk, { buffer, byteOffset: view.byteOffset, byteLength: view.byteLength });
    });
    stream.dispose();
  });
}

test('stream rejection of shared, forged and detached storage leaves existing chunks intact', () => {
  const { api, states } = fixture();
  const stream = api.createHasher('xxh64').update('valid');
  const invalid = [
    123,
    [],
    {},
    Object.create(DataView.prototype),
    new Proxy(new Uint8Array(8), {}),
  ];
  if (typeof SharedArrayBuffer !== 'undefined') {
    const shared = new SharedArrayBuffer(8);
    invalid.push(shared, new Uint16Array(shared), new DataView(shared));
  }
  if (typeof structuredClone === 'function') {
    const detached = new ArrayBuffer(8);
    invalid.push(detached, new Uint8Array(detached), new DataView(detached));
    structuredClone(detached, { transfer: [detached] });
  }
  for (const input of invalid) assert.throws(() => stream.update(input), TypeError);
  assert.deepEqual(states[0].chunks, ['valid']);
  assert.equal(stream.digest(), 'digest:1:0');
  stream.dispose();
});

for (const failure of ['failLoad', 'failCreate']) {
  test(`synchronous callers recover after ${failure}`, () => {
    const { api, events } = fixture({ [failure]: 1 });
    assert.throws(() => api.xxh3_128('first'), /unavailable/);
    assert.equal(api.xxh3_128('retry'), 'hashString');
    assert.equal(events.filter((event) => event === 'load').length, 2);
  });
  test(`file callers reject and recover after ${failure}`, async () => {
    const { api } = fixture({ [failure]: 1 });
    await assert.rejects(api.xxh64File('/first'), /unavailable/);
    assert.equal(await api.xxh64File('/retry'), 'hashFile');
  });
}

test('a string method getter failure retries without recreating the native object', () => {
  for (const [hash] of variants) {
    const { api, native, calls, reads, events } = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(native, 'hashString');
    const marker = new Error('native string getter failed');
    let attempts = 0;
    Object.defineProperty(native, 'hashString', {
      configurable: true,
      get() {
        attempts += 1;
        if (attempts === 1) throw marker;
        return descriptor.get.call(native);
      },
    });
    assert.throws(
      () => api[hash]('first'),
      (error) => error === marker,
    );
    assert.deepEqual(calls, []);
    assert.equal(api[hash]('retry', undefined), 'hashString');
    assert.equal(api[hash]('seeded', 42n), 'hashString');
    assert.equal(attempts, 2, 'the successful default binding also serves seeded calls');
    assert.equal(reads.hashString, 1);
    assert.equal(calls.length, 2);
    assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
    assert.equal(events.filter((event) => event === 'load').length, 1);
  }
});

test('a string method binding failure leaves the default caller retryable', () => {
  for (const [hash] of variants) {
    const { api, native, calls, reads, events } = fixture();
    const descriptor = Object.getOwnPropertyDescriptor(native, 'hashString');
    const marker = new Error('native string binding failed');
    let attempts = 0;
    Object.defineProperty(native, 'hashString', {
      configurable: true,
      get() {
        attempts += 1;
        const method = descriptor.get.call(native);
        if (attempts === 1) {
          Object.defineProperty(method, 'bind', {
            value() {
              throw marker;
            },
          });
        }
        return method;
      },
    });
    assert.throws(
      () => api[hash]('first'),
      (error) => error === marker,
    );
    assert.deepEqual(calls, []);
    assert.equal(api[hash]('retry'), 'hashString');
    assert.equal(api[hash]('seeded', { seed: 42n }), 'hashString');
    assert.equal(attempts, 2, 'a failed binding is never retained');
    assert.equal(reads.hashString, 2);
    assert.equal(calls.length, 2);
    assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
    assert.equal(events.filter((event) => event === 'load').length, 1);
  }
});

test('native string errors retain the bound method for default and seeded retries', () => {
  for (const [hash, , algorithm] of variants) {
    const { api, reads, calls, events } = fixture({ failures: { hashString: 1 } });
    assert.throws(() => api[hash]('first'), /native call failed/);
    assert.equal(api[hash]('retry', undefined), 'hashString');
    assert.equal(api[hash]('seeded', 42n), 'hashString');
    assert.equal(reads.hashString, 1);
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ['first', algorithm, '0'],
        ['retry', algorithm, '0'],
        ['seeded', algorithm, '42'],
      ],
    );
    assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
    assert.equal(events.filter((event) => event === 'load').length, 1);
  }
});

test('native file errors reject without discarding successful initialization', async () => {
  const { api, events, calls } = fixture({ failures: { hashFile: 1 } });
  await assert.rejects(api.xxh64File('content://media/file'), /native call failed/);
  assert.equal(await api.xxh64File('/retry'), 'hashFile');
  assert.deepEqual(calls[0], { name: 'hashFile', args: ['content://media/file', 'xxh64', '0'] });
  assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
});

for (const name of ['xxh3_64File', 'xxh3_128File']) {
  for (const failure of ['failLoad', 'failCreate']) {
    test(`${name} rejects and retries ${failure}`, async () => {
      const { api } = fixture({ [failure]: 1 });
      await assert.rejects(api[name]('/first'), /unavailable/);
      assert.equal(await api[name]('/retry'), 'hashFile');
    });
  }
  test(`${name} rejects native errors and retries the bound method`, async () => {
    const { api, reads } = fixture({ failures: { hashFile: 1 } });
    await assert.rejects(api[name]('/first'), /native call failed/);
    assert.equal(await api[name]('/retry'), 'hashFile');
    assert.equal(reads.hashFile, 1);
  });
}

test('native stream creation failures can be retried', () => {
  const { api, events } = fixture({ failures: { createHasher: 1 } });
  assert.throws(() => api.createHasher('xxh64'), /native call failed/);
  const stream = api.createHasher('xxh64');
  assert.equal(stream.digest(), 'digest:0:0');
  stream.dispose();
  assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
});

test('streams preserve chunk order, non-destructive digest, reset seed, and cleanup', () => {
  const { api, calls, states } = fixture();
  const bytes = new Uint8Array([2, 3]).buffer;
  const stream = api.createHasher('xxh3-128', 0xffffffffffffffffn);
  assert.equal(stream.algorithm, 'xxh3-128');
  assert.equal(stream.update('one').update(bytes), stream);
  assert.deepEqual(states[0].chunks, ['one', { buffer: bytes, byteOffset: 0, byteLength: 2 }]);
  assert.equal(stream.digest(), 'digest:2:18446744073709551615');
  assert.equal(stream.digest(), stream.digest());
  stream.update('three');
  assert.equal(stream.digest(), 'digest:3:18446744073709551615');
  assert.equal(stream.reset(), stream);
  stream.reset(5n).update('four');
  stream.reset();
  assert.deepEqual(states[0].resets, ['18446744073709551615', '5', '5']);
  assert.throws(() => stream.reset(-1), RangeError);
  assert.throws(() => stream.update({}), TypeError);
  assert.equal(stream.digest(), 'digest:0:5');
  stream.dispose();
  stream.dispose();
  assert.equal(states[0].disposed, 1);
  for (const action of [() => stream.digest(), () => stream.update('x'), () => stream.reset()]) {
    assert.throws(action, /disposed/);
  }
  assert.deepEqual(calls, [{ name: 'createHasher', args: ['xxh3-128', '18446744073709551615'] }]);
});

test('streams own independent states and do not retain a failed reset seed', () => {
  const { api, states } = fixture();
  const a = api.createHasher('xxh32', 1);
  const b = api.createHasher('xxh32', 2);
  a.update('a');
  b.update('b');
  const original = states[0].reset;
  states[0].reset = () => {
    throw new Error('native reset failed');
  };
  assert.throws(() => a.reset(7), /native reset failed/);
  states[0].reset = original;
  a.reset();
  assert.equal(a.digest(), 'digest:0:1');
  assert.equal(b.digest(), 'digest:1:2');
  a.dispose();
  b.dispose();
});

const canonicalDigests = {
  xxh32: '00ff0081',
  xxh64: '80ff000000000001',
  'xxh3-64': '00000000000000ff',
  'xxh3-128': 'fedcba98765432100123456789abcdef',
};

for (const [hash, file, algorithm, maximum] of variants) {
  test(`${hash} converts canonical hex to independent big-endian bytes and exact bigint`, async () => {
    const { api, calls } = fixture({ hashResults: canonicalDigests });
    const hex = canonicalDigests[algorithm];
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    const input = new Uint8Array(new ArrayBuffer(20), 3, 7);
    for (const value of ['input', input]) {
      assert.equal(api[hash](value), hex);
      assert.equal(api[hash](value, {}), hex);
      assert.equal(api[hash](value, { seed: maximum, output: 'hex' }), hex);
      const actual = api[hash](value, { seed: maximum, output: 'bytes' });
      assert.deepEqual(actual, bytes);
      assert.ok(actual.buffer instanceof ArrayBuffer);
      assert.equal(actual.byteOffset, 0);
      assert.equal(actual.buffer.byteLength, actual.byteLength);
      assert.equal(api[hash](value, { output: 'bigint' }), BigInt(`0x${hex}`));
      actual.fill(0);
      assert.deepEqual(api[hash](value, { output: 'bytes' }), bytes);
    }
    assert.deepEqual(await api[file]('/file', { seed: maximum, output: 'bytes' }), bytes);
    assert.equal(await api[file]('/file', { output: 'bigint' }), BigInt(`0x${hex}`));
    assert.equal(await api[file]('/file', { output: undefined }), hex);
    const seeded = calls.filter(({ args }) => args.at(-1) === maximum.toString());
    assert.ok(seeded.length >= 5, 'options preserve the complete unsigned seed');
    const stream = api.createHasher(algorithm, maximum);
    assert.equal(stream.digest(), hex);
    assert.equal(stream.digest(undefined), hex);
    assert.equal(stream.digest('hex'), hex);
    assert.deepEqual(stream.digest('bytes'), bytes);
    assert.equal(stream.digest('bigint'), BigInt(`0x${hex}`));
    stream.update('still active');
    assert.deepEqual(stream.digest('bytes'), bytes);
    stream.dispose();
  });
}

test('invalid options, outputs and signals reject before native initialization', async () => {
  const { api, events } = fixture();
  const invalid = [
    [],
    new Date(),
    new Number(1),
    { output: null },
    { output: 'arraybuffer' },
    { output: 1 },
    { seed: null },
    { unknown: true },
    { [Symbol('option')]: true },
  ];
  for (const [hash, file] of variants) {
    for (const options of invalid) {
      assert.throws(() => api[hash]('data', options), TypeError);
      await assert.rejects(api[file]('/file', options), TypeError);
    }
    assert.throws(() => api[hash]('data', { signal: undefined }), TypeError);
    for (const signal of [null, {}, true, 1, { aborted: false }, { aborted: 'no' }]) {
      await assert.rejects(api[file]('/file', { signal }), TypeError);
    }
  }
  assert.deepEqual(events, []);
});

test('omitted and zero seeds remain canonical without leaking options into later calls', async () => {
  const { api, calls } = fixture({ hashResults: canonicalDigests });
  const input = new Uint8Array([1, 2, 3]);
  for (const [hash, file, algorithm, maximum] of variants) {
    for (const seed of [undefined, 0, -0, 0n]) {
      assert.equal(api[hash]('text', seed), canonicalDigests[algorithm]);
      assert.equal(calls.at(-1).args.at(-1), '0');
      api[hash](input, { seed });
      assert.equal(calls.at(-1).args.at(-1), '0');
      await api[file]('/file', seed);
      assert.equal(calls.at(-1).args.at(-1), '0');
      const stream = api.createHasher(algorithm, seed);
      assert.equal(calls.at(-1).args.at(-1), '0');
      stream.update('chunk').reset(seed);
      assert.equal(stream.digest(), canonicalDigests[algorithm]);
      stream.dispose();
    }
    const options = { seed: maximum, output: 'bytes' };
    assert.ok(api[hash]('seeded', options) instanceof Uint8Array);
    assert.equal(calls.at(-1).args.at(-1), maximum.toString());
    options.seed = 0n;
    options.output = 'bigint';
    assert.equal(api[hash]('changed', options), BigInt(`0x${canonicalDigests[algorithm]}`));
    assert.equal(api[hash]('default again'), canonicalDigests[algorithm]);
    assert.equal(calls.at(-1).args.at(-1), '0');
  }
});

test('default and zero paths keep strict validation and never coerce zero-like seeds', () => {
  const { api, events } = fixture({ failLoad: 1 });
  let coercions = 0;
  const zeroLike = {
    valueOf() {
      coercions += 1;
      return 0;
    },
  };
  for (const hash of hashNames) {
    for (const seed of [null, false, '0', new Number(0), Object(0n), zeroLike, Symbol('zero')]) {
      assert.throws(() => api[hash]('text', seed), TypeError);
      assert.throws(() => api[hash]('text', { seed }), TypeError);
    }
    assert.throws(() => api[hash]('text', { seed: 0, output: 'invalid' }), TypeError);
    assert.throws(() => api[hash]('text', { seed: 0, signal: undefined }), TypeError);
    assert.throws(() => api[hash]({}, undefined), TypeError);
    assert.throws(() => api[hash](new Proxy(new Uint8Array(1), {})), TypeError);
  }
  assert.equal(coercions, 0);
  assert.deepEqual(events, []);
  assert.throws(() => api.xxh64('first valid call'), /loader unavailable/);
  assert.equal(api.xxh64('retry'), 'hashString');
});

test('warmed default string calls preserve input and validation through explicit fallbacks', () => {
  for (const [hash, , algorithm] of variants) {
    const { api, calls, reads, events } = fixture({ hashResults: canonicalDigests });
    const expected = canonicalDigests[algorithm];
    for (const input of ['', 'a\0b', 'Привет🙂', '\ud800']) {
      assert.equal(api[hash](input), expected);
      assert.equal(api[hash](input, undefined), expected);
      assert.deepEqual(
        calls.slice(-2).map((call) => call.args),
        [
          [input, algorithm, '0'],
          [input, algorithm, '0'],
        ],
      );
    }
    const optionReads = [];
    const options = {
      get seed() {
        optionReads.push('seed');
        return 42n;
      },
      get output() {
        optionReads.push('output');
        return 'hex';
      },
    };
    assert.equal(api[hash]('seeded', options), expected);
    assert.deepEqual(calls.at(-1).args, ['seeded', algorithm, '42']);
    assert.deepEqual(optionReads, ['seed', 'output']);
    assert.equal(reads.hashString, 1, 'default and explicit calls share the bound method');
    const callsBeforeRejection = calls.length;
    for (const options of [
      null,
      [],
      { seed: '0' },
      { output: 'invalid' },
      { unknown: 0 },
      { [Symbol('unknown')]: 0 },
      { signal: undefined },
    ]) {
      assert.throws(() => api[hash]('valid input', options), TypeError);
    }
    assert.throws(() => api[hash]('valid input', { seed: -1 }), RangeError);
    for (const input of [null, undefined, 1, {}, new String('wrapped')]) {
      assert.throws(() => api[hash](input), TypeError);
    }
    const marker = new Error('seed getter failed after warmup');
    assert.throws(
      () =>
        api[hash]('valid input', {
          get seed() {
            throw marker;
          },
        }),
      (error) => error === marker,
    );
    assert.equal(calls.length, callsBeforeRejection, 'rejections must not enter native hashing');
    assert.equal(reads.hashString, 1);
    assert.equal(events.filter((event) => event === 'create:FileHasher').length, 1);
    assert.equal(events.filter((event) => event === 'load').length, 1);
  }
});

test('options are snapshotted before a binary input is borrowed', () => {
  const { api, events } = fixture();
  const buffer = new ArrayBuffer(12);
  const input = new Uint8Array(buffer, 2, 5);
  let reads = 0;
  const options = {
    get seed() {
      reads += 1;
      if (typeof structuredClone === 'function') structuredClone(buffer, { transfer: [buffer] });
      return 0;
    },
  };
  if (typeof structuredClone === 'function') {
    assert.throws(() => api.xxh64(input, options), TypeError);
    assert.deepEqual(events, []);
  } else {
    api.xxh64(input, options);
  }
  assert.equal(reads, 1);
});

test('stream clones preserve the current seed and branch independently', () => {
  const { api, states, calls } = fixture();
  const original = api.createHasher('xxh64', 1).update('prefix').reset(7).update('shared');
  const clone = original.clone();
  assert.equal(clone.algorithm, 'xxh64');
  assert.equal(clone.digest(), original.digest());
  original.update('original');
  clone.update('clone').update('tail');
  assert.equal(original.digest(), 'digest:2:7');
  assert.equal(clone.digest(), 'digest:3:7');
  clone.reset();
  assert.equal(clone.digest(), 'digest:0:7');
  original.dispose();
  assert.equal(clone.update('survives').digest(), 'digest:1:7');
  clone.dispose();
  assert.deepEqual(
    states.map((state) => state.disposed),
    [1, 1],
  );
  assert.equal(calls.filter(({ name }) => name === 'createHasher').length, 1);
  assert.throws(() => original.clone(), /disposed/);
  assert.throws(() => clone.clone(), /disposed/);
});

test('invalid digest formats and a failed clone leave the stream usable', () => {
  const { api, states } = fixture();
  const stream = api.createHasher('xxh32', 8).update('prefix');
  let digestCalls = 0;
  const digest = states[0].digest;
  states[0].digest = function () {
    digestCalls += 1;
    return digest.call(this);
  };
  for (const output of [null, '', {}, 3]) {
    assert.throws(() => stream.digest(output), TypeError);
  }
  assert.equal(digestCalls, 0);
  const clone = states[0].clone;
  states[0].clone = () => {
    throw new Error('native clone failed');
  };
  assert.throws(() => stream.clone(), /native clone failed/);
  assert.equal(stream.digest(), 'digest:1:8');
  states[0].clone = clone;
  const branch = stream.clone();
  stream.dispose();
  assert.equal(branch.digest(), 'digest:1:8');
  branch.dispose();
});

function trackedAbortSignal(controller = new AbortController()) {
  const listeners = new Set();
  return {
    controller,
    listeners,
    signal: {
      get aborted() {
        return controller.signal.aborted;
      },
      get reason() {
        return controller.signal.reason;
      },
      addEventListener(type, listener, options) {
        listeners.add(listener);
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        listeners.delete(listener);
        controller.signal.removeEventListener(type, listener);
      },
    },
  };
}

function pendingFileTask() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {
    promise,
    resolve,
    reject,
    cancelled: 0,
    resultCalls: 0,
    result() {
      this.resultCalls += 1;
      return promise;
    },
    cancel() {
      this.cancelled += 1;
    },
  };
}

for (const [, file, algorithm, maximum] of variants) {
  test(`${file} with a signal uses one cancellable task and cleans its subscription`, async () => {
    const { api, tasks, calls, reads } = fixture({ hashResults: canonicalDigests });
    const tracked = trackedAbortSignal();
    const result = await api[file]('/file', {
      signal: tracked.signal,
      output: 'bytes',
      seed: maximum,
    });
    assert.deepEqual(result, Uint8Array.from(Buffer.from(canonicalDigests[algorithm], 'hex')));
    assert.deepEqual(calls, [
      { name: 'startFileHash', args: ['/file', algorithm, maximum.toString()] },
    ]);
    assert.equal(tracked.listeners.size, 0);
    tracked.controller.abort();
    assert.equal(tasks[0].cancelled, 0, 'abort after success has no effect');
    await api[file]('/next', { signal: new AbortController().signal });
    assert.deepEqual(reads, { startFileHash: 1 });
  });
}

test('pre-aborted file hashing rejects without importing Nitro or starting file work', async () => {
  const { api, events, calls } = fixture();
  const tracked = trackedAbortSignal();
  const reason = { why: 'cancelled before start' };
  tracked.controller.abort(reason);
  for (const [, file] of variants) {
    await assert.rejects(api[file]('/file', { signal: tracked.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      assert.equal(error.cause, reason);
      return true;
    });
  }
  assert.equal(tracked.listeners.size, 0);
  assert.deepEqual(events, []);
  assert.deepEqual(calls, []);
});

test('abort cancels native work before rejecting and consumes a late native failure', async () => {
  const task = pendingFileTask();
  const order = [];
  task.cancel = function () {
    order.push('cancel');
    this.cancelled += 1;
  };
  const { api } = fixture({ taskFactory: () => task });
  const tracked = trackedAbortSignal();
  const reason = new Error('user stopped hashing');
  const pending = api.xxh64File('/large', { signal: tracked.signal });
  const rejected = assert.rejects(pending, (error) => {
    order.push('reject');
    assert.equal(error.name, 'AbortError');
    assert.equal(error.cause, reason);
    return true;
  });
  tracked.controller.abort(reason);
  await rejected;
  assert.deepEqual(order, ['cancel', 'reject']);
  assert.equal(task.cancelled, 1);
  assert.equal(task.resultCalls, 1);
  assert.equal(tracked.listeners.size, 0);
  task.reject(new Error('native worker noticed cancellation'));
  await new Promise(setImmediate);
});

for (const when of ['start', 'result']) {
  test(`abort during native ${when} cancels the returned task exactly once`, async () => {
    const tracked = trackedAbortSignal();
    const task = pendingFileTask();
    if (when === 'result') {
      const result = task.result;
      task.result = function () {
        tracked.controller.abort('stop');
        return result.call(this);
      };
    }
    const { api } = fixture({
      taskFactory() {
        if (when === 'start') tracked.controller.abort('stop');
        return task;
      },
    });
    await assert.rejects(api.xxh3_128File('/file', { signal: tracked.signal }), {
      name: 'AbortError',
    });
    assert.equal(task.cancelled, 1);
    assert.equal(task.resultCalls, 1);
    assert.equal(tracked.listeners.size, 0);
    task.resolve(canonicalDigests['xxh3-128']);
    await new Promise(setImmediate);
  });
}

test('cancellable file errors preserve the original rejection and clean subscriptions', async () => {
  for (const failure of ['start', 'result', 'async']) {
    const original = new Error(`native ${failure} failed`);
    const task = pendingFileTask();
    if (failure === 'result') {
      task.result = () => {
        throw original;
      };
    }
    const tracked = trackedAbortSignal();
    const { api } = fixture({
      taskFactory() {
        if (failure === 'start') throw original;
        return task;
      },
    });
    const pending = api.xxh32File('/file', { signal: tracked.signal });
    if (failure === 'async') task.reject(original);
    await assert.rejects(pending, (error) => error === original);
    assert.equal(tracked.listeners.size, 0);
    assert.equal(task.cancelled, failure === 'result' ? 1 : 0);
    tracked.controller.abort();
    assert.equal(task.cancelled, failure === 'result' ? 1 : 0);
  }
});

test('cancellable file calls retry initialization and retain a successfully bound method', async () => {
  for (const failure of ['failLoad', 'failCreate']) {
    const { api, reads } = fixture({ [failure]: 1, hashResults: canonicalDigests });
    const first = trackedAbortSignal();
    await assert.rejects(api.xxh64File('/first', { signal: first.signal }), /unavailable/);
    assert.equal(first.listeners.size, 0);
    assert.equal(
      await api.xxh64File('/retry', { signal: new AbortController().signal }),
      canonicalDigests.xxh64,
    );
    assert.equal(reads.startFileHash, 1);
  }
  const { api, reads } = fixture({ failures: { startFileHash: 1 }, hashResults: canonicalDigests });
  await assert.rejects(
    api.xxh64File('/first', { signal: new AbortController().signal }),
    /native call failed/,
  );
  assert.equal(
    await api.xxh64File('/retry', { signal: new AbortController().signal }),
    canonicalDigests.xxh64,
  );
  assert.equal(reads.startFileHash, 1);
});

test('native cancellation errors cannot replace AbortError or leave a listener behind', async () => {
  const task = pendingFileTask();
  task.cancel = () => {
    throw new Error('cancel failed');
  };
  const { api } = fixture({ taskFactory: () => task });
  const tracked = trackedAbortSignal();
  const pending = api.xxh64File('/file', { signal: tracked.signal });
  tracked.controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(tracked.listeners.size, 0);
  task.reject(new Error('late error'));
  await new Promise(setImmediate);
});

test('file admission is shared across algorithms and held until native work really settles', async () => {
  const { api, native, tasks, calls } = fixture();
  const ordinary = pendingFileTask();
  Object.defineProperty(native, 'hashFile', {
    configurable: true,
    value: () => ordinary.promise,
  });
  const signals = [trackedAbortSignal(), trackedAbortSignal()];
  // One ordinary file and one cancellable file share the same two native permits.
  const first = api.xxh32File('/ordinary');
  const task = pendingFileTask();
  const queuedTask = pendingFileTask();
  Object.defineProperty(native, 'startFileHash', {
    configurable: true,
    value() {
      const next = tasks.length === 0 ? task : queuedTask;
      tasks.push(next);
      return next;
    },
  });
  const second = api.xxh64File('/active', { signal: signals[0].signal });
  const third = api.xxh3_128File('/queued', { signal: signals[1].signal });
  assert.equal(tasks.length, 1);
  const aborted = assert.rejects(second, { name: 'AbortError' });
  signals[0].controller.abort('cancel active worker');
  await aborted;
  assert.equal(task.cancelled, 1);
  assert.equal(tasks.length, 1, 'public abort must not free an occupied native worker');
  ordinary.resolve('ordinary');
  assert.equal(await first, 'ordinary');
  assert.equal(tasks.length, 2, 'native completion admits the next queued algorithm');
  task.resolve('late completion after abort');
  queuedTask.resolve('finished');
  assert.equal(await third, 'finished');
  await new Promise(setImmediate);
  assert.equal(tasks.length, 2);
  assert.equal(calls.length, 0, 'the fixture method overrides own this scenario');
  assert.equal(signals[0].listeners.size, 0);
  assert.equal(signals[1].listeners.size, 0);
});

test('cancelling thousands of queued files never creates native tasks for them', async () => {
  const activeTasks = [pendingFileTask(), pendingFileTask()];
  let starts = 0;
  const { api } = fixture({
    taskFactory() {
      starts += 1;
      assert(starts <= 2, 'cancelled queued calls must never enter native code');
      return activeTasks[starts - 1];
    },
  });
  const blockers = [
    api.xxh32File('/blocker-0', { signal: new AbortController().signal }),
    api.xxh64File('/blocker-1', { signal: new AbortController().signal }),
  ];
  const cancellations = [];
  for (let index = 0; index < 5000; index += 1) {
    const tracked = trackedAbortSignal();
    const result = api.xxh3_128File(`/queued-${index}`, { signal: tracked.signal });
    cancellations.push(assert.rejects(result, { name: 'AbortError', cause: index }));
    tracked.controller.abort(index);
    assert.equal(tracked.listeners.size, 0);
  }
  await Promise.all(cancellations);
  assert.equal(starts, 2);
  activeTasks.forEach((task) => task.resolve('done'));
  assert.deepEqual(await Promise.all(blockers), ['done', 'done']);
  await new Promise(setImmediate);
  assert.equal(starts, 2);
});

test('a queued file setup failure releases its permit and leaves later calls usable', async () => {
  const tasks = [pendingFileTask(), pendingFileTask(), pendingFileTask()];
  const marker = new Error('queued native setup failed');
  let starts = 0;
  const { api } = fixture({
    taskFactory() {
      const position = starts++;
      if (position === 2) throw marker;
      return tasks[position === 3 ? 2 : position];
    },
  });
  const options = () => ({ signal: new AbortController().signal });
  const first = api.xxh32File('/first', options());
  const second = api.xxh64File('/second', options());
  const failed = assert.rejects(api.xxh3_64File('/failed', options()), (error) => error === marker);
  const last = api.xxh3_128File('/last', options());
  assert.equal(starts, 2);
  tasks[0].resolve('first');
  await failed;
  assert.equal(starts, 4);
  tasks[1].resolve('second');
  tasks[2].resolve('last');
  assert.deepEqual(await Promise.all([first, second, last]), ['first', 'second', 'last']);
});
