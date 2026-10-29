const assert = require('node:assert/strict');

function parseNpmPackResult(stdout, packageName) {
  const result = JSON.parse(stdout);
  // npm 12 keys results by package name; earlier npm versions return an array.
  const tarballs = Array.isArray(result) ? result : Object.values(result ?? {});
  assert.equal(tarballs.length, 1, 'npm pack must report exactly one package');
  const [tarball] = tarballs;
  assert.equal(tarball?.name, packageName, 'npm pack returned an unexpected package');
  assert(
    typeof tarball.filename === 'string' && tarball.filename.length > 0,
    'npm pack did not report a tarball filename',
  );
  assert(Array.isArray(tarball.files), 'npm pack did not report archive contents');
  return tarball;
}

module.exports = { parseNpmPackResult };
