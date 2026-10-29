const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  run,
  withTemporaryDirectory,
  filesUnder,
  nitroHeaderMap,
} = require('../scripts/native-test-utils.cjs');

test('native process checks capture output and accept only the expected exit status', () => {
  const result = run(process.execPath, ['-e', 'console.log("native-result")']);
  assert.equal(result.stdout.trim(), 'native-result');
  assert.throws(
    () => run(process.execPath, ['-e', 'console.error("native-failure"); process.exit(7)']),
    /exited 7; expected 0[\s\S]*native-failure/,
  );
  assert.equal(run(process.execPath, ['-e', 'process.exit(7)'], { expectedStatus: 7 }).status, 7);
});

test('missing tools and signalled processes never satisfy an expected exit status', () => {
  assert.throws(
    () => run(`nitro-xxhash-missing-command-${process.pid}`, [], { expectedStatus: null }),
    /ENOENT/,
  );
  assert.throws(
    () => run(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM")']),
    /terminated by SIGTERM/,
  );
});

test('native process timeouts fail the check', () => {
  assert.throws(
    () => run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }),
    /ETIMEDOUT/,
  );
});

test('temporary native fixtures are cleaned even when a check throws', () => {
  let fixture;
  assert.throws(
    () =>
      withTemporaryDirectory('nitro-xxhash-cleanup-', (directory) => {
        fixture = directory;
        fs.writeFileSync(path.join(directory, 'partial-output'), 'temporary');
        throw new Error('native check failed');
      }),
    /native check failed/,
  );
  assert.equal(fs.existsSync(fixture), false);
});

test('Nitro header maps reject duplicate names instead of silently choosing a header', () => {
  withTemporaryDirectory('nitro-xxhash-header-map-', (directory) => {
    const source = path.join(directory, 'nitro');
    for (const name of ['first', 'second']) {
      const parent = path.join(source, name);
      fs.mkdirSync(parent, { recursive: true });
      fs.writeFileSync(path.join(parent, 'Shared.hpp'), name);
    }
    assert.throws(
      () => nitroHeaderMap(source, path.join(directory, 'include')),
      /Duplicate Nitro public header name: Shared.hpp/,
    );
  });
});

test('native source discovery includes file symlinks without traversing directory symlinks', () => {
  withTemporaryDirectory('nitro-xxhash-source-links-', (directory) => {
    const source = path.join(directory, 'source');
    const outside = path.join(directory, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    const original = path.join(source, 'HybridOriginal.cpp');
    const alias = path.join(source, 'HybridLinked.cpp');
    fs.writeFileSync(original, '// Native fixture');
    fs.writeFileSync(path.join(outside, 'Skipped.cpp'), '// Outside this source tree');
    fs.symlinkSync(original, alias);
    fs.symlinkSync(outside, path.join(source, 'external'), 'dir');
    assert.deepEqual(
      filesUnder(source, (file) => file.endsWith('.cpp')),
      [alias, original].sort(),
    );
  });
});
