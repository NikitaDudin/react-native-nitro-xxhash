const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');
const { copyAndroidValidationFixture } = require('../scripts/copy-android-validation-fixture.cjs');

test('Android validation copies isolate linked SDK sources before modifying fixture files', () => {
  withTemporaryDirectory('nitro-xxhash-android-copy-', (temporary) => {
    const source = path.join(temporary, 'sdk');
    const fixture = path.join(temporary, 'fixture');
    const originalProperties = path.join(temporary, 'shared.properties');
    const originalSources = path.join(temporary, 'shared-sources');
    fs.mkdirSync(source);
    fs.mkdirSync(originalSources);
    fs.writeFileSync(originalProperties, 'original properties');
    fs.writeFileSync(path.join(originalSources, 'source.cpp'), 'original source');
    fs.symlinkSync(originalProperties, path.join(source, 'gradle.properties'));
    fs.symlinkSync(originalSources, path.join(source, 'src'), 'dir');
    fs.mkdirSync(path.join(source, 'build'));
    fs.writeFileSync(path.join(source, 'build/stale.bin'), 'omit build artifacts');

    copyAndroidValidationFixture(source, fixture);
    assert(!fs.lstatSync(path.join(fixture, 'gradle.properties')).isSymbolicLink());
    assert(!fs.lstatSync(path.join(fixture, 'src')).isSymbolicLink());
    assert(!fs.existsSync(path.join(fixture, 'build')));
    fs.writeFileSync(path.join(fixture, 'gradle.properties'), 'fixture properties');
    fs.writeFileSync(path.join(fixture, 'src/source.cpp'), 'fixture source');

    assert.equal(fs.readFileSync(originalProperties, 'utf8'), 'original properties');
    assert.equal(
      fs.readFileSync(path.join(originalSources, 'source.cpp'), 'utf8'),
      'original source',
    );
    assert(fs.lstatSync(path.join(source, 'gradle.properties')).isSymbolicLink());
    assert(fs.lstatSync(path.join(source, 'src')).isSymbolicLink());
  });
});

const { resolveAndroidValidationConfig } = require('../scripts/android-validation-config.cjs');

test('Android validation uses the supported RN 0.88 host override configuration', () => {
  const current = resolveAndroidValidationConfig(['--profile', 'rn88'], {}, '/repository');
  assert.equal(current.profile.reactNative, '0.88.0');
  assert.equal(current.profile.minSdk, 26);
  assert.equal(current.profile.compileSdk, 37);
  assert.equal(current.profile.targetSdk, 37);
  assert.equal(current.profile.agp9Compatibility, true);
  assert.equal(current.profile.ndkVersion, '30.0.16248370');
});

test('Android validation rejects ambiguous options before creating a fixture', () => {
  for (const args of [
    ['--profile'],
    ['--output', '--keep-fixture'],
    ['--profile', 'unknown'],
    ['--profile', 'rn86'],
    ['--unexpected'],
  ]) {
    assert.throws(() => resolveAndroidValidationConfig(args, {}, '/repository'));
  }
  const config = resolveAndroidValidationConfig(
    [
      '--profile',
      'rn88',
      '--dependencies-root',
      '/isolated',
      '--output',
      '/evidence',
      '--keep-fixture',
    ],
    { GRADLE_BIN: '/toolchain/gradle' },
    '/repository',
  );
  assert.equal(config.dependenciesRoot, '/isolated');
  assert.equal(config.outputDirectory, '/evidence');
  assert.equal(config.gradleBin, '/toolchain/gradle');
  assert.equal(config.keepFixture, true);
});

const nativeSources = [
  'HybridFileHasher.cpp',
  'HybridHashState.cpp',
  'HybridHashFileTask.cpp',
  'FileDigest.cpp',
  'FileHashExecutor.cpp',
  'FilePath.cpp',
  'Armv7Neon.cpp',
];
const hashingKernels = new Set(['FileDigest.cpp', 'Armv7Neon.cpp']);

function createCmakeFixture(directory) {
  const android = path.join(directory, 'android');
  fs.mkdirSync(android);
  fs.copyFileSync(path.join(ROOT, 'android/CMakeLists.txt'), path.join(android, 'CMakeLists.txt'));
  const sources = [
    'android/src/main/cpp/JNIOnLoad.cpp',
    ...nativeSources.map((name) => `cpp/${name}`),
  ];
  for (const source of sources) {
    const target = path.join(directory, source);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `int fixture_${path.basename(source, '.cpp')}() { return 0; }\n`);
  }
  const generated = path.join(directory, 'nitrogen/generated/android/xxHash+autolinking.cmake');
  fs.mkdirSync(path.dirname(generated), { recursive: true });
  fs.writeFileSync(
    generated,
    '# Native dependency linking is outside this compile-option check.\n',
  );
  return android;
}

