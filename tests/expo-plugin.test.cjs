const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { AndroidConfig, compileModsAsync } = require('expo/config-plugins');
const withNitroXxhash = require('../app.plugin.js');
const { runCompatibility } = require('../compat/apply.cjs');
const definitions = require('../compat/patches.json');

const ROOT = resolve(__dirname, '..');
const INSTALLED = dirname(require.resolve('react-native-nitro-modules/package.json'));
const TARGET_PATHS = [...new Set(definitions.targets.map((target) => target.path))];
const AGP_KEYS = ['android.builtInKotlin', 'android.newDsl'];

function replaceTargets(source, relativePath, from, to) {
  for (const target of definitions.targets.filter((entry) => entry.path === relativePath))
    source = source.replace(target[from], () => target[to]);
  return source;
}

function project(t, { version = '0.37.1', nitro = true, properties = '' } = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'nitro-xxhash-expo-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'expo-plugin-fixture' }));
  fs.mkdirSync(join(root, 'ios'));
  fs.mkdirSync(join(root, 'android'));
  const gradle = join(root, 'android/gradle.properties');
  fs.writeFileSync(gradle, properties);
  const directory = join(root, 'node_modules/react-native-nitro-modules');
  if (nitro) {
    fs.mkdirSync(directory, { recursive: true });
    const manifest = JSON.parse(fs.readFileSync(join(INSTALLED, 'package.json'), 'utf8'));
    fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ ...manifest, version }));
    for (const relativePath of TARGET_PATHS) {
      const path = join(directory, relativePath);
      fs.mkdirSync(dirname(path), { recursive: true });
      // Reverse only our exact known repairs in a private copy, never the installation.
      const clean = replaceTargets(
        fs.readFileSync(join(INSTALLED, relativePath), 'utf8'),
        relativePath,
        'patched',
        'original',
      );
      for (const target of definitions.targets.filter((entry) => entry.path === relativePath))
        assert(clean.includes(target.original), `Unknown installed fixture: ${relativePath}`);
      fs.writeFileSync(path, clean);
    }
  }
  return { root, directory, gradle };
}

function sources(directory) {
  return TARGET_PATHS.map((path) => fs.readFileSync(join(directory, path), 'utf8'));
}

function identities(directory) {
  return TARGET_PATHS.map((path) => {
    const stat = fs.statSync(join(directory, path), { bigint: true });
    return [stat.ino, stat.mtimeNs];
  });
}

function config(options) {
  return withNitroXxhash({ name: 'Nitro Plugin Fixture', slug: 'nitro-plugin-fixture' }, options);
}

function compile(fixture, platform, options, extra = {}) {
  return compileModsAsync(config(options), {
    projectRoot: fixture.root,
    platforms: [platform],
    ...extra,
  });
}

function properties(path) {
  return AndroidConfig.Properties.parsePropertiesFile(fs.readFileSync(path, 'utf8')).filter(
    (entry) => entry.type === 'property',
  );
}

