const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { sourceManifest, verifySourceManifest } = require('./source-manifest.cjs');

function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-source-manifest-'));
  try {
    fs.mkdirSync(path.join(directory, 'src/nested'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'index.ts'), 'a');
    fs.writeFileSync(path.join(directory, 'src/z.ts'), 'b');
    fs.writeFileSync(path.join(directory, 'src/nested/a.ts'), 'a');
    return run(directory, ['index.ts', 'src']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('source manifests preserve scope ordering and sort nested paths deterministically', () => {
  fixture((root, scopes) => {
    const before = sourceManifest(root, scopes);
    assert.deepEqual(
      before.map((entry) => entry.file),
      ['index.ts', 'src/nested/a.ts', 'src/z.ts'],
    );
    assert.equal(
      before[0].sha256,
      'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    );
    assert.doesNotThrow(() => verifySourceManifest(root, scopes, before, 'Production source'));
  });
});

for (const [name, mutate] of [
  ['changed file', (root) => fs.writeFileSync(path.join(root, 'src/z.ts'), 'changed')],
  ['new nested file', (root) => fs.writeFileSync(path.join(root, 'src/nested/new.ts'), 'new')],
  ['removed nested file', (root) => fs.unlinkSync(path.join(root, 'src/nested/a.ts'))],
  ['removed explicit scope', (root) => fs.unlinkSync(path.join(root, 'index.ts'))],
]) {
  test(`source verification rejects a ${name}`, () => {
    fixture((root, scopes) => {
      const before = sourceManifest(root, scopes);
      mutate(root);
      assert.throws(
        () => verifySourceManifest(root, scopes, before, 'Production source'),
        /Production source changed during measurement/,
      );
    });
  });
}

test('benchmark identity stays tied to the initial code instead of post-run contents', () => {
  fixture((root) => {
    fs.mkdirSync(path.join(root, 'benchmark'));
    const suite = path.join(root, 'benchmark/suite.cjs');
    fs.writeFileSync(suite, 'module.exports = () => 1;');
    const before = sourceManifest(root, ['benchmark']);
    const initialHash = before[0].sha256;
    fs.writeFileSync(suite, 'module.exports = () => 2;');
    assert.equal(before[0].sha256, initialHash);
    assert.notEqual(sourceManifest(root, ['benchmark'])[0].sha256, initialHash);
    assert.throws(
      () => verifySourceManifest(root, ['benchmark'], before, 'Benchmark source'),
      /Benchmark source changed during measurement/,
    );
  });
});
