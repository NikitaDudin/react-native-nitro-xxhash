const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { summarize, formatSummary, readSettings } = require('./run.cjs');
const cold = require('./cold-suite.cjs');

const chunkSample = (implementation, milliseconds = 20, overrides = {}) => ({
  kind: 'large-chunks',
  implementation,
  width: 64,
  bytes: 500_000_000,
  calls: 2,
  chunkBytes: 250_000_000,
  elapsedMs: milliseconds,
  nsPerCall: (milliseconds * 1e6) / 2,
  ...overrides,
});

test('large chunks preserve per-call units and report the complete 500 MB elapsed time', () => {
  const [summary] = summarize([{ samples: [chunkSample('ours'), chunkSample('theirs', 22)] }]);
  assert.equal(summary.bytes, 500_000_000);
  assert.equal(summary.bytesPerCall, 250_000_000);
  assert.equal(summary.batchCalls, 2);
  assert.equal(summary.ours.medianNs, 10_000_000);
  assert.equal(summary.ours.medianMs, 20);
  const line = formatSummary(summary);
  assert.match(line, /500000000 bytes total \(2 calls × 250000000 bytes\)/);
  assert.match(line, /ours 20\.000 ms total, theirs 22\.000 ms total/);
});

test('different large chunk sizes and call counts cannot merge into one summary', () => {
  const summaries = summarize([
    {
      samples: [
        chunkSample('ours'),
        chunkSample('ours', 20, { calls: 4, chunkBytes: 125_000_000, nsPerCall: 5_000_000 }),
      ],
    },
  ]);
  assert.equal(summaries.length, 2);
  assert.deepEqual(
    summaries.map((value) => [value.bytesPerCall, value.batchCalls]),
    [
      [250_000_000, 2],
      [125_000_000, 4],
    ],
  );
});

test('a large file reports one complete 500 MB call in milliseconds', () => {
  const [summary] = summarize([
    {
      samples: [
        chunkSample('ours', 50, {
          kind: 'large-file',
          calls: 1,
          chunkBytes: undefined,
          nsPerCall: 50_000_000,
        }),
      ],
    },
  ]);
  assert.equal(summary.bytesPerCall, 500_000_000);
  assert.equal(summary.batchCalls, 1);
  assert.match(formatSummary(summary), /500000000 bytes total.*ours 50\.000 ms total/);
});

test('latency calibration and bulk counts retain per-call timing semantics', () => {
  const summaries = summarize([
    {
      samples: [
        chunkSample('ours', 10, {
          kind: 'ascii',
          bytes: 16,
          chunkBytes: undefined,
          calls: 100_000,
          nsPerCall: 100,
        }),
        chunkSample('theirs', 8, {
          kind: 'ascii',
          bytes: 16,
          chunkBytes: undefined,
          calls: 50_000,
          nsPerCall: 160,
        }),
        chunkSample('ours', 10, {
          kind: 'bulk',
          bytes: 16,
          chunkBytes: undefined,
          calls: 100_000,
          batchCalls: 100_000,
          nsPerCall: 100,
        }),
      ],
    },
  ]);
  assert.equal(summaries.length, 2);
  const latency = summaries.find((entry) => entry.kind === 'ascii');
  assert.equal(latency.bytesPerCall, 16);
  assert.equal(latency.batchCalls, undefined);
  assert.equal(latency.oursOverTheirs, 100 / 160);
  assert.match(formatSummary(latency), /ours 0\.100 us\/call/);
  const bulk = summaries.find((entry) => entry.kind === 'bulk');
  assert.equal(bulk.batchCalls, 100_000);
  assert.match(formatSummary(bulk), /100000 calls.*ours 0\.100 us\/call/);
});

test('cold profile requires one round and scales through fresh-process count', () => {
  const options = readSettings({ BENCHMARK_PROFILE: 'cold', BENCHMARK_PROCESSES: '4' });
  assert.equal(options.rounds, 1);
  assert.equal(options.processes, 4);
  assert.throws(
    () => readSettings({ BENCHMARK_PROFILE: 'cold', BENCHMARK_ROUNDS: '7' }),
    /exactly one round/,
  );
  assert.throws(
    () =>
      cold(
        () => assert.fail('Must reject before loading a module'),
        () => 0,
        () => {},
        { rounds: 2, coldWidth: 64 },
      ),
    /exactly one round/,
  );
});

test('invalid cold rounds fail before native SDK or compiler setup', () => {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'run.cjs')], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_ROOT: '',
      XXHASH_COMPETITOR_ROOT: '',
      BENCHMARK_PROFILE: 'cold',
      BENCHMARK_ROUNDS: '2',
    },
  });
  assert.ifError(result.error);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exactly one round/);
  assert.doesNotMatch(result.stderr, /Set HERMES_ROOT/);
});
