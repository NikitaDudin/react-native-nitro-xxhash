const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createNitroRuntimeRegistryFixture } = require('./native/nitro-cache-fixture.cjs');
const {
  ROOT,
  directoriesUnder,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('real Hermes runtime registries clean up owning runtimes and support concurrent owners', () => {
  assert.equal(process.platform, 'darwin', 'This optional host check requires macOS Hermes');
  const configured = process.env.HERMES_ROOT;
  assert(configured, 'Set HERMES_ROOT to the matching Hermes destroot for this optional check');
  const expanded = configured.startsWith('~/')
    ? path.join(os.homedir(), configured.slice(2))
    : configured === '~'
      ? os.homedir()
      : configured;
  const hermes = path.resolve(expanded);
  const framework = path.join(hermes, 'Library/Frameworks/macosx');
  for (const relative of [
    'include/hermes/hermes.h',
    'include/jsi/jsi.h',
    'Library/Frameworks/macosx/hermesvm.framework/hermesvm',
  ])
    assert(fs.existsSync(path.join(hermes, relative)), `Missing Hermes SDK file: ${relative}`);
  assert(
    fs
      .readFileSync(path.join(hermes, 'include/jsi/jsi.h'))
      .equals(
        fs.readFileSync(path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi/jsi/jsi.h')),
      ),
    'Hermes and installed React Native JSI headers differ',
  );
  withTemporaryDirectory('nitro-xxhash-runtime-registry-', (temporary) => {
    const cpp = createNitroRuntimeRegistryFixture(
      path.join(temporary, 'nitro'),
      process.env.NITRO_REGISTRY_SOURCE,
    );
    const includes = ['-I', path.join(hermes, 'include')];
    for (const directory of directoriesUnder(cpp)) includes.push('-I', directory);
    const sources = [
      'jsi/JSICache.cpp',
      'utils/CommonGlobals.cpp',
      'utils/PropNameIDCache.cpp',
      'utils/NitroTypeInfo.cpp',
      'threading/Dispatcher.cpp',
      'prototype/HybridObjectPrototype.cpp',
    ].map((relative) => path.join(cpp, relative));
    sources.push(path.join(ROOT, 'tests/native/nitro-runtime-registry.cpp'));
    const modes =
      process.env.NITRO_REGISTRY_TSAN === '1'
        ? [['thread-sanitized', ['-fsanitize=thread', '-fno-sanitize-recover=all']]]
        : [
            ['release', []],
            ['sanitized', ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']],
          ];
    for (const [name, flags] of modes) {
      const binary = path.join(temporary, name);
      run(requiredExecutable('clang++'), [
        '-std=c++20',
        '-O1',
        '-g',
        process.env.NITRO_REGISTRY_DEBUG === '1' ? '-DDEBUG' : '-DNDEBUG',
        '-pthread',
        ...flags,
        ...includes,
        ...sources,
        '-F',
        framework,
        '-framework',
        'hermesvm',
        `-Wl,-rpath,${framework}`,
        '-o',
        binary,
      ]);
      const result = run(
        binary,
        process.env.NITRO_REGISTRY_DEBUG === '1' ? ['--concurrent-only'] : [],
        {
          timeout: 60_000,
          env: {
            ...process.env,
            TSAN_OPTIONS: [process.env.TSAN_OPTIONS, 'halt_on_error=1'].filter(Boolean).join(':'),
          },
        },
      );
      assert.match(result.stdout, /Real Hermes runtime registries preserve live owners/);
      console.log(`${name}: ${result.stdout.trim()}`);
    }
  });
});
