// Compile package C++/ObjC++ sources and repaired Nitro units with installed headers.
const fs = require('node:fs');
const path = require('node:path');
const {
  ROOT,
  directoriesUnder,
  filesUnder,
  run,
  withTemporaryDirectory,
} = require('./native-test-utils.cjs');

const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules');
const reactNative = path.join(ROOT, 'node_modules/react-native');
const deploymentTarget = process.env.IOS_DEPLOYMENT_TARGET || '15.1';
if (!/^\d+\.\d+(?:\.\d+)?$/.test(deploymentTarget))
  throw new Error('IOS_DEPLOYMENT_TARGET must be an iOS version such as 15.1.');

function main() {
  if (!fs.existsSync(path.join(nitro, 'cpp')) || !fs.existsSync(reactNative))
    throw new Error('Run npm ci before checking iOS sources.');
  run('pod', ['ipc', 'spec', path.join(ROOT, 'xxHash.podspec')], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  withTemporaryDirectory('nitro-xxhash-ios-', (directory) => {
    const include = path.join(directory, 'headers/NitroModules');
    fs.mkdirSync(include, { recursive: true });
    for (const base of [path.join(nitro, 'cpp'), path.join(nitro, 'ios')]) {
      for (const header of filesUnder(base, (file) => file.endsWith('.hpp'))) {
        const target = path.join(include, path.basename(header));
        if (!fs.existsSync(target)) fs.symlinkSync(header, target);
      }
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
    for (const base of [path.join(nitro, 'cpp'), path.join(nitro, 'ios')]) {
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
      for (const source of sources) {
        run(
          'xcrun',
          [
            '--sdk',
            sdk,
            'clang++',
            '-target',
            target,
            '-isysroot',
            sdkPath,
            ...common,
            '-c',
            source,
            '-o',
            path.join(output, `${path.basename(source)}.o`),
          ],
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

main();
