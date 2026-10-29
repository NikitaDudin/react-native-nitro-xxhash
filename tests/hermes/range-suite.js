let checks = 0;
function equal(actual, expected, label) {
  if (actual !== expected)
    throw new Error(label + ': expected ' + String(expected) + ', got ' + String(actual));
  checks++;
}
function throws(operation, label) {
  let failed = false;
  try {
    operation();
  } catch (error) {
    failed = error instanceof Error;
  }
  equal(failed, true, label);
}
const methods = {
  xxh32: api.xxh32,
  xxh64: api.xxh64,
  'xxh3-64': api.xxh3_64,
  'xxh3-128': api.xxh3_128,
};
const types = [
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
];
for (const name of ['BigInt64Array', 'BigUint64Array', 'Float16Array'])
  if (typeof globalThis[name] === 'function') types.push(globalThis[name]);
const raw = NitroModulesProxy.createHybridObject('FileHasher');
function pointerCheck(input, backing, offset, length) {
  const metadata = normalize(input);
  equal(metadata.buffer, backing, 'normalizer keeps backing identity');
  equal(metadata.byteOffset, offset, 'normalizer exact offset');
  equal(metadata.byteLength, length, 'normalizer exact length');
  equal(
    assertBorrowedRange(metadata.buffer, metadata.byteOffset, metadata.byteLength),
    true,
    'real JSI buffer pointer identity',
  );
}
for (const nativeOwned of [false, true]) {
  const backing = nativeOwned ? NitroModulesProxy.createNativeArrayBuffer(96) : new ArrayBuffer(96);
  const bytes = new Uint8Array(backing);
  bytes.fill(0xa5);
  for (let index = 16; index < 80; index++) bytes[index] = (index * 131 + 17) % 256;
  const candidates = [
    { view: bytes.subarray(17, 72), offset: 17, length: 55 },
    { view: new DataView(backing, 17, 55), offset: 17, length: 55 },
  ];
  for (const Type of types)
    candidates.push({
      view: new Type(backing, 16, 64 / Type.BYTES_PER_ELEMENT),
      offset: 16,
      length: 64,
    });
  const pooled = Buffer.from(backing).subarray(17, 72);
  candidates.push({ view: pooled, offset: 17, length: 55 });
  for (const { view, offset, length } of candidates) {
    pointerCheck(view, backing, offset, length);
    const exact = backing.slice(offset, offset + length);
    for (const algorithm of Object.keys(methods))
      for (const seed of [0, 42n, algorithm === 'xxh32' ? 4294967295n : 18446744073709551615n]) {
        const hash = methods[algorithm];
        equal(
          hash(view, seed),
          hash(exact, seed),
          'facade view ' + algorithm + '/' + view.constructor.name + '/' + nativeOwned,
        );
        const state = api.createHasher(algorithm, seed);
        state.update(view);
        equal(state.digest(), hash(exact, seed), 'stream view ' + algorithm);
        equal(state.digest(), hash(exact, seed), 'repeated digest ' + algorithm);
        state
          .reset()
          .update(new Uint8Array(backing, offset, 0))
          .update(view);
        equal(state.digest(), hash(exact, seed), 'reset and zero length ' + algorithm);
        state.dispose();
      }
  }
  for (const view of [
    new Uint8Array(backing, 96, 0),
    new DataView(backing, 96, 0),
    Buffer.from(backing).subarray(96),
  ]) {
    pointerCheck(view, view.buffer, view.byteOffset, 0);
    for (const hash of Object.values(methods)) equal(hash(view), hash(''), 'empty view at end');
  }
  const live = bytes.subarray(17, 20);
  for (const hash of Object.values(methods)) {
    const before = hash(live);
    bytes[17] ^= 0xff;
    equal(hash(live) === before, false, 'mutated view remains live');
    bytes[17] ^= 0xff;
  }
}
// Independent static vectors verify all algorithms/seeds, not only self-equivalence.
for (const algorithm of Object.keys(VECTORS))
  for (const seedString of Object.keys(VECTORS[algorithm]))
    for (const name of ['0', '1', '16', '240', '241', '65537', 'string-1', 'string-5']) {
      const expected = VECTORS[algorithm][seedString][name];
      let source;
      if (name.startsWith('string-')) {
        const hex = ORIGINAL[Number(name.slice(7))].utf8;
        source = new Uint8Array(hex.length / 2);
        for (let i = 0; i < source.length; i++)
          source[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
      } else {
        source = new Uint8Array(Number(name));
        for (let i = 0; i < source.length; i++) source[i] = (i * 131 + 17) % 256;
      }
      const backing = new ArrayBuffer(source.byteLength + 2),
        padded = new Uint8Array(backing);
      padded.fill(0xff);
      padded.set(source, 1);
      const view = new DataView(backing, 1, source.byteLength),
        seed = BigInt(seedString);
      equal(
        methods[algorithm](view, seed),
        expected,
        'independent golden ' + algorithm + '/' + seedString + '/' + name,
      );
      const state = api.createHasher(algorithm, seed);
      state.update(view);
      equal(state.digest(), expected, 'golden stream');
      state.dispose();
    }
const backing = new ArrayBuffer(32),
  view = new Uint8Array(backing, 8, 8),
  dataView = new DataView(backing, 8, 8);
new Uint8Array(backing).set([1, 2, 3, 4, 5, 6, 7, 8], 8);
const expected = api.xxh3_128(new Uint8Array(backing, 8, 8));
for (const candidate of [view, dataView]) {
  Object.defineProperties(candidate, {
    buffer: {
      get() {
        throw Error('own buffer getter touched');
      },
    },
    byteOffset: {
      get() {
        throw Error('own offset getter touched');
      },
    },
    byteLength: {
      get() {
        throw Error('own length getter touched');
      },
    },
  });
  equal(api.xxh3_128(candidate), expected, 'own metadata getters bypassed');
}
const common = Object.getPrototypeOf(Uint8Array.prototype),
  saved = {};
for (const name of ['buffer', 'byteOffset', 'byteLength', 'values']) {
  saved[name] = Object.getOwnPropertyDescriptor(common, name);
  Object.defineProperty(common, name, {
    configurable: true,
    get() {
      throw Error('prototype getter touched');
    },
  });
}
try {
  equal(api.xxh3_128(view), expected, 'cached TypedArray intrinsics bypass prototype mutation');
} finally {
  for (const name of Object.keys(saved)) Object.defineProperty(common, name, saved[name]);
}
for (const invalid of [
  undefined,
  null,
  {},
  [],
  1,
  true,
  Object.create(ArrayBuffer.prototype),
  Object.create(Uint8Array.prototype),
  new Proxy(new Uint8Array(4), {}),
  new Proxy(new ArrayBuffer(4), {}),
]) {
  for (const hash of Object.values(methods)) throws(() => hash(invalid), 'invalid facade input');
  const state = api.createHasher('xxh3-128');
  state.update('prefix');
  const before = state.digest();
  throws(() => state.update(invalid), 'invalid stream input');
  equal(state.digest(), before, 'invalid stream preserves state');
  state.dispose();
}
const rangeState = raw.createHasher('xxh3-128', '42');
rangeState.updateString('prefix');
const previous = rangeState.digest();
for (const [offset, length] of [
  [-1, 1],
  [0, -1],
  [0.5, 1],
  [0, 0.5],
  [NaN, 1],
  [0, Infinity],
  [33, 0],
  [32, 1],
  [31, 2],
  [9007199254740992, 0],
]) {
  throws(
    () => raw.hashBuffer(backing, offset, length, 'xxh3-128', '0'),
    'private native invalid range',
  );
  throws(() => rangeState.updateBuffer(backing, offset, length), 'private native invalid update');
  equal(rangeState.digest(), previous, 'private native invalid range keeps state');
}
rangeState.dispose();
let resizable = 'unavailable';
if (typeof ArrayBuffer.prototype.resize === 'function') {
  const resizableBuffer = new ArrayBuffer(32, { maxByteLength: 64 });
  const fixed = new Uint8Array(resizableBuffer, 16, 16);
  resizableBuffer.resize(8);
  throws(() => api.xxh3_64(fixed), 'out-of-bounds resizable view');
  resizableBuffer.resize(32);
  equal(
    api.xxh3_64(fixed),
    api.xxh3_64(new Uint8Array(resizableBuffer, 16, 16)),
    'resizable view recovery',
  );
  resizable = 'checked';
}
let detachable = 'unavailable';
if (typeof ArrayBuffer.prototype.transfer === 'function') {
  const transferred = new ArrayBuffer(8),
    old = new Uint8Array(transferred);
  transferred.transfer();
  throws(() => api.xxh3_64(old), 'detached view');
  throws(() => api.xxh3_64(transferred), 'detached buffer');
  detachable = 'checked';
}
print(
  JSON.stringify({
    checks,
    engine: 'Hermes',
    nitro: NitroModulesProxy.version,
    viewTypes: types.map((type) => type.name),
    bufferPolyfill: BUFFER_VERSION,
    nativeOwned: true,
    rangePointers: true,
    resizable,
    detachable,
  }),
);
