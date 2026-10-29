module.exports = function compareBulkStrings(api, competitor, now, emit, _fixtures, settings) {
  let state = (settings.seed || 1) >>> 0;
  const rounds = settings.rounds === undefined ? 5 : settings.rounds;
  if (!Number.isInteger(rounds) || rounds <= 0) throw new Error('Invalid bulk round count');

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

  const cases = [];
  let checks = 0;
  for (const bytes of [16, 64, 256]) {
    const suffix = 'abcdefghijklmnopqrstuvwxyz0123456789_-'
      .repeat(Math.ceil((bytes - 8) / 38))
      .slice(0, bytes - 8);
    const inputs = Array.from(
      { length: 65_536 },
      (_, index) => index.toString(16).padStart(8, '0') + suffix,
    );
    for (const width of [64, 128]) {
      const functions = {
        ours: width === 64 ? api.xxh3_64 : api.xxh3_128,
        theirs: width === 64 ? competitor.hash64 : competitor.hash128,
      };
      // Verify and materialize every corpus string before any timed series.
      for (const input of inputs) {
        if (input.length !== bytes) throw new Error('Incorrect bulk ASCII fixture length');
        if (functions.ours(input) !== functions.theirs(input))
          throw new Error(`Bulk digest mismatch for XXH3-${width}, ${bytes} bytes`);
        checks++;
      }
      for (const calls of [10_000, 100_000, 1_000_000]) {
        cases.push({ bytes, width, inputs, functions, calls });
      }
    }
  }

  let sink = 0;
  function batch(fn, inputs, calls) {
    let checksum = 0;
    const segmentCalls = calls === 1_000_000 ? 100_000 : calls;
    const segments = calls / segmentCalls;
    const segmentMs = [];
    const start = now();
    for (let segment = 0; segment < segments; segment++) {
      const begin = segment * segmentCalls;
      const end = begin + segmentCalls;
      const segmentStart = now();
      for (let index = begin; index < end; index++) {
        const result = fn(inputs[index & 65_535]);
        checksum = (checksum + result.length + result.charCodeAt(index & 15)) | 0;
      }
      segmentMs.push(now() - segmentStart);
    }
    const elapsedMs = now() - start;
    if (!(elapsedMs > 0)) throw new Error('Nonpositive bulk benchmark duration');
    sink = (sink + checksum) | 0;
    return {
      calls,
      batchCalls: calls,
      elapsedMs,
      nsPerCall: (elapsedMs * 1e6) / calls,
      checksum,
      ...(calls === 1_000_000 ? { segmentMs } : {}),
    };
  }

  const samples = [];
  for (let round = 0; round < rounds; round++) {
    for (const entry of shuffle(cases)) {
      const order = shuffle(['ours', 'theirs']);
      for (const implementation of order) {
        samples.push({
          kind: 'bulk',
          bytes: entry.bytes,
          width: entry.width,
          implementation,
          round,
          position: order.indexOf(implementation),
          ...batch(entry.functions[implementation], entry.inputs, entry.calls),
        });
      }
    }
    emit(JSON.stringify({ event: 'round', round: round + 1, total: rounds }));
  }
  emit(JSON.stringify({ event: 'result', checks, sink, samples, settings }));
};
