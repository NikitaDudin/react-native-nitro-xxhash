// Compile package C++/ObjC++ sources and repaired Nitro units with installed headers.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, directoriesUnder, run, withTemporaryDirectory } = require('./native-test-utils.cjs');

const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules');
const reactNative = path.join(ROOT, 'node_modules/react-native');
const deploymentTarget = process.env.IOS_DEPLOYMENT_TARGET || '15.1';
if (!/^\d+\.\d+(?:\.\d+)?$/.test(deploymentTarget))
  throw new Error('IOS_DEPLOYMENT_TARGET must be an iOS version such as 15.1.');

function validatePodspecSourceLayout(podspec) {
  const kernels = ['cpp/Armv7Neon.cpp', 'cpp/FileDigest.cpp'];
  assert(!podspec.source_files, 'Root sources would inherit kernel compiler flags');
  assert(!podspec.exclude_files, 'Root exclusions would also remove kernel sources');
  assert(!podspec.compiler_flags, 'Root compiler flags would affect every source');
  assert.equal(podspec.default_subspecs, 'Core');
  const core = podspec.subspecs?.find((spec) => spec.name === 'Core');
  const kernel = podspec.subspecs?.find((spec) => spec.name === 'Kernels');
  assert(core && kernel, 'Core and Kernels subspecs are required');
  assert.deepEqual([...kernel.source_files].sort(), kernels);
  assert.deepEqual([...core.exclude_files].sort(), kernels);
  assert(core.dependencies?.['xxHash/Kernels'], 'Core must include the kernel subspec');
  assert(core.dependencies?.NitroModules, 'Core must retain Nitrogen native dependencies');
  assert(!core.compiler_flags, 'Core wrappers must retain their build configuration flags');
  assert.equal(
    kernel.compiler_flags,
    '$(XXHASH_DEBUG_KERNEL_FLAGS) $(XXHASH_RELEASE_KERNEL_FLAGS)',
  );
  const settings = podspec.pod_target_xcconfig;
  assert(
    !String(settings?.HEADER_SEARCH_PATHS || '').includes('Headers/Private'),
    'Use Nitro public headers instead of private header search paths',
  );
  for (const configuration of ['Debug', 'Release']) {
    const mode = configuration.toUpperCase();
    const prefix = `XXHASH_${mode}_KERNEL_FLAGS`;
    assert(['YES', 'NO'].includes(settings?.[`XXHASH_OPTIMIZE_${mode}`]));
    assert.equal(settings[prefix], `$(${prefix}_$(CONFIGURATION)_$(XXHASH_OPTIMIZE_${mode}))`);
    for (const target of ['Debug', 'Release']) {
      assert.equal(settings[`${prefix}_${target}_YES`], target === configuration ? '-O2' : '');
      assert.equal(settings[`${prefix}_${target}_NO`], '');
    }
  }
  for (const key of ['CLANG_CXX_LANGUAGE_STANDARD', 'DEFINES_MODULE']) {
    assert(!core.pod_target_xcconfig?.[key], `Do not duplicate inherited ${key}`);
  }
  return kernels;
}

