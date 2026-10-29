module.exports = function compareFirstUse(load, now, emit, settings) {
  if (settings.rounds !== undefined && settings.rounds !== 1)
    throw new Error('Cold first-use measurements require exactly one round per fresh process');
  const width = settings.coldWidth;
  if (width !== 64 && width !== 128) throw new Error('Expected coldWidth 64 or 128');
  const input = '0123456789abcdef';
  const order = (settings.seed & 1) === 0 ? ['ours', 'theirs'] : ['theirs', 'ours'];
  const modules = {};
  const firstDigests = {};
  const samples = [];

  // Avoid charging the timing host function's first access to either library.
  for (let index = 0; index < 32; index++) now();

  function sample(kind, implementation, calls, action) {
    const start = now();
    const result = action();
    const elapsedMs = now() - start;
    if (!(elapsedMs > 0)) throw new Error('Nonpositive first-use benchmark duration');
    samples.push({
      kind,
      bytes: input.length,
      width,
      implementation,
      position: order.indexOf(implementation),
      calls,
      elapsedMs,
      nsPerCall: (elapsedMs * 1e6) / calls,
    });
    return result;
  }

  for (const implementation of order) {
    modules[implementation] = sample('cold-import', implementation, 1, () =>
      load(implementation === 'ours' ? '/index' : '/competitor'),
    );
  }
  const functions = {
    ours: width === 64 ? modules.ours.xxh3_64 : modules.ours.xxh3_128,
    theirs: width === 64 ? modules.theirs.hash64 : modules.theirs.hash128,
  };
  for (const implementation of order) {
    firstDigests[implementation] = sample('cold-first', implementation, 1, () =>
      functions[implementation](input),
    );
  }
  if (firstDigests.ours !== firstDigests.theirs) throw new Error('First-use digest mismatch');
  if (firstDigests.ours.length !== width / 4) throw new Error('Incorrect first-use digest width');
  let checks = 2;
  let sink = 0;
  const checksums = {};
  for (const implementation of order) {
    const fn = functions[implementation];
    checksums[implementation] = sample('cold-warm', implementation, 100_000, () => {
      let checksum = 0;
      for (let index = 0; index < 100_000; index++) {
        const result = fn(input);
        checksum = (checksum + result.length + result.charCodeAt(index & 15)) | 0;
      }
      return checksum;
    });
    sink = (sink + checksums[implementation]) | 0;
  }
  if (checksums.ours !== checksums.theirs) throw new Error('Warmed first-use checksum mismatch');
  checks++;
  emit(JSON.stringify({ event: 'result', checks, sink, samples, settings }));
};
