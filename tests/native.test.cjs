const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { after, before, describe, test } = require('node:test');
const { ROOT, requiredExecutable, run } = require('../scripts/native-test-utils.cjs');

const vectors = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/vectors.json'), 'utf8'));
const backends = [
  ['simd', []],
  ['scalar', ['-DFILE_HASH_FORCE_SCALAR']],
  ['sanitized', ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']],
];

function pattern(size) {
  const bytes = Buffer.alloc(Number(size));
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + 17) % 256;
  return bytes;
}

describe('standalone native core behavior', { concurrency: false }, () => {
  let directory;
  const binaries = new Map();
  const stressBinaries = new Map();
  const cancellationBinaries = new Map();

  before(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'react-native-nitro-xxhash-'));
    const compiler = requiredExecutable('clang++');
    for (const [backend, flags] of backends) {
      const binary = path.join(directory, backend);
      const common = [
        '-std=c++20',
        '-O3',
        '-Wall',
        '-Wextra',
        '-Werror',
        ...flags,
        '-I',
        path.join(ROOT, 'cpp'),
      ];
      run(compiler, [
        ...common,
        path.join(ROOT, 'cpp/FileDigest.cpp'),
        path.join(ROOT, 'cpp/FilePath.cpp'),
        path.join(ROOT, 'tests/digest-cli.cpp'),
        '-o',
        binary,
      ]);
      binaries.set(backend, binary);
      const stressBinary = path.join(directory, `${backend}-stress`);
      run(compiler, [
        ...common,
        '-pthread',
        path.join(ROOT, 'cpp/FilePath.cpp'),
        path.join(ROOT, 'tests/native-stress.cpp'),
        '-o',
        stressBinary,
      ]);
      stressBinaries.set(backend, stressBinary);
      const cancellationBinary = path.join(directory, `${backend}-cancel`);
      run(compiler, [
        ...common,
        '-pthread',
        path.join(ROOT, 'cpp/FilePath.cpp'),
        path.join(ROOT, 'tests/file-cancel.cpp'),
        '-o',
        cancellationBinary,
      ]);
      cancellationBinaries.set(backend, cancellationBinary);
    }
  });

  after(() => {
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  });

  function checkDigest(mode, width, input, expected) {
    for (const [backend, binary] of binaries) {
      const result = run(binary, [mode, width, input]);
      assert.equal(result.stdout.trim(), expected, `${backend}/${mode}/${width}/${input}`);
    }
  }

  test('pattern vectors preserve bytes, alignment and absolute/local file URI semantics', () => {
    for (const [size, hashes] of Object.entries(vectors.vectors)) {
      const file = path.join(directory, `модель % #${size}.bin`);
      fs.writeFileSync(file, pattern(size));
      for (const [width, expected] of Object.entries(hashes)) {
        checkDigest('bytes', width, file, expected);
        checkDigest('unaligned', width, file, expected);
        const uri = pathToFileURL(file).href;
        for (const input of [file, uri, uri.replace('file:///', 'file://localhost/')])
          checkDigest('file', width, input, expected);
      }
    }
  });

  test('UTF-8, embedded NUL and Unicode vectors agree across strings, bytes and files', () => {
    for (const [index, vector] of vectors.strings.entries()) {
      const file = path.join(directory, `string-${index}.bin`);
      fs.writeFileSync(file, Buffer.from(vector.utf8, 'hex'));
      for (const width of ['64', '128']) {
        for (const mode of ['bytes', 'string', 'file'])
          checkDigest(mode, width, file, vector[width]);
      }
    }
  });

  test('invalid paths, authorities, escapes, directories and FIFOs reject without blocking', () => {
    const fifo = path.join(directory, 'fifo');
    run(requiredExecutable('mkfifo'), [fifo]);
    const invalid = [
      '',
      'relative.bin',
      'https://example.com/a',
      'content://media/file',
      'file://remote/a',
      'file:///tmp/%',
      'file:///tmp/%GG',
      'file:///tmp/%00',
      'file:///tmp/a?b',
      'file:///tmp/a#b',
      directory,
      path.join(directory, 'missing'),
      fifo,
    ];
    for (const [backend, binary] of binaries) {
      for (const width of ['64', '128']) {
        for (const uri of invalid) {
          const result = run(binary, ['file', width, uri], { expectedStatus: 1, timeout: 5000 });
          assert(result.stderr, `${backend}/${width}/${uri} must report a rejection`);
        }
      }
    }
  });

  test('cancellation stops before open, after bounded reads and at EOF without leaking descriptors', () => {
    const file = path.join(directory, 'cancellation.bin');
    fs.writeFileSync(file, pattern(3 * 64 * 1024 + 17));
    for (const [backend, binary] of cancellationBinaries) {
      const result = run(binary, [file], { timeout: 60000 });
      assert.match(result.stdout, /Verified cancellation boundaries and in-flight cleanup:/);
      console.log(`${backend}: ${result.stdout.trim()}`);
    }
  });

  test('repeated concurrent hashing preserves golden values and closes file descriptors', () => {
    const arguments_ = [directory];
    for (const size of [0, 1, 240, 241, 65537, 131073, 1048577]) {
      const file = path.join(directory, `stress-${size}.bin`);
      fs.writeFileSync(file, pattern(size));
      const expected = vectors.vectors[String(size)];
      arguments_.push(file, expected['64'], expected['128']);
    }
    for (const [backend, binary] of stressBinaries) {
      const report = JSON.parse(run(binary, arguments_, { timeout: 60000 }).stdout);
      assert.equal(report.checks, 10240, `${backend}: stress checks`);
      assert.equal(report.workers, 8, `${backend}: concurrent workers`);
      assert.equal(
        report.descriptorsAfter,
        report.descriptorsBefore,
        `${backend}: descriptor leak`,
      );
      console.log(`${backend} stress: ${JSON.stringify(report)}`);
    }
  });
});
