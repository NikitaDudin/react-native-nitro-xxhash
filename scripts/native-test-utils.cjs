const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** Run argument arrays directly, and never confuse a spawn failure with an exit code. */
function run(command, args = [], options = {}) {
  const { expectedStatus = 0, ...settings } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    ...settings,
    shell: false,
  });
  if (result.error || result.signal !== null || result.status !== expectedStatus) {
    const reason = result.error
      ? result.error.message
      : result.signal
        ? `terminated by ${result.signal}`
        : `exited ${result.status}; expected ${expectedStatus}`;
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
    throw new Error(
      `${command} ${args.join(' ')}: ${reason}${output ? `\n${output}` : ''}`,
      result.error ? { cause: result.error } : undefined,
    );
  }
  return result;
}

/** The callback is synchronous; asynchronous test suites should own cleanup hooks. */
function withTemporaryDirectory(prefix, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function findExecutable(name) {
  const candidates = name.includes(path.sep)
    ? [path.resolve(name)]
    : (process.env.PATH || '').split(path.delimiter).map((entry) => path.resolve(entry, name));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue through PATH; callers decide whether a missing tool is skippable.
    }
  }
  return undefined;
}

function requiredExecutable(name) {
  const executable = findExecutable(name);
  if (!executable) throw new Error(`${name} is required for this native check`);
  return executable;
}

function directoriesUnder(directory) {
  const directories = [directory];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isDirectory())
      directories.push(...directoriesUnder(path.join(directory, entry.name)));
  }
  return directories;
}

function filesUnder(directory, predicate = () => true) {
  const files = [];
  for (const current of directoriesUnder(directory)) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const isFile = entry.isFile() || (entry.isSymbolicLink() && fs.statSync(file).isFile());
      if (isFile && predicate(file)) files.push(file);
    }
  }
  return files.sort();
}

/** Reproduce Nitro's flat public-header map using actual dependency headers. */
function nitroHeaderMap(nitroRoot, includeDirectory) {
  fs.mkdirSync(includeDirectory, { recursive: true });
  const directories = new Set();
  for (const header of filesUnder(nitroRoot, (file) => file.endsWith('.hpp'))) {
    directories.add(path.dirname(header));
    const target = path.join(includeDirectory, path.basename(header));
    try {
      fs.symlinkSync(header, target);
    } catch (error) {
      if (error.code === 'EEXIST')
        throw new Error(`Duplicate Nitro public header name: ${path.basename(header)}`, {
          cause: error,
        });
      throw error;
    }
  }
  return [...directories].sort();
}

module.exports = {
  ROOT,
  run,
  withTemporaryDirectory,
  findExecutable,
  requiredExecutable,
  directoriesUnder,
  filesUnder,
  nitroHeaderMap,
};
