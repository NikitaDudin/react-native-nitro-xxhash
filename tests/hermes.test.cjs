const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  filesUnder,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('actual Hermes and Nitro bindings preserve binary, clone, format and async contracts', () => {
  assert.equal(
    process.platform,
    'darwin',
    'This optional Hermes host requires macOS and its matching Hermes framework',
  );
  const configured = process.env.HERMES_ROOT;
  assert(
    configured,
    'Set HERMES_ROOT to your matching Hermes destroot before running this optional check',
  );
  const expanded =
    configured === '~'
      ? os.homedir()
      : configured.startsWith('~/')
        ? path.join(os.homedir(), configured.slice(2))
        : configured;
  const hermes = path.resolve(expanded);
  const framework = path.join(hermes, 'Library/Frameworks/macosx');
  for (const file of [
    path.join(hermes, 'include/hermes/hermes.h'),
    path.join(hermes, 'include/jsi/jsi.h'),
    path.join(framework, 'hermesvm.framework/hermesvm'),
    path.join(ROOT, 'node_modules/buffer/package.json'),
    path.join(ROOT, 'node_modules/typescript/package.json'),
  ]) {
    assert(
      fs.existsSync(file) && fs.statSync(file).isFile(),
      `Missing ${file}; provide HERMES_ROOT and run npm ci first`,
    );
  }
  // Nitro and Hermes must agree on the JSI ABI; reject engine/header mixtures.
  assert(
    fs
      .readFileSync(path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi/jsi/jsi.h'))
      .equals(fs.readFileSync(path.join(hermes, 'include/jsi/jsi.h'))),
    'Hermes and installed React Native JSI headers differ; use the matching Hermes build',
  );
  withTemporaryDirectory('nitro-xxhash-hermes-', (work) => {
    const installed = path.join(ROOT, 'node_modules/react-native-nitro-modules');
    for (const part of ['cpp', 'ios/platform', 'ios/threading']) {
      fs.cpSync(path.join(installed, part), path.join(work, 'nitro', part), {
        recursive: true,
        dereference: true,
      });
    }
    fs.cpSync(path.join(ROOT, 'cpp'), path.join(work, 'xxhash/cpp'), {
      recursive: true,
      dereference: true,
    });
    fs.cpSync(
      path.join(ROOT, 'nitrogen/generated/shared/c++'),
      path.join(work, 'xxhash/generated'),
      { recursive: true, dereference: true },
    );
    fs.copyFileSync(path.join(ROOT, 'tests/hermes/host.cpp'), path.join(work, 'host.cpp'));
    const nitro = path.join(work, 'nitro/cpp');
    const publicHeaders = path.join(work, 'include/NitroModules');
    fs.mkdirSync(publicHeaders, { recursive: true });
    const includes = nitroHeaderMap(nitro, publicHeaders);
    const compiler = requiredExecutable('clang++');
    const arguments_ = [
      '-std=c++20',
      '-O1',
      '-DNDEBUG',
      '-fblocks',
      '-pthread',
      '-Wno-deprecated-declarations',
      '-I',
      path.join(hermes, 'include'),
      '-I',
      path.join(work, 'include'),
      '-I',
      path.join(work, 'xxhash/cpp'),
      '-I',
      path.join(work, 'xxhash/generated'),
      '-I',
      path.join(work, 'nitro/ios/threading'),
    ];
    for (const directory of includes) arguments_.push('-I', directory);
    const sources = filesUnder(
      nitro,
      (file) =>
        file.endsWith('.cpp') && !path.relative(nitro, file).split(path.sep).includes('views'),
    );
    for (const part of [
      'nitro/ios/platform',
      'nitro/ios/threading',
      'xxhash/generated',
      'xxhash/cpp',
    ]) {
      const directory = path.join(work, part);
      sources.push(
        ...filesUnder(
          directory,
          (file) => path.dirname(file) === directory && file.endsWith('.cpp'),
        ),
      );
    }
    sources.push(path.join(work, 'host.cpp'));
    const binary = path.join(work, 'host');
    run(
      compiler,
      [
        ...arguments_,
        ...sources,
        '-F',
        framework,
        '-framework',
        'hermesvm',
        '-framework',
        'Foundation',
        `-Wl,-rpath,${framework}`,
        '-o',
        binary,
      ],
      { stdio: 'inherit' },
    );
    const bundle = path.join(work, 'bundle.js');
    run(process.execPath, [path.join(ROOT, 'tests/hermes/build-bundle.cjs'), bundle], {
      stdio: 'inherit',
    });
    const fixture = path.join(work, 'файл #%.bin');
    const data = new Uint8Array(2 * 1024 * 1024);
    for (let index = 0; index < data.length; index += 1) data[index] = (index * 131 + 17) % 256;
    fs.writeFileSync(fixture, data);
    run(binary, [bundle, fixture], { stdio: 'inherit', timeout: 60_000 });
  });
});
