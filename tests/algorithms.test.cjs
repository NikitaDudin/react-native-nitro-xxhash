const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, test } = require('node:test');
const { ROOT, requiredExecutable, run } = require('../scripts/native-test-utils.cjs');

const vectors = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'tests/algorithm-vectors.json'), 'utf8'),
).vectors;
const original = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/vectors.json'), 'utf8'));
const backends = [
  ['simd', []],
  ['scalar', ['-DFILE_HASH_FORCE_SCALAR']],
  ['sanitized', ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']],
];

describe(
  'independent seeded algorithm vectors and streaming states',
  { concurrency: false },
  () => {
    let directory;
    const fixtures = new Map();
    const binaries = new Map();

    before(() => {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-xxhash-algorithms-'));
      for (const name of Object.keys(vectors.xxh32['0'])) {
        const file = path.join(directory, `${name}.bin`);
        let data;
        if (name.startsWith('string-')) {
          data = Buffer.from(original.strings[Number(name.slice(7))].utf8, 'hex');
        } else {
          data = Buffer.alloc(Number(name));
          for (let index = 0; index < data.length; index += 1)
            data[index] = (index * 131 + 17) % 256;
        }
        fs.writeFileSync(file, data);
        fixtures.set(name, file);
      }
      const compiler = requiredExecutable('clang++');
      for (const [backend, flags] of backends) {
        const binary = path.join(directory, backend);
        run(compiler, [
          '-std=c++20',
          '-O3',
          '-Wall',
          '-Wextra',
          '-Werror',
          ...flags,
          '-I',
          path.join(ROOT, 'cpp'),
          path.join(ROOT, 'cpp/FileDigest.cpp'),
          path.join(ROOT, 'cpp/FilePath.cpp'),
          path.join(ROOT, 'tests/algorithms-cli.cpp'),
          '-o',
          binary,
        ]);
        binaries.set(backend, binary);
      }
    });

    after(() => {
      if (directory) fs.rmSync(directory, { recursive: true, force: true });
    });

    test('all pinned independent seeds verify one-shot hashes and streaming lifecycle', () => {
      for (const [backend, binary] of binaries) {
        let checked = 0;
        for (const [algorithm, seeds] of Object.entries(vectors)) {
          for (const [seed, values] of Object.entries(seeds)) {
            for (const [fixture, expected] of Object.entries(values)) {
              const result = run(binary, [algorithm, seed, fixtures.get(fixture), expected], {
                timeout: 15000,
              });
              assert.equal(
                result.stdout.trim(),
                'ok',
                `${backend}/${algorithm}/${seed}/${fixture}`,
              );
              checked += 1;
            }
          }
        }
        console.log(
          `${backend}: ${checked} seeded vectors, one-shot and streaming lifecycle and independent state clones verified`,
        );
      }
    });

    test('invalid seeds and failed reset recover without changing the stream state', () => {
      for (const [backend, binary] of binaries) {
        const result = run(binary, [], { timeout: 15000 });
        assert.equal(result.stdout.trim(), 'seed-validation-ok', `${backend}: seed validation`);
      }
    });
  },
);
