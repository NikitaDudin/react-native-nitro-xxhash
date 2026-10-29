const { readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');

const root = resolve(__dirname, '..');
const paths = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'vendor') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      collect(path);
    } else if (/\.(cpp|hpp|h|java)$/.test(path)) {
      paths.push(path);
    }
  }
}
collect(resolve(root, 'cpp'));
collect(resolve(root, 'android/src/main'));
collect(resolve(root, 'tests'));
const flags = process.argv.includes('--write') ? ['-i'] : ['--dry-run', '--Werror'];
const formatter = process.env.CLANG_FORMAT || require('@cpp-linter/clang-format').binaryPath();
const result = spawnSync(formatter, [...flags, ...paths.sort()], {
  cwd: root,
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