test('app.plugin.js imports without loading the hashing runtime or changing Nitro', (t) => {
  const fixture = project(t);
  const before = sources(fixture.directory);
  const script = `
    const plugin = require(process.argv[1]);
    const runtime = require('node:path').join(process.argv[2], 'lib/index.js');
    process.stdout.write(JSON.stringify({type: typeof plugin, runtimeLoaded: !!require.cache[runtime]}));
  `;
  const result = spawnSync(process.execPath, ['-e', script, join(ROOT, 'app.plugin.js'), ROOT], {
    cwd: fixture.root,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { type: 'function', runtimeLoaded: false });
  assert.deepEqual(sources(fixture.directory), before);
});

test('evaluating the plugin only registers mods and leaves dependency files untouched', (t) => {
  const fixture = project(t);
  const before = identities(fixture.directory);
  const result = config({ android: { agp9Compatibility: true } });
  assert.equal(typeof result.mods.ios.dangerous, 'function');
  assert.equal(typeof result.mods.android.dangerous, 'function');
  assert.equal(typeof result.mods.android.gradleProperties, 'function');
  assert.deepEqual(identities(fixture.directory), before);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} native generation repairs only the host's Nitro and is repeatable`, async (t) => {
    const fixture = project(t);
    const before = sources(fixture.directory);
    const installedBefore = identities(INSTALLED);
    await compile(fixture, platform);
    assert.deepEqual(
      sources(fixture.directory),
      before.map((source, index) =>
        replaceTargets(source, TARGET_PATHS[index], 'original', 'patched'),
      ),
    );
    const repaired = identities(fixture.directory);
    await compile(fixture, platform);
    assert.deepEqual(identities(fixture.directory), repaired, 'Do not rewrite repaired sources');
    assert.deepEqual(
      identities(INSTALLED),
      installedBefore,
      'Never modify the helper installation',
    );
  });

  test(`${platform} check mode rejects missing repairs without writing`, async (t) => {
    const fixture = project(t);
    const before = sources(fixture.directory);
    const beforeIdentity = identities(fixture.directory);
    await assert.rejects(
      compile(fixture, platform, { nitroCompatibility: 'check' }),
      /compatibility repairs are missing/i,
    );
    assert.deepEqual(sources(fixture.directory), before);
    assert.deepEqual(identities(fixture.directory), beforeIdentity);
    runCompatibility({ nitroPath: fixture.directory });
    const repaired = identities(fixture.directory);
    await compile(fixture, platform, { nitroCompatibility: 'check' });
    assert.deepEqual(identities(fixture.directory), repaired);
  });

  test(`${platform} refuses unsupported host Nitro without falling back or writing`, async (t) => {
    const fixture = project(t, { version: '0.37.2' });
    const before = sources(fixture.directory);
    const installedBefore = identities(INSTALLED);
    await assert.rejects(
      compile(fixture, platform),
      /Expected react-native-nitro-modules@0\.37\.1/,
    );
    assert.deepEqual(sources(fixture.directory), before);
    assert.deepEqual(identities(INSTALLED), installedBefore);
  });
}

test('a missing host dependency fails instead of selecting the helper development dependency', async (t) => {
  const fixture = project(t, { nitro: false });
  const installedBefore = identities(INSTALLED);
  await assert.rejects(compile(fixture, 'android'), /react-native-nitro-modules/);
  assert.equal(fs.existsSync(fixture.directory), false);
  assert.deepEqual(identities(INSTALLED), installedBefore);
});

test('a conflicting later source hunk refuses all repairs before any source is replaced', async (t) => {
  const fixture = project(t);
  const target = definitions.targets.at(-1);
  const path = join(fixture.directory, target.path);
  const conflict = target.original.replace('++_threadCount', '(_threadCount += 2)');
  assert.notEqual(conflict, target.original);
  fs.writeFileSync(
    path,
    fs.readFileSync(path, 'utf8').replace(target.original, () => conflict),
  );
  const before = sources(fixture.directory);
  const beforeIdentity = identities(fixture.directory);
  await assert.rejects(compile(fixture, 'android'), /Unexpected source/);
  assert.deepEqual(sources(fixture.directory), before);
  assert.deepEqual(identities(fixture.directory), beforeIdentity);
});

test('introspection previews AGP properties without repairing Nitro or writing native files', async (t) => {
  const fixture = project(t, { properties: '# Host settings\nandroid.builtInKotlin=true\n' });
  const before = identities(fixture.directory);
  const propertiesBefore = fs.readFileSync(fixture.gradle, 'utf8');
  const result = await compileModsAsync(config({ android: { agp9Compatibility: true } }), {
    projectRoot: fixture.root,
    platforms: ['ios', 'android'],
    introspect: true,
  });
  assert.deepEqual(identities(fixture.directory), before);
  assert.equal(fs.readFileSync(fixture.gradle, 'utf8'), propertiesBefore);
  for (const key of AGP_KEYS)
    assert.deepEqual(
      result._internal.modResults.android.gradleProperties.filter(
        (entry) => entry.type === 'property' && entry.key === key,
      ),
      [{ type: 'property', key, value: 'false' }],
    );
});

