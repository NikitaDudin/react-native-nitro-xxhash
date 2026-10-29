const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { ROOT, filesUnder, requiredExecutable, run } = require('./native-test-utils.cjs');

// These are the real headers used by the pinned RN development dependency.
// Native lint never downloads or executes the AARs' native libraries.
const dependencies = [
  {
    name: 'fbjni',
    version: '0.7.0',
    url: 'https://repo.maven.apache.org/maven2/com/facebook/fbjni/fbjni/0.7.0/fbjni-0.7.0.aar',
    sha256: '7e319ae110ac5e5ef18904170aea5c3e753e915d196699d7fd39d36c8e1dfe36',
    prefix: 'prefab/modules/fbjni/include/',
    header: 'fbjni/fbjni.h',
  },
  {
    name: 'hermes',
    version: '260318099.0.4',
    url: 'https://repo.maven.apache.org/maven2/com/facebook/hermes/hermes-android/260318099.0.4/hermes-android-260318099.0.4-release.aar',
    sha256: '3e79e1232d198aed2d984cc6d9cb8a4f7eb1f94defd4391aef24eb89016579d8',
    prefix: 'prefab/modules/hermesvm/include/',
    header: 'hermes/hermes.h',
  },
];

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function headerHashes(include) {
  return Object.fromEntries(
    filesUnder(include).map((file) => [
      path.relative(include, file),
      sha256(fs.readFileSync(file)),
    ]),
  );
}

function cached(directory, dependency) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(directory, 'headers.json'), 'utf8'));
    assert.equal(marker.version, dependency.version);
    assert.equal(marker.sha256, dependency.sha256);
    assert(fs.statSync(path.join(directory, 'include', dependency.header)).isFile());
    assert.deepEqual(headerHashes(path.join(directory, 'include')), marker.headers);
    return true;
  } catch {
    return false;
  }
}

function verifyVersions() {
  const react = path.join(ROOT, 'node_modules/react-native');
  const manifest = JSON.parse(fs.readFileSync(path.join(react, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.88.0', 'Update native lint header pins for the RN dev version');
  const catalog = fs.readFileSync(path.join(react, 'gradle/libs.versions.toml'), 'utf8');
  assert.equal(catalog.match(/^fbjni\s*=\s*"([^"]+)"/m)?.[1], dependencies[0].version);
  const hermes = fs.readFileSync(path.join(react, 'sdks/hermes-engine/version.properties'), 'utf8');
  assert.equal(hermes.match(/^HERMES_VERSION_NAME=(.+)$/m)?.[1].trim(), dependencies[1].version);
}

async function prepare(dependency, cache, jar) {
  const destination = path.join(cache, dependency.name);
  if (cached(destination, dependency)) {
    console.log(`Native lint headers cached: ${dependency.name}@${dependency.version}`);
    return;
  }
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-xxhash-lint-headers-'));
  const staged = fs.mkdtempSync(path.join(cache, `.${dependency.name}-`));
  try {
    console.log(`Preparing native lint headers: ${dependency.name}@${dependency.version}`);
    const response = await fetch(dependency.url, { signal: AbortSignal.timeout(180_000) });
    assert(
      response.ok && response.body,
      `Cannot download ${dependency.url}: HTTP ${response.status}`,
    );
    const digest = crypto.createHash('sha256');
    const archive = path.join(temporary, 'headers.aar');
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, encoding, callback) {
          digest.update(chunk);
          callback(null, chunk);
        },
      }),
      fs.createWriteStream(archive, { flags: 'wx' }),
    );
    assert.equal(digest.digest('hex'), dependency.sha256, `${dependency.name} archive checksum`);
    const entries = run(jar, ['tf', archive]).stdout.split(/\r?\n/);
    const headers = entries.filter((entry) => entry.startsWith(dependency.prefix));
    assert(headers.length > 0, `No native headers found in ${dependency.name}`);
    for (const entry of headers) {
      assert(!entry.includes('\\') && !entry.split('/').includes('..'), 'Unexpected archive path');
    }
    run(jar, ['xf', archive, dependency.prefix], { cwd: temporary });
    const include = path.join(staged, 'include');
    fs.cpSync(path.join(temporary, dependency.prefix), include, { recursive: true });
    assert(fs.statSync(path.join(include, dependency.header)).isFile());
    fs.writeFileSync(
      path.join(staged, 'headers.json'),
      JSON.stringify(
        { version: dependency.version, sha256: dependency.sha256, headers: headerHashes(include) },
        null,
        2,
      ) + '\n',
    );
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staged, destination);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
    fs.rmSync(staged, { recursive: true, force: true });
  }
}

async function main() {
  verifyVersions();
  const jar = requiredExecutable('jar');
  const cache = path.join(ROOT, 'node_modules/.cache/nitro-xxhash-lint');
  fs.mkdirSync(cache, { recursive: true });
  for (const dependency of dependencies) await prepare(dependency, cache, jar);
  console.log(
    'Native lint JNI and Hermes headers are ready; no runtime SDK or Python is required.',
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
