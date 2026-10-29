module.exports = function compareLarge(
  api,
  competitor,
  now,
  emit,
  settings,
  readString,
  readChunks,
  filePath,
) {
  globalThis.__benchmarkAsyncPending = true;
  const samples = [];
  let checks = 0;
  let sink = 0;
  let state = settings.seed >>> 0;
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
  function equal(actual, expected) {
    if (actual !== expected)
      throw new Error(`Large fixture digest mismatch: ${actual} !== ${expected}`);
    checks++;
  }
  async function measure() {
    const preparation = {};
    try {
      const value = readString();
      preparation.wholeString = { supported: true, length: value.length };
      throw new Error('Pinned Hermes unexpectedly accepted the oversized string');
    } catch (error) {
      if (
        !(error instanceof RangeError) ||
        !String(error.message).includes('String length exceeds limit')
      )
        throw error;
      preparation.wholeString = { supported: false, error: String(error) };
      checks++;
    }
    const preparedAt = now();
    const chunks = readChunks();
    preparation.chunksMs = now() - preparedAt;
    if (chunks.length !== 2 || chunks.some((chunk) => chunk.length !== 250_000_000))
      throw new Error('Expected two 250 MB ASCII chunks');
    const jobs = [];
    for (const width of [64, 128]) {
      const ours = width === 64 ? api.xxh3_64 : api.xxh3_128;
      const theirs = width === 64 ? competitor.hash64 : competitor.hash128;
      const file = width === 64 ? api.xxh3_64File : api.xxh3_128File;
      const expected = width === 64 ? 'bbbb815f432b43af' : 'fa42d5cb1bfe7843bbbb815f432b43af';
      const expectedChunks = chunks.map((chunk) => ours(chunk));
      for (let index = 0; index < chunks.length; index++)
        equal(theirs(chunks[index]), expectedChunks[index]);
      const firstFileStart = now();
      const firstFileDigest = await file(filePath);
      if (!preparation.firstFileAfterStringMs) preparation.firstFileAfterStringMs = {};
      preparation.firstFileAfterStringMs[width] = now() - firstFileStart;
      equal(firstFileDigest, expected);
      jobs.push(
        { kind: 'large-chunks', width, implementation: 'ours', fn: ours, expected: expectedChunks },
        {
          kind: 'large-chunks',
          width,
          implementation: 'theirs',
          fn: theirs,
          expected: expectedChunks,
        },
        { kind: 'large-file', width, implementation: 'ours', fn: file, expected },
      );
    }
    for (let round = 0; round < settings.rounds; round++) {
      const order = shuffle(jobs);
      for (const job of order) {
        const start = now();
        let outputs;
        if (job.kind === 'large-file') outputs = [await job.fn(filePath)];
        else outputs = chunks.map((chunk) => job.fn(chunk));
        const elapsedMs = now() - start;
        if (!(elapsedMs > 0)) throw new Error('Nonpositive large benchmark duration');
        for (let index = 0; index < outputs.length; index++)
          equal(outputs[index], job.kind === 'large-file' ? job.expected : job.expected[index]);
        for (const digest of outputs) sink = (sink + digest.length + digest.charCodeAt(0)) | 0;
        samples.push({
          kind: job.kind,
          bytes: 500_000_000,
          width: job.width,
          implementation: job.implementation,
          round,
          position: order.indexOf(job),
          calls: outputs.length,
          elapsedMs,
          nsPerCall: (elapsedMs * 1e6) / outputs.length,
          chunkBytes: job.kind === 'large-chunks' ? 250_000_000 : undefined,
        });
      }
      emit(JSON.stringify({ event: 'round', round: round + 1, total: settings.rounds }));
    }
    emit(JSON.stringify({ event: 'result', checks, sink, samples, settings, preparation }));
  }
  measure().then(
    () => {
      globalThis.__benchmarkAsyncPending = false;
    },
    (error) => {
      globalThis.__benchmarkAsyncError = error && error.stack ? String(error.stack) : String(error);
      globalThis.__benchmarkAsyncPending = false;
    },
  );
};