test('introspection works before the host Nitro dependency is installed', async (t) => {
  const fixture = project(t, { nitro: false });
  await compile(fixture, 'android', undefined, { introspect: true });
  assert.equal(fs.existsSync(fixture.directory), false);
});

test('AGP compatibility leaves host properties byte-for-byte unchanged unless enabled', async (t) => {
  const original =
    '# Keep host configuration\n' +
    'android.builtInKotlin=true\nandroid.newDsl=true\n' +
    'android.minSdkVersion=28\nandroid.compileSdkVersion=37\nandroid.targetSdkVersion=37\n';
  const fixture = project(t, { properties: original });
  await compile(fixture, 'android');
  assert.equal(fs.readFileSync(fixture.gradle, 'utf8'), original);
  await compile(fixture, 'android', { android: { agp9Compatibility: false } });
  assert.equal(fs.readFileSync(fixture.gradle, 'utf8'), original);
});

test('AGP opt-in replaces duplicate flags while preserving unrelated host configuration', async (t) => {
  const fixture = project(t, {
    properties:
      '# Keep host configuration\norg.gradle.jvmargs=-Xmx2048m\n' +
      'android.builtInKotlin=true\nandroid.builtInKotlin=true\nandroid.newDsl=true\n' +
      'android.minSdkVersion=28\nandroid.compileSdkVersion=37\nandroid.targetSdkVersion=37\n',
  });
  const options = { android: { agp9Compatibility: true } };
  const original = properties(fixture.gradle).filter((entry) => !AGP_KEYS.includes(entry.key));
  await compile(fixture, 'android', options);
  const result = properties(fixture.gradle);
  assert.deepEqual(
    result.filter((entry) => !AGP_KEYS.includes(entry.key)),
    original,
  );
  assert.match(fs.readFileSync(fixture.gradle, 'utf8'), /# Keep host configuration/);
  for (const key of AGP_KEYS)
    assert.deepEqual(
      result.filter((entry) => entry.key === key),
      [{ type: 'property', key, value: 'false' }],
    );
  const once = fs.readFileSync(fixture.gradle, 'utf8');
  await compile(fixture, 'android', options);
  assert.equal(fs.readFileSync(fixture.gradle, 'utf8'), once);
});

test('repeated plugin registration preserves Expo run-once behavior', async (t) => {
  const fixture = project(t);
  const options = { android: { agp9Compatibility: true } };
  const registered = config(options);
  const once = withNitroXxhash(registered, options);
  assert.equal(once, registered);
  await compileModsAsync(once, { projectRoot: fixture.root, platforms: ['android'] });
  const result = properties(fixture.gradle);
  for (const key of AGP_KEYS)
    assert.equal(result.filter((entry) => entry.key === key && entry.value === 'false').length, 1);
  assert.equal(
    runCompatibility({ nitroPath: fixture.directory, check: true }).status,
    'already-fixed',
  );
});

test('invalid and unknown options fail during configuration before filesystem changes', (t) => {
  const fixture = project(t);
  const before = identities(fixture.directory);
  for (const options of [
    null,
    [],
    true,
    'apply',
    { nitroCompatibility: 'skip' },
    { nitroCompatibility: false },
    { nitroPath: fixture.directory },
    { android: null },
    { android: [] },
    { android: { agp9Compatibility: 'true' } },
    { android: { minSdkVersion: 21 } },
  ])
    assert.throws(() => config(options), /react-native-nitro-xxhash:/);
  assert.deepEqual(identities(fixture.directory), before);
});
