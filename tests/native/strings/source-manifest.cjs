const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { filesUnder } = require('../../../scripts/native-test-utils.cjs');

/** Keep scope order and sort each scope, preserving the recorded tree-hash convention. */
function sourceManifest(root, scopes) {
  const entries = [];
  for (const scope of scopes) {
    const absolute = path.resolve(root, scope);
    const files = statSync(absolute).isDirectory() ? filesUnder(absolute) : [absolute];
    for (const file of files) {
      entries.push({
        file: path.relative(root, file).split(path.sep).join('/'),
        sha256: createHash('sha256').update(readFileSync(file)).digest('hex'),
      });
    }
  }
  return entries;
}

/** Re-enumerate the scopes so new or removed files cannot escape verification. */
function verifySourceManifest(root, scopes, expected, label) {
  let actual;
  try {
    actual = sourceManifest(root, scopes);
  } catch (cause) {
    throw new Error(`${label} changed during measurement: cannot read current manifest`, {
      cause,
    });
  }
  assert.deepEqual(actual, expected, `${label} changed during measurement`);
}

module.exports = { sourceManifest, verifySourceManifest };
