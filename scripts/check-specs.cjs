const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync } = require('node:fs');
const { basename, relative, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const generated = resolve(root, 'nitrogen/generated');

function snapshot(directory) {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      entries.push(...snapshot(path));
    } else {
      entries.push([
        relative(generated, path),
        createHash('sha256').update(readFileSync(path)).digest('hex'),
      ]);
    }
  }
  return entries.sort(([left], [right]) => left.localeCompare(right));
}

const before = snapshot(generated);
const npmExecPath = process.env.npm_execpath;
const npmPath = npmExecPath && basename(npmExecPath) === 'npm-cli.js' ? npmExecPath : undefined;
const command = npmPath ? process.execPath : 'npm';
const args = npmPath ? [npmPath, 'run', 'specs'] : ['run', 'specs'];
const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
assert.equal(result.status, 0, 'Nitrogen generation failed');
assert.deepEqual(
  snapshot(generated),
  before,
  'Generated bindings changed. Run npm run specs and include the updated files.',
);
console.log(`Verified ${before.length} generated files are reproducible.`);
