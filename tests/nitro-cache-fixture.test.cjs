const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const definitions = require('../compat/patches.json');
const { runCompatibility } = require('../compat/apply.cjs');
const { withTemporaryDirectory } = require('../scripts/native-test-utils.cjs');
const { createNitroRuntimeRegistryFixture } = require('./native/nitro-cache-fixture.cjs');

const targetPaths = [...new Set(definitions.targets.map((target) => target.path))];

function repairedSource(directory) {
  const installed = path.dirname(require.resolve('react-native-nitro-modules/package.json'));
  for (const relative of ['package.json', ...targetPaths]) {
    const destination = path.join(directory, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(installed, relative), destination);
  }
  runCompatibility({ nitroPath: directory });
}

function snapshot(directory) {
  return targetPaths.map((relative) => fs.readFileSync(path.join(directory, relative), 'utf8'));
}

for (const linked of ['cpp/utils/WeakReference.hpp', 'cpp/utils', 'cpp']) {
  test(`Nitro cache fixtures own copied contents and preserve a source symlink at ${linked}`, () => {
    withTemporaryDirectory('nitro-xxhash-fixture-links-', (directory) => {
      const source = path.join(directory, 'source');
      repairedSource(source);
      const link = path.join(source, linked);
      const original = path.join(directory, 'shared-source');
      const isDirectory = fs.statSync(link).isDirectory();
      fs.renameSync(link, original);
      fs.symlinkSync(original, link, isDirectory ? 'dir' : 'file');
      const before = snapshot(source);
      const fixture = path.join(directory, 'fixture');

      const cpp = createNitroRuntimeRegistryFixture(fixture, source);

      assert.deepEqual(snapshot(source), before, 'Source SDK bytes must remain unchanged');
      assert(fs.lstatSync(link).isSymbolicLink(), 'Source SDK links must remain unchanged');
      for (const relative of ['cpp', 'cpp/utils', ...targetPaths]) {
        const copied = path.join(fixture, relative);
        assert(!fs.lstatSync(copied).isSymbolicLink(), `Fixture must own ${relative}`);
        assert.notEqual(fs.realpathSync(copied), fs.realpathSync(path.join(source, relative)));
      }
      assert(
        fs
          .readFileSync(path.join(cpp, 'utils/WeakReference.hpp'), 'utf8')
          .includes('++cacheProbeExpiredChecks'),
        'Only the fixture receives cache observation hooks',
      );
      assert(
        fs
          .readFileSync(path.join(cpp, 'utils/CommonGlobals.cpp'), 'utf8')
          .includes('std::size_t cacheProbeGlobalRuntimeEntries()'),
        'Only the fixture receives registry observation hooks',
      );
    });
  });
}
