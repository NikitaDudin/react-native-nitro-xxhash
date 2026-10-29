const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  filesUnder,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('native implementations and generated bindings compile against real Nitro/RN headers', () => {
  const compiler = requiredExecutable('clang++');
  const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules/cpp');
  const reactCommon = path.join(ROOT, 'node_modules/react-native/ReactCommon');
  const generated = path.join(ROOT, 'nitrogen/generated/shared/c++');
  for (const file of [
    path.join(nitro, 'core/HybridObject.hpp'),
    path.join(reactCommon, 'jsi/jsi/jsi.h'),
    path.join(reactCommon, 'callinvoker/ReactCommon/CallInvoker.h'),
    path.join(generated, 'HybridFileHasherSpec.cpp'),
    path.join(generated, 'HybridHashStateSpec.cpp'),
    path.join(generated, 'HybridHashFileTaskSpec.cpp'),
  ]) {
    assert(
      fs.existsSync(file) && fs.statSync(file).isFile(),
      `Missing ${file}; run npm ci and npm run specs first`,
    );
  }
  withTemporaryDirectory('nitro-xxhash-bindings-', (temporary) => {
    const include = path.join(temporary, 'NitroModules');
    fs.mkdirSync(include);
    // Reproduce Nitro's flattened public include map using real dependency headers.
    const directories = nitroHeaderMap(nitro, include);
    const arguments_ = [
      '-std=c++20',
      '-fsyntax-only',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-Wno-unused-parameter',
      '-Wno-dollar-in-identifier-extension',
      '-I',
      temporary,
      '-I',
      path.join(reactCommon, 'jsi'),
      '-I',
      path.join(reactCommon, 'callinvoker'),
      '-I',
      path.join(ROOT, 'cpp'),
      '-I',
      generated,
    ];
    for (const directory of directories) arguments_.push('-I', directory);
    const sources = [
      ...filesUnder(generated, (file) => path.dirname(file) === generated && file.endsWith('.cpp')),
      ...filesUnder(
        path.join(ROOT, 'cpp'),
        (file) =>
          path.dirname(file) === path.join(ROOT, 'cpp') &&
          /^(Hybrid.*|FileHashExecutor)\.cpp$/.test(path.basename(file)),
      ),
    ];
    run(compiler, [...arguments_, ...sources], { stdio: 'inherit' });
    console.log(`Native Nitro bindings syntax check passed: ${sources.length} source files`);
  });
});
