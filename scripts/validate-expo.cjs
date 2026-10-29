const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseNpmPackResult } = require('./npm-pack-result.cjs');

const repository = path.resolve(__dirname, '..');
const packageName = 'react-native-nitro-xxhash';
const nitroName = 'react-native-nitro-modules';
const templateVersion = '58.0.29';
const templateIntegrity =
  '1l+8JD5XxlBMSUFiG2wPuFcSMiO2IdiWVJAofwwdM6fwEDhwQXd5pkD2A1jtLkeQERkRqE099yVm0DfEQByMiQ==';
const definitions = require('../compat/patches.json');
const targetPaths = [...new Set(definitions.targets.map((target) => target.path))];

function argumentsFor(values) {
  const result = { platform: process.platform === 'darwin' ? 'all' : 'android' };
  for (let index = 0; index < values.length; index += 1) {
    const option = values[index];
    if (option === '--keep-fixture') result.keepFixture = true;
    else if (['--package', '--platform', '--output'].includes(option)) {
      const value = values[++index];
      if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
      if (option === '--platform') result.platform = value;
      else if (option === '--package') result.archive = path.resolve(value);
      else result.output = path.resolve(value);
    } else throw new Error(`Unknown argument: ${option}`);
  }
  if (!['all', 'android', 'ios'].includes(result.platform))
    throw new Error('--platform must be all, android or ios');
  return result;
}

function snapshot(directory) {
  return targetPaths.map((relative) =>
    createHash('sha256')
      .update(fs.readFileSync(path.join(directory, relative)))
      .digest('hex'),
  );
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

function linkDependencies(directory, targetDirectory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.name.startsWith('.')) continue;
    if (item.name.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(directory, item.name)))
        linkDependency(`${item.name}/${scoped}`);
    } else linkDependency(item.name);
  }
  function linkDependency(name) {
    if (name === nitroName || name === packageName) return;
    const source = path.join(directory, name);
    const destination = path.join(targetDirectory, name);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(source, destination, 'dir');
  }
}

