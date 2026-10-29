const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { withTemporaryDirectory } = require('../scripts/native-test-utils.cjs');
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
