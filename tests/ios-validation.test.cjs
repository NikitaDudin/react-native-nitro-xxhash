const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  filesUnder,
  findExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');
const { validatePodspecSourceLayout } = require('../scripts/validate-ios-sources.cjs');

const pod = findExecutable('pod');
const projectToolsAvailable =
  process.platform === 'darwin' && pod && findExecutable('plutil') && findExecutable('xcodebuild');

function environment(settings = {}) {
  const env = { ...process.env, COCOAPODS_DISABLE_STATS: 'true' };
  delete env.XXHASH_OPTIMIZE_DEBUG;
  delete env.XXHASH_OPTIMIZE_RELEASE;
  for (const [configuration, value] of Object.entries(settings)) {
    env[`XXHASH_OPTIMIZE_${configuration.toUpperCase()}`] = value;
  }
  return env;
}

function readSpec(settings) {
  return JSON.parse(
    run(pod, ['ipc', 'spec', path.join(ROOT, 'xxHash.podspec'), '--silent'], {
      env: environment(settings),
    }).stdout,
  );
}

test(
  'iOS podspec separates kernels and supports independent persistent defaults',
  { skip: !pod },
  () => {
    const spec = readSpec();
    assert.deepEqual(validatePodspecSourceLayout(spec), [
      'cpp/Armv7Neon.cpp',
      'cpp/FileDigest.cpp',
    ]);
    assert.equal(spec.pod_target_xcconfig.XXHASH_OPTIMIZE_DEBUG, 'YES');
    assert.equal(spec.pod_target_xcconfig.XXHASH_OPTIMIZE_RELEASE, 'YES');
    assert(spec.pod_target_xcconfig.HEADER_SEARCH_PATHS.includes('$(PODS_ROOT)/Headers/Private'));
    const disabled = readSpec({ debug: ' no ', release: 'no' });
    validatePodspecSourceLayout(disabled);
    assert.equal(disabled.pod_target_xcconfig.XXHASH_OPTIMIZE_DEBUG, 'NO');
    assert.equal(disabled.pod_target_xcconfig.XXHASH_OPTIMIZE_RELEASE, 'NO');
    for (const configuration of ['debug', 'release']) {
      assert.throws(
        () => readSpec({ [configuration]: 'invalid' }),
        new RegExp(`XXHASH_OPTIMIZE_${configuration.toUpperCase()} must be YES or NO`),
      );
    }
  },
);

test(
  'iOS source validator rejects inherited sources, exclusions and unconditional flags',
  { skip: !pod },
  () => {
    for (const mutate of [
      (spec) => {
        spec.source_files = 'cpp/**/*.cpp';
      },
      (spec) => {
        spec.exclude_files = 'cpp/FileDigest.cpp';
      },
      (spec) => {
        spec.subspecs.find((item) => item.name === 'Core').exclude_files = [];
      },
      (spec) => {
        spec.subspecs.find((item) => item.name === 'Kernels').compiler_flags = '-O2';
      },
      (spec) => {
        spec.pod_target_xcconfig.XXHASH_DEBUG_KERNEL_FLAGS_Release_YES = '-O2';
      },
      (spec) => {
        spec.pod_target_xcconfig.XXHASH_RELEASE_KERNEL_FLAGS_Debug_YES = '-O2';
      },
    ]) {
      const spec = readSpec();
      mutate(spec);
      assert.throws(() => validatePodspecSourceLayout(spec));
    }
  },
);

function createPodfile(directory) {
  const nitro = path.join(directory, 'NitroStub');
  fs.mkdirSync(nitro);
  fs.writeFileSync(path.join(nitro, 'stub.cpp'), 'int nitro_fixture = 0;\n');
  fs.writeFileSync(
    path.join(nitro, 'NitroModules.podspec.json'),
    JSON.stringify({
      name: 'NitroModules',
      version: '0.37.1',
      summary: 'Local project-generation fixture',
      homepage: 'https://example.test/nitro',
      license: { type: 'MIT', text: 'Fixture only' },
      authors: 'Fixture',
      source: { git: 'https://example.test/nitro.git', tag: '0.37.1' },
      platforms: { ios: '15.1' },
      source_files: 'stub.cpp',
      static_framework: true,
      pod_target_xcconfig: { DEFINES_MODULE: 'YES' },
    }),
  );
  fs.writeFileSync(
    path.join(directory, 'Podfile'),
    `
platform :ios, '15.1'
install! 'cocoapods', :integrate_targets => false
use_frameworks! :linkage => :static
target 'KernelFlagsFixture' do
  current_target_definition.swift_version = '5.9'
  pod 'xxHash', :path => ${JSON.stringify(ROOT)}
  pod 'NitroModules', :path => './NitroStub'
end
`,
  );
}

function installPods(directory, settings) {
  const result = run(
    pod,
    ['install', `--project-directory=${directory}`, '--no-repo-update', '--silent'],
    {
      env: environment(settings),
    },
  );
  assert(!`${result.stdout}\n${result.stderr}`.includes("Can't merge pod_target_xcconfig"));
}