function main() {
  if (!fs.existsSync(path.join(nitro, 'cpp')) || !fs.existsSync(reactNative))
    throw new Error('Run npm ci before checking iOS sources.');
  const podspec = JSON.parse(
    run('pod', ['ipc', 'spec', path.join(ROOT, 'xxHash.podspec'), '--silent']).stdout,
  );
  validatePodspecSourceLayout(podspec);
  withTemporaryDirectory('nitro-xxhash-ios-', (directory) => {
    const include = path.join(directory, 'headers/NitroModules');
    fs.mkdirSync(include, { recursive: true });
    // Load the dependency's actual podspec with the same RN helpers as a host
    // Podfile. Only its declared public headers may satisfy prefixed imports.
    const dependencySpec = path.join(directory, 'NitroModules.podspec');
    fs.writeFileSync(
      dependencySpec,
      `require ${JSON.stringify(path.join(reactNative, 'scripts/react_native_pods.rb'))}\n` +
        `Pod::Specification.from_file(${JSON.stringify(path.join(nitro, 'NitroModules.podspec'))})\n`,
    );
    const nitroPodspec = JSON.parse(run('pod', ['ipc', 'spec', dependencySpec, '--silent']).stdout);
    assert.equal(nitroPodspec.version, '0.37.2');
    const publicHeaders = nitroPodspec.public_header_files;
    assert(Array.isArray(publicHeaders));
    assert(publicHeaders.includes('cpp/core/threading/ThreadPool.hpp'));
    for (const header of publicHeaders) {
      assert(!/[{}*?]/u.test(header), `Resolve new Nitro header glob explicitly: ${header}`);
      const target = path.join(include, path.basename(header));
      assert(!fs.existsSync(target), `Duplicate Nitro public header: ${header}`);
      fs.symlinkSync(path.join(nitro, header), target);
    }
    const common = [
      '-std=c++20',
      '-O2',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      path.dirname(include),
      '-I',
      path.join(ROOT, 'cpp'),
      '-I',
      path.join(ROOT, 'nitrogen/generated/shared/c++'),
      '-I',
      path.join(ROOT, 'nitrogen/generated/ios'),
      '-I',
      path.join(reactNative, 'ReactCommon/jsi'),
    ];
    for (const base of [path.join(nitro, 'cpp'), path.join(nitro, 'apple')]) {
      for (const candidate of directoriesUnder(base)) common.push('-I', candidate);
    }
    const sources = [];
    for (const [base, extensions] of [
      ['cpp', ['.cpp']],
      ['nitrogen/generated/shared/c++', ['.cpp']],
      ['nitrogen/generated/ios', ['.cpp', '.mm']],
    ]) {
      const absolute = path.join(ROOT, base);
      for (const source of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (source.isFile() && extensions.includes(path.extname(source.name)))
          sources.push(path.join(absolute, source.name));
      }
    }
    sources.sort();
    const packageSourceCount = sources.length;
    // The explicit repair also changes compiled Nitro code. Header-only checks
    // cannot validate that code for either deployment target.
    const repairs = require('../compat/patches.json');
    const repairedSources = [...new Set(repairs.targets.map((entry) => entry.path))].filter(
      (file) => file.startsWith('cpp/') && file.endsWith('.cpp'),
    );
    for (const source of repairedSources) sources.push(path.join(nitro, source));
    const targets = [
      ['iphoneos', `arm64-apple-ios${deploymentTarget}`],
      ['iphonesimulator', `arm64-apple-ios${deploymentTarget}-simulator`],
    ];
    for (const [sdk, target] of targets) {
      const sdkPath = run('xcrun', ['--sdk', sdk, '--show-sdk-path']).stdout.trim();
      const output = path.join(directory, sdk);
      fs.mkdirSync(output);
      const compiler = [
        '--sdk',
        sdk,
        'clang++',
        '-target',
        target,
        '-isysroot',
        sdkPath,
        ...common,
      ];
      // A missing public declaration must break the real prefixed import. This
      // prevents a broad synthetic map from hiding future dependency regressions.
      const threadPoolHeader = path.join(include, 'ThreadPool.hpp');
      fs.unlinkSync(threadPoolHeader);
      const missingPublicHeader = run(
        'xcrun',
        [...compiler, '-fsyntax-only', path.join(ROOT, 'cpp/FileHashExecutor.cpp')],
        { expectedStatus: 1 },
      );
      if (!missingPublicHeader.stderr.includes("'NitroModules/ThreadPool.hpp' file not found"))
        throw new Error(
          `Public ThreadPool header regression did not reproduce:\n${missingPublicHeader.stderr}`,
        );
      fs.symlinkSync(path.join(nitro, 'cpp/core/threading/ThreadPool.hpp'), threadPoolHeader);
      for (const source of sources) {
        run(
          'xcrun',
          [...compiler, '-c', source, '-o', path.join(output, `${path.basename(source)}.o`)],
          { stdio: 'inherit' },
        );
      }
      console.log(
        `${sdk}: ${packageSourceCount} package and ${repairedSources.length} repaired Nitro C++/Objective-C++ sources compiled at deployment target ${deploymentTarget}`,
      );
    }
    console.log(
      'Podspec and source compilation passed; full pod linking, Swift interop and device execution are separate checks.',
    );
  });
}

if (require.main === module) main();
module.exports = { validatePodspecSourceLayout };