async function main(values = process.argv.slice(2)) {
  const options = argumentsFor(values);
  const fixture = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'nitro-xxhash-expo-')));
  const host = path.join(fixture, 'host');
  const logs = options.output || path.join(fixture, 'logs');
  fs.mkdirSync(host, { recursive: true });
  fs.mkdirSync(logs, { recursive: true });
  let sequence = 0;
  const commands = [];
  const environment = {
    ...process.env,
    CI: '1',
    EXPO_NO_TELEMETRY: '1',
    EXPO_NO_GIT_STATUS: '1',
    npm_config_cache: path.join(fixture, 'npm-cache'),
  };
  function run(label, executable, args, cwd = host, fails = false) {
    const output = spawnSync(executable, args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const file = `${String(++sequence).padStart(2, '0')}-${label}.log`;
    fs.writeFileSync(path.join(logs, file), `${output.stdout || ''}\n${output.stderr || ''}`);
    commands.push({ label, status: output.status, log: file });
    if (output.error) throw output.error;
    if (fails) assert.notEqual(output.status, 0, `${label} unexpectedly succeeded`);
    else assert.equal(output.status, 0, `${label} failed; inspect ${path.join(logs, file)}`);
    return output;
  }
  const npmPath = process.env.npm_execpath;
  function npm(label, args, cwd = host) {
    return run(label, npmPath ? process.execPath : 'npm', npmPath ? [npmPath, ...args] : args, cwd);
  }

  const installedNitro = path.dirname(require.resolve(`${nitroName}/package.json`));
  const sourceSnapshot = snapshot(installedNitro);
  try {
    const expo = require('expo/package.json');
    assert.equal(expo.version, '58.0.20', 'Update the fixture template with the pinned Expo SDK');
    const react = require('react/package.json').version;
    const reactNative = require('react-native/package.json').version;
    assert.equal(react, '19.3.0');
    assert.equal(reactNative, '0.88.0');

    let archive = options.archive;
    if (!archive) {
      const packed = npm(
        'pack-library',
        ['pack', '--ignore-scripts', '--json', '--pack-destination', fixture],
        repository,
      );
      archive = path.join(fixture, parseNpmPackResult(packed.stdout, packageName).filename);
    }
    const library = path.join(host, 'node_modules', packageName);
    fs.mkdirSync(library, { recursive: true });
    run('extract-library', 'tar', ['-xzf', archive, '-C', library, '--strip-components=1']);
    assert.equal(fs.realpathSync(library), library, 'The package must be physically isolated');
    const packedPackage = JSON.parse(fs.readFileSync(path.join(library, 'package.json'), 'utf8'));
    assert.equal(packedPackage.name, packageName);
    assert(fs.existsSync(path.join(library, 'app.plugin.js')));
    const archiveSha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');

    linkDependencies(path.join(repository, 'node_modules'), path.join(host, 'node_modules'));
    const nitro = path.join(host, 'node_modules', nitroName);
    fs.cpSync(installedNitro, nitro, {
      recursive: true,
      dereference: true,
      filter: (entry) => path.basename(entry) !== 'node_modules',
    });
    assert.notEqual(fs.realpathSync(nitro), fs.realpathSync(installedNitro));
    for (const relative of targetPaths) {
      const file = path.join(nitro, relative);
      let source = fs.readFileSync(file, 'utf8');
      for (const target of definitions.targets.filter((target) => target.path === relative)) {
        source = source.replace(target.patched, () => target.original);
        assert(source.includes(target.original), `Unknown clean Nitro source: ${relative}`);
      }
      fs.writeFileSync(file, source);
    }
    const pristine = snapshot(nitro);
    writeJson(path.join(host, 'package.json'), {
      name: 'nitro-xxhash-expo-validation',
      private: true,
      version: '1.0.0',
      dependencies: {
        expo: expo.version,
        react,
        'react-native': reactNative,
        [nitroName]: definitions.package.version,
        [packageName]: `file:${archive}`,
      },
    });
    fs.writeFileSync(path.join(host, 'App.js'), 'export default function App() { return null; }\n');
    const config = {
      name: 'NitroXxhashExpoValidation',
      slug: 'nitro-xxhash-expo-validation',
      ios: { bundleIdentifier: 'com.nitroxxhash.expopluginvalidation' },
      android: { package: 'com.nitroxxhash.expopluginvalidation' },
      plugins: [[packageName, { nitroCompatibility: 'check' }]],
    };
    const setConfig = () => writeJson(path.join(host, 'app.json'), { expo: config });
    setConfig();
    const cli = path.join(host, 'node_modules/expo/bin/cli');
    const expoRun = (label, args, fails) =>
      run(label, process.execPath, [cli, ...args], host, fails);
    for (const type of ['public', 'prebuild', 'introspect']) {
      expoRun(`config-${type}`, ['config', '--type', type, '--json']);
      assert.deepEqual(snapshot(nitro), pristine, `${type} must not repair Nitro`);
      assert(!fs.existsSync(path.join(host, 'android')));
      assert(!fs.existsSync(path.join(host, 'ios')));
    }

    const template = path.join(fixture, 'template.tgz');
    const response = await fetch(
      `https://registry.npmjs.org/expo-template-bare-minimum/-/expo-template-bare-minimum-${templateVersion}.tgz`,
      { signal: AbortSignal.timeout(60000) },
    );
    assert(response.ok, `Cannot download the pinned Expo template: ${response.status}`);
    const templateBytes = Buffer.from(await response.arrayBuffer());
    assert.equal(createHash('sha512').update(templateBytes).digest('base64'), templateIntegrity);
    fs.writeFileSync(template, templateBytes);
    const prebuild = [
      'prebuild',
      '--no-install',
      '--platform',
      options.platform,
      '--template',
      template,
    ];
    const rejected = expoRun('check-pristine-fails', prebuild, true);
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /Nitro compatibility repairs are missing/,
    );
    assert.deepEqual(snapshot(nitro), pristine, 'Check mode must not write dependency sources');

    config.plugins = [packageName];
    setConfig();
    expoRun('apply-clean', prebuild);
    const repaired = snapshot(nitro);
    assert.notDeepEqual(repaired, pristine);
    const { runCompatibility } = require(path.join(library, 'compat/apply.cjs'));
    assert.equal(runCompatibility({ nitroPath: nitro, check: true }).status, 'already-fixed');
    const android = options.platform === 'all' || options.platform === 'android';
    const ios = options.platform === 'all' || options.platform === 'ios';
    const gradleFile = path.join(host, 'android/gradle.properties');
    const rootGradle = android && fs.readFileSync(path.join(host, 'android/build.gradle'), 'utf8');
    const podfile = ios && fs.readFileSync(path.join(host, 'ios/Podfile'), 'utf8');
    const podProperties =
      ios && fs.readFileSync(path.join(host, 'ios/Podfile.properties.json'), 'utf8');
    function unchangedHostToolchain() {
      if (android)
        assert.equal(fs.readFileSync(path.join(host, 'android/build.gradle'), 'utf8'), rootGradle);
      if (ios) {
        assert.equal(fs.readFileSync(path.join(host, 'ios/Podfile'), 'utf8'), podfile);
        assert.equal(
          fs.readFileSync(path.join(host, 'ios/Podfile.properties.json'), 'utf8'),
          podProperties,
        );
      }
    }
    if (android) {
      const properties =
        fs.readFileSync(gradleFile, 'utf8').replace(/^android\.(builtInKotlin|newDsl)=.*\n/gm, '') +
        '\nandroid.builtInKotlin=true\nandroid.newDsl=true\nvalidation.preserved=host\n';
      fs.writeFileSync(gradleFile, properties);
    }
    expoRun('default-incremental', [...prebuild, '--no-clean']);
    assert.deepEqual(snapshot(nitro), repaired);
    if (android) {
      const properties = fs.readFileSync(gradleFile, 'utf8');
      assert.match(properties, /^android.builtInKotlin=true$/m);
      assert.match(properties, /^android.newDsl=true$/m);
      assert.match(properties, /^validation.preserved=host$/m);
      fs.appendFileSync(gradleFile, 'android.builtInKotlin=true\nandroid.newDsl=true\n');
    }
    unchangedHostToolchain();

    config.plugins = [[packageName, { android: { agp9Compatibility: true } }]];
    setConfig();
    for (const label of ['agp9-incremental', 'agp9-repeat-incremental']) {
      expoRun(label, [...prebuild, '--no-clean']);
      assert.deepEqual(snapshot(nitro), repaired);
      if (android) {
        const properties = fs.readFileSync(gradleFile, 'utf8');
        for (const key of ['builtInKotlin', 'newDsl']) {
          assert.equal((properties.match(new RegExp(`^android\\.${key}=`, 'gm')) || []).length, 1);
          assert.match(properties, new RegExp(`^android\\.${key}=false$`, 'm'));
        }
        assert.match(properties, /^validation.preserved=host$/m);
      }
      unchangedHostToolchain();
    }
    expoRun('repeat-clean', prebuild);
    assert.deepEqual(snapshot(nitro), repaired);
    unchangedHostToolchain();
    config.plugins = [[packageName, { nitroCompatibility: 'check' }]];
    setConfig();
    expoRun('check-repaired', [...prebuild, '--no-clean']);
    assert.deepEqual(snapshot(nitro), repaired);
    unchangedHostToolchain();

    for (const platform of ['ios', 'android'].filter(
      (item) => options.platform === 'all' || item === options.platform,
    )) {
      const linked = run('autolink-' + platform, process.execPath, [
        path.join(host, 'node_modules/expo/bin/autolinking'),
        'react-native-config',
        '--json',
        '--platform',
        platform,
      ]);
      const linkedDependencies = JSON.parse(linked.stdout).dependencies;
      for (const [name, directory] of [
        [packageName, library],
        [nitroName, nitro],
      ]) {
        assert.equal(linkedDependencies[name].root, directory);
        assert(
          linkedDependencies[name].platforms[platform],
          `${name} must autolink on ${platform}`,
        );
      }
    }

    const lastTarget = definitions.targets.at(-1);
    const conflictFile = path.join(nitro, lastTarget.path);
    const saved = fs.readFileSync(conflictFile, 'utf8');
    fs.writeFileSync(
      conflictFile,
      saved.replace(lastTarget.patched, '/* Deliberately conflicting fixture. */'),
    );
    const conflicting = snapshot(nitro);
    config.plugins = [packageName];
    setConfig();
    const refused = expoRun('conflicting-patch-fails', [...prebuild, '--no-clean'], true);
    assert.match(`${refused.stdout}\n${refused.stderr}`, /Nitro|source|patch/i);
    assert.deepEqual(
      snapshot(nitro),
      conflicting,
      'Conflicting repairs must not partly mutate Nitro',
    );
    fs.writeFileSync(conflictFile, saved);
    assert.deepEqual(
      snapshot(installedNitro),
      sourceSnapshot,
      'Validation must not change installed Nitro',
    );
    const report = {
      expo: expo.version,
      reactNative,
      template: `expo-template-bare-minimum@${templateVersion}`,
      platform: options.platform,
      packageSha256: archiveSha256,
      checks: commands,
      fixture: options.keepFixture ? fixture : undefined,
    };
    writeJson(path.join(logs, 'result.json'), report);
    console.log(
      `Expo ${expo.version} ${options.platform}: configuration, clean/incremental prebuild, repairs and AGP options passed.`,
    );
    if (options.keepFixture) console.log(`Retained fixture: ${fixture}`);
    else fs.rmSync(fixture, { recursive: true, force: true });
    return report;
  } catch (error) {
    assert.deepEqual(
      snapshot(installedNitro),
      sourceSnapshot,
      'Validation changed installed Nitro',
    );
    console.error(`Expo validation fixture retained: ${fixture}`);
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { argumentsFor, main };
