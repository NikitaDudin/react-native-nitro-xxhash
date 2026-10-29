// Reproduce Nitro's Swift/C++ import regression, then verify the shipped backport.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, directoriesUnder, run, withTemporaryDirectory } = require('./native-test-utils.cjs');

const offending = ['__from_native_exception_pointer', '__cxa_init_primary_exception'];
const deploymentTarget = process.env.IOS_DEPLOYMENT_TARGET || '15.1';
if (!/^\d+\.\d+(?:\.\d+)?$/.test(deploymentTarget))
  throw new Error('IOS_DEPLOYMENT_TARGET must be an iOS version such as 15.1.');

function main() {
  const source = path.join(ROOT, 'node_modules/react-native-nitro-modules');
  const react = path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi');
  if (!fs.existsSync(source) || !fs.existsSync(react))
    throw new Error('Run npm ci before checking the compatibility backport.');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'compat/patches.json'), 'utf8'));
  const installed = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (installed.version !== manifest.package.version)
    throw new Error('This regression fixture requires Nitro 0.37.1.');
  withTemporaryDirectory('nitro-ios-compat-', (root) => {
    const nitro = path.join(root, 'nitro');
    fs.cpSync(source, nitro, {
      recursive: true,
      dereference: true,
      // Keep Node 24's unfiltered copy from preserving writable source symlinks.
      filter: () => true,
    });
    // Reconstruct only known upstream snippets in the disposable copy, including
    // when a maintainer has already opted into the local backport.
    for (const target of manifest.targets) {
      const file = path.join(nitro, target.path);
      let contents = fs.readFileSync(file, 'utf8');
      if (contents.split(target.patched).length === 2)
        contents = contents.replace(target.patched, () => target.original);
      if (contents.split(target.original).length !== 2)
        throw new Error(`Unexpected Nitro source: ${target.path}`);
      fs.writeFileSync(file, contents);
    }
    fs.writeFileSync(
      path.join(root, 'Probe.hpp'),
      `#pragma once
#include "RuntimeError.hpp"
#include "Promise.hpp"
namespace NitroCompatibilityProbe {
inline std::string destroyPendingPromise() {
  std::string message;
  {
    auto promise = margelo::nitro::Promise<double>::create();
    promise->addOnRejectedListener([&message](const std::exception_ptr& error) {
      message = margelo::nitro::getExceptionMessage(error);
    });
  }
  return message;
}
}
`,
    );
    fs.writeFileSync(
      path.join(root, 'module.modulemap'),
      'module NitroModules { requires cplusplus header "Probe.hpp" export * }\n',
    );
    fs.writeFileSync(
      path.join(root, 'PromiseCheck.swift'),
      `public func destroyPendingNumberPromise() -> String {
  return String(NitroCompatibilityProbe.destroyPendingPromise())
}
`,
    );
    const includes = ['-Xcc', `-I${react}`];
    for (const base of [path.join(nitro, 'cpp'), path.join(nitro, 'ios')]) {
      for (const directory of directoriesUnder(base)) includes.push('-Xcc', `-I${directory}`);
    }
    const cli = [path.join(ROOT, 'compat/cli.cjs'), '--nitro-path', nitro];
    const targets = [
      ['iphoneos', `arm64-apple-ios${deploymentTarget}`],
      ['iphonesimulator', `arm64-apple-ios${deploymentTarget}-simulator`],
    ];
    for (const phase of ['unpatched', 'patched']) {
      if (phase === 'patched') {
        run(process.execPath, cli, { stdio: 'inherit' });
        run(process.execPath, [...cli, '--check'], { stdio: 'inherit' });
      }
      for (const [sdk, target] of targets) {
        const output = path.join(root, `${phase}-${sdk}`);
        fs.mkdirSync(output);
        const sdkPath = run('xcrun', ['--sdk', sdk, '--show-sdk-path']).stdout.trim();
        run(
          'xcrun',
          [
            '--sdk',
            sdk,
            'swiftc',
            '-sdk',
            sdkPath,
            '-target',
            target,
            '-module-name',
            'NitroModules',
            '-import-underlying-module',
            '-I',
            root,
            '-cxx-interoperability-mode=default',
            '-Xcc',
            '-std=c++20',
            '-module-cache-path',
            path.join(output, 'cache'),
            '-sdk-module-cache-path',
            path.join(output, 'sdk-cache'),
            '-explicit-module-build',
            ...includes,
            '-c',
            path.join(nitro, 'ios/core/RuntimeError.swift'),
            path.join(root, 'PromiseCheck.swift'),
          ],
          { cwd: output, stdio: 'inherit' },
        );
        for (const name of ['RuntimeError.o', 'PromiseCheck.o']) {
          const symbols = run('xcrun', ['nm', '-u', path.join(output, name)]).stdout;
          for (const symbol of offending) {
            const present = symbols.includes(symbol);
            if (present !== (phase === 'unpatched'))
              throw new Error(
                `${phase}/${sdk}/${name}: unexpected import state for ${symbol}; ` +
                  'the compiler may no longer reproduce the regression.',
              );
          }
        }
        console.log(
          `${sdk}/${phase}: actual Nitro RuntimeError.swift and Promise<double> ` +
            `imports ${phase === 'unpatched' ? 'reproduced' : 'removed'}`,
        );
      }
    }
    console.log(
      'Backport regression passed without changing installed Nitro. ' +
        'This check compiles Swift objects; application launch is separate.',
    );
  });
}

main();
