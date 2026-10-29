const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('real Nitro and JSI buffers preserve exact native byte ranges', () => {
  const compiler = requiredExecutable('clang++');
  const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules/cpp');
  const jsi = path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi');
  withTemporaryDirectory('nitro-xxhash-buffer-ranges-', (directory) => {
    const headers = path.join(directory, 'NitroModules');
    fs.mkdirSync(headers);
    const directories = nitroHeaderMap(nitro, headers);
    const includes = ['-I', directory, '-I', path.join(ROOT, 'cpp'), '-I', jsi];
    for (const include of directories) includes.push('-I', include);
    const sources = [
      path.join(ROOT, 'cpp/FileDigest.cpp'),
      path.join(ROOT, 'cpp/FilePath.cpp'),
      path.join(nitro, 'core/ArrayBuffer.cpp'),
      path.join(jsi, 'jsi/jsi.cpp'),
      path.join(ROOT, 'tests/buffer-ranges.cpp'),
    ];
    for (const [backend, flags] of [
      ['simd', []],
      ['scalar', ['-DFILE_HASH_FORCE_SCALAR']],
      ['sanitized', ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']],
    ]) {
      const binary = path.join(directory, backend);
      run(compiler, [
        '-std=c++20',
        '-O2',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-Wno-unused-parameter',
        '-pthread',
        ...flags,
        ...includes,
        ...sources,
        '-o',
        binary,
      ]);
      const result = run(binary, [], { timeout: 20000 });
      assert(result.stdout.includes('native buffer range checks'), `${backend}: range report`);
      console.log(`${backend}: ${result.stdout.trim()}`);
    }
  });
});
