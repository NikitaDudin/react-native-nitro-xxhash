// Verify Nitro's upstream Swift/C++ exception fix against disposable negative controls.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, directoriesUnder, run, withTemporaryDirectory } = require('./native-test-utils.cjs');

const offending = ['__from_native_exception_pointer', '__cxa_init_primary_exception'];
const deploymentTarget = process.env.IOS_DEPLOYMENT_TARGET || '15.1';
if (!/^\d+\.\d+(?:\.\d+)?$/.test(deploymentTarget))
  throw new Error('IOS_DEPLOYMENT_TARGET must be an iOS version such as 15.1.');

// These two upstream helpers must stay fixed independently of the local runtime
// repairs. Reintroduce only the former exception_ptr implementation in a copy.
const negativeControls = [
  {
    path: 'apple/core/utils/RuntimeError.hpp',
    fixed:
      '  try {\n    throw std::runtime_error(message);\n  } catch (...) {\n' +
      '    return std::current_exception();\n  }',
    broken: '  return std::make_exception_ptr(std::runtime_error(message));',
  },
  {
    path: 'cpp/core/core/Promise.hpp',
    fixed:
      '      try {\n        throw std::runtime_error(message);\n      } catch (...) {\n' +
      '        reject(std::current_exception());\n      }',
    broken: '      reject(std::make_exception_ptr(std::runtime_error(message)));',
  },
];

function main() {
  const source = path.join(ROOT, 'node_modules/react-native-nitro-modules');
  const react = path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi');
  if (!fs.existsSync(source) || !fs.existsSync(react))
    throw new Error('Run npm ci before checking the upstream compatibility fix.');
  const installed = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  assert.equal(installed.version, '0.37.2', 'This regression fixture requires Nitro 0.37.2');
  withTemporaryDirectory('nitro-ios-compat-', (root) => {
    const nitro = path.join(root, 'nitro');
    fs.cpSync(source, nitro, {
      recursive: true,
      dereference: true,
      // Keep Node 24's unfiltered copy from preserving writable source symlinks.
      filter: () => true,
    });
    const fixedSources = new Map();
    for (const control of negativeControls) {
      const contents = fs.readFileSync(path.join(nitro, control.path), 'utf8');
      assert.equal(
        contents.split(control.fixed).length,
        2,
        `Unknown upstream helper: ${control.path}`,
      );
      assert(
        !contents.includes(control.broken),
        `Upstream exception repair is missing: ${control.path}`,
      );
      fixedSources.set(control.path, contents);
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
    for (const base of [path.join(nitro, 'cpp'), path.join(nitro, 'apple')]) {
      for (const directory of directoriesUnder(base)) includes.push('-Xcc', `-I${directory}`);
    }
    const targets = [
      ['iphoneos', `arm64-apple-ios${deploymentTarget}`],
      ['iphonesimulator', `arm64-apple-ios${deploymentTarget}-simulator`],
    ];
    for (const phase of ['negative-control', 'upstream-fixed']) {
      for (const control of negativeControls) {
        const contents = fixedSources.get(control.path);
        fs.writeFileSync(
          path.join(nitro, control.path),
          phase === 'negative-control'
            ? contents.replace(control.fixed, () => control.broken)
            : contents,
        );
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
            path.join(nitro, 'apple/core/core/RuntimeError.swift'),
            path.join(root, 'PromiseCheck.swift'),
          ],
          { cwd: output, stdio: 'inherit' },
        );
        for (const name of ['RuntimeError.o', 'PromiseCheck.o']) {
          const symbols = run('xcrun', ['nm', '-u', path.join(output, name)]).stdout;
          for (const symbol of offending) {
            const present = symbols.includes(symbol);
            if (present !== (phase === 'negative-control'))
              throw new Error(
                `${phase}/${sdk}/${name}: unexpected import state for ${symbol}; ` +
                  'the compiler may no longer reproduce the regression.',
              );
          }
        }
        console.log(
          `${sdk}/${phase}: actual Nitro RuntimeError.swift and Promise<double> ` +
            `imports ${phase === 'negative-control' ? 'reproduced' : 'removed'}`,
        );
      }
    }
    console.log(
      'Upstream exception regression passed without changing installed Nitro. ' +
        'This check compiles Swift objects; application launch is separate.',
    );
  });
}

main();
