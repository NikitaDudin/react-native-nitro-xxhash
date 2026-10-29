module.exports = function compareStrings(api, competitor, now, emit, fixtures, settings) {
  let state = settings.seed >>> 0;
  function random() {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  }
  function shuffle(items) {
    const result = items.slice();
    for (let index = result.length - 1; index > 0; index--) {
      const other = random() % (index + 1);
      [result[index], result[other]] = [result[other], result[index]];
    }
    return result;
  }
  function equal(actual, expected, context) {
    if (actual !== expected) throw new Error(`${context}: ${actual} !== ${expected}`);
  }
  let checks = 0;
  for (const fixture of fixtures.correctness) {
    for (const [ours, theirs, expected] of [
      [api.xxh3_64, competitor.hash64, fixture.xxh3_64],
      [api.xxh3_128, competitor.hash128, fixture.xxh3_128],
    ]) {
      equal(ours(fixture.input), expected, 'Nitro reference digest');
      checks++;
      if (fixture.input.length > 0) {
        equal(theirs(fixture.input), expected, 'Competitor reference digest');
        checks++;
      } else {
        let rejected = false;
        try {
          theirs(fixture.input);
        } catch {
          rejected = true;
        }
        if (!rejected) throw new Error('Competitor empty-string behavior changed');
        checks++;
      }
    }
  }
  const cases = [];
  for (const fixture of fixtures.performance) {
    fixture.inputs = Array.from(
      { length: 16 },
      (_, index) =>
        String.fromCharCode(65 + index) +
        fixture.unit.repeat(fixture.repeat) +
        'x'.repeat(fixture.tail),
    );
    for (const width of [64, 128]) {
      const ours = width === 64 ? api.xxh3_64 : api.xxh3_128;
      const theirs = width === 64 ? competitor.hash64 : competitor.hash128;
      for (let index = 0; index < fixture.inputs.length; index++) {
        equal(ours(fixture.inputs[index]), theirs(fixture.inputs[index]), 'Shared corpus digest');
        checks++;
      }
      cases.push({ fixture, width, functions: { ours, theirs }, calls: {} });
    }
  }
  let sink = 0;
  function batch(fn, inputs, calls) {
    let checksum = 0;
    const start = now();
    for (let index = 0; index < calls; index++) {
      const result = fn(inputs[index & 15]);
      checksum = (checksum + result.length + result.charCodeAt(index & 15)) | 0;
    }
    const elapsedMs = now() - start;
    sink = (sink + checksum) | 0;
    if (!(elapsedMs > 0)) throw new Error('Nonpositive benchmark duration');
    return { elapsedMs, calls, nsPerCall: (elapsedMs * 1e6) / calls, checksum };
  }
  // Warm every corpus member, then calibrate each implementation independently.
  // Whole corpus cycles give equal input frequencies even with different speeds.
  for (const entry of shuffle(cases)) {
    for (const name of shuffle(['ours', 'theirs'])) {
      let calls = 16;
      for (;;) {
        const sample = batch(entry.functions[name], entry.fixture.inputs, calls);
        if (sample.elapsedMs >= settings.targetMs) break;
        calls = Math.max(
          calls + 16,
          Math.ceil((calls * Math.min(8, (settings.targetMs * 1.1) / sample.elapsedMs)) / 16) * 16,
        );
        if (calls > 16_000_000) throw new Error('Benchmark calibration exceeded its limit');
      }
      entry.calls[name] = calls;
    }
  }
  const samples = [];
  for (let round = 0; round < settings.rounds; round++) {
    for (const entry of shuffle(cases)) {
      const order = shuffle(['ours', 'theirs']);
      for (const name of order) {
        samples.push({
          kind: entry.fixture.kind,
          bytes: entry.fixture.bytes,
          width: entry.width,
          implementation: name,
          round,
          position: order.indexOf(name),
          ...batch(entry.functions[name], entry.fixture.inputs, entry.calls[name]),
        });
      }
    }
    emit(JSON.stringify({ event: 'round', round: round + 1, total: settings.rounds }));
  }
  emit(JSON.stringify({ event: 'result', checks, sink, samples, settings }));
};
