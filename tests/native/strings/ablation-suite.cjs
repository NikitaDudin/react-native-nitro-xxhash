module.exports = function compareLayers(createLoader, now, emit, settings) {
  let state = settings.seed >>> 0;
  const targetMs = settings.targetMs === undefined ? 20 : settings.targetMs;
  const rounds = settings.rounds === undefined ? 7 : settings.rounds;
  let checks = 0;
  let sink = 0;
  function shuffle(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      const other = (state >>> 0) % (index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }
  function equal(actual, expected, label) {
    if (actual !== expected) throw new Error(`${label}: ${actual} !== ${expected}`);
    checks++;
  }
  const defaultModule = (value, named = {}) => ({ __esModule: true, default: value, ...named });
  const serializeUnchecked = (_algorithm, seed) => BigInt(seed === undefined ? 0 : seed).toString();
  const serializeZero = () => '0';
  const parseFresh = () => ({ seed: '0', output: 'hex' });
  const defaults = Object.freeze({ seed: '0', output: 'hex' });
  const parseCached = () => defaults;
  const identity = (value) => value;
  const fullLoader = createLoader();
  const full = fullLoader('/index');
  const converter = fullLoader('/src/convertHashOutput');
  const native = fullLoader('/src/getFileHasher').default();
  const competitor = fullLoader('/competitor');
  const stages = [
    { name: 'full', api: full },
    { name: 'production', api: createLoader({}, false)('/index') },
  ];
  let overrides = {};
  function addFacade(name, module, replacement) {
    overrides = { ...overrides, [module]: replacement };
    stages.push({ name, api: createLoader(overrides)('/index') });
  }
  addFacade('seed-unchecked', '/src/serializeSeed', defaultModule(serializeUnchecked));
  addFacade('seed-zero', '/src/serializeSeed', defaultModule(serializeZero));
  addFacade('parser-defaults', '/src/parseHashOptions', defaultModule(parseFresh));
  addFacade('parser-cached', '/src/parseHashOptions', defaultModule(parseCached));
  addFacade('input-unchecked', '/src/normalizeHashInput', defaultModule(identity));
  addFacade(
    'output-unchecked',
    '/src/convertHashOutput',
    defaultModule(identity, { validateHashOutput: converter.validateHashOutput }),
  );
  const generic = native.hashString.bind(native);
  // Use factory parameters so optimized Hermes keeps one immutable algorithm
  // binding per diagnostic callback, independently of the construction loop.
  function guardedGeneric(algorithm) {
    return function (input) {
      if (typeof input !== 'string') throw new TypeError('Expected a string');
      return generic(input, algorithm, '0');
    };
  }
  function uncheckedGeneric(algorithm) {
    return function (input) {
      return generic(input, algorithm, '0');
    };
  }
  const fixedMethods = { 64: native.hashString64, 128: native.hashString128 };
  const hasFixedMethods = Object.values(fixedMethods).every(
    (method) => typeof method === 'function',
  );
  const skippedStages = hasFixedMethods ? [] : ['fixed-guarded', 'fixed-unchecked', 'fixed-direct'];
  const functions = new Map();
  for (const width of [64, 128]) {
    const algorithm = width === 64 ? 'xxh3-64' : 'xxh3-128';
    const method = width === 64 ? 'xxh3_64' : 'xxh3_128';
    const variants = stages.map((stage) => ({ name: stage.name, fn: stage.api[method] }));
    variants.push(
      {
        name: 'generic-guarded',
        fn: guardedGeneric(algorithm),
      },
      {
        name: 'generic-unchecked',
        fn: uncheckedGeneric(algorithm),
      },
    );
    if (hasFixedMethods) {
      const fixed = fixedMethods[width].bind(native);
      variants.push(
        {
          name: 'fixed-guarded',
          fn(input) {
            if (typeof input !== 'string') throw new TypeError('Expected a string');
            return fixed(input);
          },
        },
        {
          name: 'fixed-unchecked',
          fn(input) {
            return fixed(input);
          },
        },
        { name: 'fixed-direct', fn: fixed },
      );
    }
    variants.push({
      name: 'competitor',
      fn: width === 64 ? competitor.hash64 : competitor.hash128,
    });
    functions.set(width, variants);
  }
  // Independent existing golden values, deliberately outside the timed corpus.
  const golden = [
    ['hello world', 'd447b1ea40e6988b', 'df8d09e93f874900a99b8775cc15b6c7'],
    ['Привет, мир!', '9d6e1ed90c188bb6', '547ad80671d654ab6e493c861164fb99'],
    ['🙂🚀𝄞', 'd065062c4c50f8c6', 'c6268c9d2500d89c5d499b7317c92e0d'],
    ['a\0b', 'd5a06cd078125351', '39797789ed4c7ea0d5a06cd078125351'],
    ['é', 'f7940a006cf10cb3', '90326970ab18793af7940a006cf10cb3'],
    ['e\u0301', 'dc0ba6f9447885a8', 'b23c1d2f7ba408b8dc0ba6f9447885a8'],
    ['\ud800', '3c4d03b478a6e14e', '17edefcbcee80eea3c4d03b478a6e14e'],
  ];
  for (const width of [64, 128]) {
    for (const variant of functions.get(width)) {
      for (const vector of golden) {
        equal(
          variant.fn(vector[0]),
          vector[width === 64 ? 1 : 2],
          `${variant.name}/${width}/golden`,
        );
      }
      if (variant.name !== 'competitor') {
        equal(
          variant.fn(''),
          width === 64 ? '2d06800538d394c2' : '99aa06d3014798d86001c324468d497f',
          `${variant.name}/${width}/empty`,
        );
      }
    }
  }
  const cases = [];
  const unit = 'abcdefghijklmnopqrstuvwxyz0123456789_-';
  for (const bytes of [16, 64, 1024]) {
    const inputs = Array.from(
      { length: 16 },
      (_, index) =>
        String.fromCharCode(65 + index) +
        unit.repeat(Math.floor((bytes - 1) / unit.length)) +
        'x'.repeat((bytes - 1) % unit.length),
    );
    for (const width of [64, 128]) {
      const expected = inputs.map((input) => functions.get(width)[0].fn(input));
      for (const variant of functions.get(width)) {
        for (let index = 0; index < inputs.length; index++) {
          equal(
            variant.fn(inputs[index]),
            expected[index],
            `${variant.name}/${width}/${bytes}/corpus`,
          );
        }
        cases.push({ bytes, width, inputs, variant, calls: 16 });
      }
    }
  }
  function batch(fn, inputs, calls) {
    let checksum = 0;
    const start = now();
    for (let index = 0; index < calls; index++) {
      const result = fn(inputs[index & 15]);
      checksum = (checksum + result.length + result.charCodeAt(index & 15)) | 0;
    }
    const elapsedMs = now() - start;
    if (!(elapsedMs > 0)) throw new Error('Nonpositive ablation benchmark duration');
    sink = (sink + checksum) | 0;
    return { calls, elapsedMs, nsPerCall: (elapsedMs * 1e6) / calls, checksum };
  }
  for (const entry of shuffle(cases)) {
    for (;;) {
      const sample = batch(entry.variant.fn, entry.inputs, entry.calls);
      if (sample.elapsedMs >= targetMs) break;
      entry.calls = Math.max(
        entry.calls + 16,
        Math.ceil((entry.calls * Math.min(8, (targetMs * 1.1) / sample.elapsedMs)) / 16) * 16,
      );
      if (entry.calls > 16_000_000) throw new Error('Ablation calibration exceeded its limit');
    }
  }
  const samples = [];
  for (let round = 0; round < rounds; round++) {
    const order = shuffle(cases);
    for (let position = 0; position < order.length; position++) {
      const entry = order[position];
      samples.push({
        kind: `ablation-${entry.variant.name}`,
        implementation: entry.variant.name === 'competitor' ? 'theirs' : 'ours',
        bytes: entry.bytes,
        width: entry.width,
        round,
        position,
        ...batch(entry.variant.fn, entry.inputs, entry.calls),
      });
    }
    emit(JSON.stringify({ event: 'round', round: round + 1, total: rounds }));
  }
  emit(
    JSON.stringify({
      event: 'result',
      checks,
      sink,
      samples,
      settings,
      stages: functions.get(64).map((variant) => variant.name),
      skippedStages,
      cases: cases.length,
    }),
  );
};
