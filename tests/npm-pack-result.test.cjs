const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseNpmPackResult } = require('../scripts/npm-pack-result.cjs');

const name = 'react-native-nitro-xxhash';
const tarball = {
  name,
  version: '0.1.0',
  filename: `${name}-0.1.0.tgz`,
  files: [{ path: 'package.json', mode: 0o644 }],
};

test('reads the npm 10/11 pack result array', () => {
  assert.deepEqual(parseNpmPackResult(JSON.stringify([tarball]), name), tarball);
});

test('reads the npm 12 pack result keyed by package name', () => {
  assert.deepEqual(parseNpmPackResult(JSON.stringify({ [name]: tarball }), name), tarball);
});

test('rejects empty or ambiguous npm pack results', () => {
  for (const result of [null, [], {}, [tarball, tarball], { first: tarball, second: tarball }])
    assert.throws(() => parseNpmPackResult(JSON.stringify(result), name), /exactly one package/);
});

test('rejects a different package instead of validating the wrong archive', () => {
  const other = { ...tarball, name: 'another-package' };
  for (const result of [[other], { 'another-package': other }])
    assert.throws(() => parseNpmPackResult(JSON.stringify(result), name), /unexpected package/);
});

test('requires the filename and file list consumed by package checks', () => {
  for (const filename of [undefined, null, '', 123])
    assert.throws(
      () => parseNpmPackResult(JSON.stringify([{ ...tarball, filename }]), name),
      /tarball filename/,
    );
  assert.throws(
    () => parseNpmPackResult(JSON.stringify([{ ...tarball, files: null }]), name),
    /archive contents/,
  );
});

test('rejects invalid JSON output', () => {
  assert.throws(() => parseNpmPackResult('not JSON', name), SyntaxError);
});
