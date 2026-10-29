const assert = require('node:assert/strict');
const path = require('node:path');
const { test } = require('node:test');
const { createNitroCacheFixture } = require('./native/nitro-cache-fixture.cjs');
const definitions = require('../compat/patches.json');
const {
  ROOT,
  directoriesUnder,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('all six Nitro caches use the same bounded amortized retention path', () => {
  const cache = definitions.targets.find((target) => target.path === 'cpp/jsi/JSICache.hpp');
  assert(cache && cache.kind === 'local-cache-lifetime');
  for (const name of ['value', 'object', 'function', 'weakObject', 'propNameID', 'arrayBuffer']) {
    assert(cache.patched.includes(`retain(_strongCache->_${name}Cache, owning);`), name);
    assert(!cache.patched.includes(`_${name}Cache.push_back`), name);
  }
  assert.equal(
    new Set(definitions.targets.map((target) => `${target.path}\0${target.signature}`)).size,
    definitions.targets.length,
  );
});

test('real patched Nitro headers preserve concurrent reference lifetimes and amortized pruning', () => {
  const compiler = requiredExecutable('clang++');
  withTemporaryDirectory('nitro-xxhash-cache-reference-', (temporary) => {
    const nitro = createNitroCacheFixture(path.join(temporary, 'nitro'));
    const includes = ['-I', path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi')];
    for (const directory of directoriesUnder(nitro)) includes.push('-I', directory);
    const sources = [
      path.join(ROOT, 'tests/native/nitro-cache-lifetime.cpp'),
      path.join(nitro, 'utils/NitroTypeInfo.cpp'),
    ];
    const backends =
      process.env.NITRO_CACHE_TSAN === '1'
        ? [['thread-sanitized', ['-fsanitize=thread', '-fno-sanitize-recover=all']]]
        : [
            ['release', []],
            ['sanitized', ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']],
          ];
    for (const [name, flags] of backends) {
      const binary = path.join(temporary, name);
      run(compiler, [
        '-std=c++20',
        '-O1',
        '-DNDEBUG',
        '-pthread',
        ...flags,
        ...includes,
        ...sources,
        '-o',
        binary,
      ]);
      const result = run(binary, [], { timeout: 30000 });
      assert.match(result.stdout, /Nitro cache\/reference regression passed/);
      console.log(`${name}: ${result.stdout.trim()}`);
    }
  });
});
