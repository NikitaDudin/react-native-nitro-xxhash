const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const example = path.resolve(__dirname, '..');
const repository = path.resolve(example, '..');
const packageName = 'react-native-nitro-xxhash';

function npm(arguments_, cwd) {
  const executable = process.env.npm_execpath ? process.execPath : 'npm';
  const args = process.env.npm_execpath ? [process.env.npm_execpath, ...arguments_] : arguments_;
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `npm ${arguments_.join(' ')} failed`);
}

function setup() {
  assert.equal(process.argv.length, 2, 'This command does not accept arguments');
  const manifest = JSON.parse(fs.readFileSync(path.join(repository, 'package.json'), 'utf8'));
  const artifacts = path.join(example, '.artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  const staging = fs.mkdtempSync(path.join(artifacts, 'pack-'));
  const archive = path.join(artifacts, `${packageName}.tgz`);
  try {
    // Pack the same files and run the same prepack checks used for publication.
    npm(['pack', '--pack-destination', staging], repository);
    const packed = path.join(staging, `${manifest.name}-${manifest.version}.tgz`);
    fs.copyFileSync(packed, archive);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  // Explicit installation refreshes a local archive even when its version stays
  // unchanged. Registry dependencies retain their versions from package-lock.
  npm(
    ['install', '--save-exact', '--no-audit', '--no-fund', `./.artifacts/${packageName}.tgz`],
    example,
  );

  const installed = path.join(example, 'node_modules', packageName);
  const nitro = path.join(example, 'node_modules/react-native-nitro-modules');
  for (const directory of [installed, nitro])
    assert(
      !fs.lstatSync(directory).isSymbolicLink(),
      `${directory} must be a physical installation`,
    );
  const { createRequire } = require('node:module');
  const fromLibrary = createRequire(path.join(installed, 'package.json'));
  assert.equal(
    fs.realpathSync(fromLibrary.resolve('react-native-nitro-modules/package.json')),
    fs.realpathSync(path.join(nitro, 'package.json')),
    'The app and library must share one Nitro installation',
  );
  const lock = JSON.parse(fs.readFileSync(path.join(example, 'package-lock.json'), 'utf8'));
  const integrity =
    'sha512-' + createHash('sha512').update(fs.readFileSync(archive)).digest('base64');
  assert.equal(lock.packages[`node_modules/${packageName}`].integrity, integrity);
  console.log(`Example installed from ${archive}. Run npm --prefix example run ios or android.`);
}

setup();