function buildSettings(directory, configuration, settings = {}) {
  const args = [
    '-project',
    path.join(directory, 'Pods/Pods.xcodeproj'),
    '-scheme',
    'xxHash',
    '-configuration',
    configuration,
    '-sdk',
    'iphonesimulator',
    '-derivedDataPath',
    path.join(directory, 'DerivedData'),
    '-showBuildSettings',
    '-json',
  ];
  for (const [mode, value] of Object.entries(settings)) {
    args.push(`XXHASH_OPTIMIZE_${mode.toUpperCase()}=${value}`);
  }
  const output = JSON.parse(run('xcodebuild', args, { env: environment() }).stdout);
  const target = output.find((item) => item.target === 'xxHash');
  assert(target && !target.error, target?.error || 'Missing xxHash target settings');
  return target.buildSettings;
}

test(
  'CocoaPods applies source flags once and Xcode expands independent configuration opt-outs',
  {
    skip: !projectToolsAvailable,
  },
  () => {
    withTemporaryDirectory('nitro-xxhash-ios-flags-', (directory) => {
      createPodfile(directory);
      installPods(directory);
      const objects = JSON.parse(
        run('plutil', [
          '-convert',
          'json',
          '-o',
          '-',
          path.join(directory, 'Pods/Pods.xcodeproj/project.pbxproj'),
        ]).stdout,
      ).objects;
      const target = Object.values(objects).find(
        (item) => item.isa === 'PBXNativeTarget' && item.name === 'xxHash',
      );
      assert(target);
      const sources = target.buildPhases
        .map((uuid) => objects[uuid])
        .find((phase) => phase.isa === 'PBXSourcesBuildPhase')
        .files.map((uuid) => objects[uuid]);
      const actual = sources.map((source) => path.basename(objects[source.fileRef].path)).sort();
      const expected = [
        'xxHash-dummy.m',
        ...['cpp', 'nitrogen/generated/shared', 'nitrogen/generated/ios'].flatMap((base) =>
          filesUnder(path.join(ROOT, base), (file) => /\.(cpp|mm|m|swift)$/u.test(file)).map(
            (file) => path.basename(file),
          ),
        ),
      ].sort();
      assert.deepEqual(actual, expected, 'Every actual source must compile exactly once');
      for (const source of sources) {
        const name = path.basename(objects[source.fileRef].path);
        const flags = source.settings?.COMPILER_FLAGS || '';
        if (['FileDigest.cpp', 'Armv7Neon.cpp'].includes(name)) {
          assert.equal(flags, '$(XXHASH_DEBUG_KERNEL_FLAGS) $(XXHASH_RELEASE_KERNEL_FLAGS)', name);
        } else {
          assert(!flags.includes('XXHASH_') && !/-O[0-3sz]/u.test(flags), name);
        }
      }
      for (const configuration of ['Debug', 'Release']) {
        for (const overrides of [
          {},
          { debug: 'NO' },
          { release: 'NO' },
          { debug: 'NO', release: 'NO' },
        ]) {
          const settings = buildSettings(directory, configuration, overrides);
          for (const mode of ['Debug', 'Release']) {
            const expected =
              configuration === mode && overrides[mode.toLowerCase()] !== 'NO' ? '-O2' : '';
            assert.equal(settings[`XXHASH_${mode.toUpperCase()}_KERNEL_FLAGS`] || '', expected);
          }
          assert.equal(settings.CLANG_CXX_LANGUAGE_STANDARD, 'c++20');
          assert.equal(settings.DEFINES_MODULE, 'YES');
          if (configuration === 'Debug') {
            assert.equal(settings.GCC_OPTIMIZATION_LEVEL, '0');
            assert.equal(
              settings.DEBUGGING_SYMBOLS || settings.GCC_GENERATE_DEBUGGING_SYMBOLS,
              'YES',
            );
            assert(!String(settings.GCC_PREPROCESSOR_DEFINITIONS).includes('NDEBUG'));
          }
        }
      }
      installPods(directory, { debug: 'NO', release: 'NO' });
      assert.equal(buildSettings(directory, 'Debug').XXHASH_OPTIMIZE_DEBUG, 'NO');
      assert.equal(buildSettings(directory, 'Debug').XXHASH_DEBUG_KERNEL_FLAGS || '', '');
      assert.equal(
        buildSettings(directory, 'Debug', { debug: 'YES' }).XXHASH_DEBUG_KERNEL_FLAGS,
        '-O2',
      );
      assert.equal(buildSettings(directory, 'Release').XXHASH_OPTIMIZE_RELEASE, 'NO');
      assert.equal(buildSettings(directory, 'Release').XXHASH_RELEASE_KERNEL_FLAGS || '', '');
      assert.equal(
        buildSettings(directory, 'Release', { release: 'YES' }).XXHASH_RELEASE_KERNEL_FLAGS,
        '-O2',
      );
    });
  },
);
