const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('dedicated file workers remain independent of the shared Nitro pool', () => {
  withTemporaryDirectory('nitro-xxhash-file-executor-', (work) => {
    const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules/cpp');
    const includes = nitroHeaderMap(nitro, path.join(work, 'NitroModules'));
    for (const sanitizer of [[], ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']]) {
      const binary = path.join(work, sanitizer.length ? 'sanitized' : 'release');
      run(requiredExecutable('clang++'), [
        '-std=c++20',
        '-O2',
        '-DNDEBUG',
        '-pthread',
        ...sanitizer,
        '-I',
        work,
        '-I',
        path.join(ROOT, 'cpp'),
        '-I',
        path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi'),
        ...includes.flatMap((directory) => ['-I', directory]),
        path.join(ROOT, 'cpp/FileHashExecutor.cpp'),
        path.join(nitro, 'threading/ThreadPool.cpp'),
        path.join(nitro, 'utils/NitroTypeInfo.cpp'),
        path.join(ROOT, 'tests/native/file-executor/main.cpp'),
        '-o',
        binary,
      ]);
      console.log(run(binary, [], { timeout: 15000 }).stdout.trim());
    }
  });
});