function configureCmake(source, build, configuration, abi, optimize) {
  const options = [
    '-S',
    source,
    '-B',
    build,
    '-G',
    'Unix Makefiles',
    '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
    `-DCMAKE_BUILD_TYPE=${configuration}`,
    `-DANDROID_ABI=${abi}`,
    '-DCMAKE_CXX_FLAGS=',
    '-DCMAKE_CXX_FLAGS_DEBUG=-O0 -g',
    '-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG',
    '-DCMAKE_CXX_FLAGS_RELWITHDEBINFO=-O2 -g -DNDEBUG',
  ];
  if (optimize !== undefined) options.push(`-DXXHASH_OPTIMIZE_DEBUG=${optimize}`);
  run(requiredExecutable('cmake'), options);
  return JSON.parse(fs.readFileSync(path.join(build, 'compile_commands.json'), 'utf8'));
}

function flagsFor(entries, source) {
  const entry = entries.find((candidate) => path.basename(candidate.file) === source);
  assert(entry, `Missing compiler command for ${source}`);
  const arguments_ = entry.arguments || entry.command.split(/\s+/);
  return arguments_.filter((argument) => /^-O\S*$|^-g$|^-DNDEBUG\b|^-mfpu=/u.test(argument));
}

function assertDebugScope(entries, enabled) {
  for (const source of ['JNIOnLoad.cpp', ...nativeSources]) {
    const flags = flagsFor(entries, source);
    assert.deepEqual(
      flags.filter((flag) => flag.startsWith('-O')),
      enabled && hashingKernels.has(source) ? ['-O0', '-O2'] : ['-O0'],
      source,
    );
    assert(flags.includes('-g'), `${source} lost Debug symbols`);
    assert(!flags.some((flag) => flag.startsWith('-DNDEBUG')), `${source} disabled Debug checks`);
  }
}

test('Android Debug optimizes only hashing kernels by default and supports cached ON/OFF changes', () => {
  withTemporaryDirectory('nitro-xxhash-debug-options-', (directory) => {
    const source = createCmakeFixture(directory);
    const build = path.join(directory, 'build');
    assertDebugScope(configureCmake(source, build, 'Debug', 'arm64-v8a'), true);
    assert.match(
      fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'),
      /^XXHASH_OPTIMIZE_DEBUG:BOOL=ON$/m,
    );
    assertDebugScope(configureCmake(source, build, 'Debug', 'arm64-v8a', 'OFF'), false);
    assert.match(
      fs.readFileSync(path.join(build, 'CMakeCache.txt'), 'utf8'),
      /^XXHASH_OPTIMIZE_DEBUG:BOOL=OFF$/m,
    );
    assertDebugScope(configureCmake(source, build, 'Debug', 'arm64-v8a', 'ON'), true);
  });
});

test('Android Release compiler flags are unchanged by the Debug optimization option', () => {
  withTemporaryDirectory('nitro-xxhash-release-options-', (directory) => {
    const source = createCmakeFixture(directory);
    for (const configuration of ['Release', 'RelWithDebInfo']) {
      const build = path.join(directory, configuration);
      const enabled = configureCmake(source, build, configuration, 'arm64-v8a', 'ON');
      const disabled = configureCmake(source, build, configuration, 'arm64-v8a', 'OFF');
      for (const file of ['JNIOnLoad.cpp', ...nativeSources]) {
        assert.deepEqual(flagsFor(enabled, file), flagsFor(disabled, file), file);
        assert.deepEqual(
          flagsFor(enabled, file).filter((flag) => flag.startsWith('-O')),
          configuration === 'Release' ? ['-O3'] : ['-O2'],
        );
        assert(flagsFor(enabled, file).includes('-DNDEBUG'));
      }
    }
  });
});

test('Android ARMv7 keeps scalar and NEON source flags when toggling Debug optimization', () => {
  withTemporaryDirectory('nitro-xxhash-armv7-options-', (directory) => {
    const source = createCmakeFixture(directory);
    const build = path.join(directory, 'build');
    for (const setting of ['ON', 'OFF']) {
      const entries = configureCmake(source, build, 'Debug', 'armeabi-v7a', setting);
      assertDebugScope(entries, setting === 'ON');
      for (const file of ['JNIOnLoad.cpp', ...nativeSources]) {
        assert.deepEqual(
          flagsFor(entries, file).filter((flag) => flag.startsWith('-mfpu=')),
          file === 'Armv7Neon.cpp' ? ['-mfpu=vfpv3-d16', '-mfpu=neon'] : ['-mfpu=vfpv3-d16'],
          file,
        );
      }
    }
  });
});

test('Android Gradle forwards an explicit Debug optimization value for both property states', () => {
  const gradle = fs.readFileSync(path.join(ROOT, 'android/build.gradle'), 'utf8');
  assert.match(gradle, /findProperty\('xxhashOptimizeDebug'\)\s*\?:\s*'true'\)\.toBoolean\(\)/);
  assert.match(
    gradle,
    /arguments\s+"-DANDROID_STL=[\s\S]*?"-DXXHASH_OPTIMIZE_DEBUG=\$\{optimizeDebug \? 'ON' : 'OFF'\}"/,
  );
  assert.equal(gradle.match(/-DXXHASH_OPTIMIZE_DEBUG=/g)?.length, 1);
});
