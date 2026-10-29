const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ROOT,
  directoriesUnder,
  filesUnder,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('./native-test-utils.cjs');
const {
  createNitroCacheFixture,
  createNitroRuntimeRegistryFixture,
} = require('../tests/native/nitro-cache-fixture.cjs');

function expandDirectory(value) {
  if (value === '~') return os.homedir();
  return path.resolve(value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value);
}

function requireFile(file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile())
    throw new Error(`Required native lint header is missing: ${file}`);
}

function jniIncludes() {
  const java = requiredExecutable('java');
  const settings = run(java, ['-XshowSettings:properties', '-version']).stderr;
  const home = settings.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1];
  if (!home) throw new Error('Cannot read java.home for the host JNI lint context');
  const include = path.join(home.trim(), 'include');
  const platform = path.join(include, process.platform === 'darwin' ? 'darwin' : 'linux');
  requireFile(path.join(include, 'jni.h'));
  requireFile(path.join(platform, 'jni_md.h'));
  return ['-isystem', include, '-isystem', platform];
}

function verifyAnalyzerGuard(tidy, directory, name, source, flags, checker) {
  const file = path.join(directory, `${name}.cpp`);
  fs.writeFileSync(file, source);
  const result = run(
    tidy,
    [file, '--quiet', `--config-file=${path.join(ROOT, '.clang-tidy')}`, '--', ...flags],
    { expectedStatus: 1 },
  );
  if (!(result.stdout + result.stderr).includes(`[${checker},`))
    throw new Error(`Native lint safety guard did not reject ${name} with ${checker}`);
}

function main() {
  if (!['darwin', 'linux'].includes(process.platform))
    throw new Error('Native lint contexts require macOS or Linux, matching the host tests');
  const unknown = process.argv
    .slice(2)
    .filter((argument) => !['--require-jni', '--require-hermes'].includes(argument));
  if (unknown.length) throw new Error(`Unknown native lint arguments: ${unknown.join(' ')}`);
  const compiler = requiredExecutable(process.env.CXX || 'clang++');
  const tidy = process.env.CLANG_TIDY || require('@cpp-linter/clang-tidy').binaryPath();
  const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules/cpp');
  const reactCommon = path.join(ROOT, 'node_modules/react-native/ReactCommon');
  const generated = path.join(ROOT, 'nitrogen/generated/shared/c++');
  requireFile(path.join(nitro, 'core/HybridObject.hpp'));
  requireFile(path.join(reactCommon, 'jsi/jsi/jsi.h'));
  requireFile(path.join(generated, 'HybridFileHasherSpec.hpp'));
  run(compiler, ['--version']);

  withTemporaryDirectory('nitro-xxhash-clang-tidy-', (temporary) => {
    const includes = nitroHeaderMap(nitro, path.join(temporary, 'NitroModules'));
    const flags = [
      '-std=c++20',
      '-pthread',
      '-Wall',
      '-Wextra',
      '-Wno-unused-parameter',
      '-Wno-dollar-in-identifier-extension',
      '-I',
      path.join(ROOT, 'cpp'),
      '-isystem',
      generated,
      '-isystem',
      temporary,
      '-isystem',
      path.join(reactCommon, 'jsi'),
      '-isystem',
      path.join(reactCommon, 'callinvoker'),
    ];
    for (const directory of includes) flags.push('-isystem', directory);
    if (process.platform === 'darwin')
      flags.push('-isysroot', run(requiredExecutable('xcrun'), ['--show-sdk-path']).stdout.trim());

    const hermesHosts = ['tests/hermes/host.cpp', 'tests/native/strings/host.cpp'];
    const cacheLifetimeTest = path.join(ROOT, 'tests/native/nitro-cache-lifetime.cpp');
    const runtimeRegistryTest = path.join(ROOT, 'tests/native/nitro-runtime-registry.cpp');
    const contexts = filesUnder(path.join(ROOT, 'cpp'), (file) => file.endsWith('.cpp')).filter(
      (file) => !path.relative(path.join(ROOT, 'cpp'), file).split(path.sep).includes('vendor'),
    );
    contexts.push(
      ...filesUnder(
        path.join(ROOT, 'tests'),
        (file) =>
          file.endsWith('.cpp') &&
          file !== cacheLifetimeTest &&
          file !== runtimeRegistryTest &&
          !hermesHosts.includes(path.relative(ROOT, file).split(path.sep).join('/')),
      ),
    );
    // Treat standard-library ownership as opaque at the Nitro callback boundary.
    // Clang's std::function move model otherwise reports a dependency-only leak.
    // The portable hashing core and its tests retain full STL inlining.
    const nitroFlags = [
      ...flags,
      '-Xclang',
      '-analyzer-config',
      '-Xclang',
      'c++-stdlib-inlining=false',
    ];
    // Only the framework's templates are opaque in the non-template Hermes host.
    // Keep its own functions subject to every configured analyzer checker.
    const hermesFlags = [
      ...flags,
      '-fblocks',
      '-Xclang',
      '-analyzer-config',
      '-Xclang',
      'c++-template-inlining=false',
    ];
    const entries = contexts.map((file) => ({
      file,
      name: 'host',
      flags: /^Hybrid.*\.cpp$/.test(path.basename(file)) ? nitroFlags : flags,
    }));
    // This regression deliberately uses hooks in copied SDK headers. Analyze it
    // against the same fixture as its executable, with the existing Nitro
    // template boundary for valid empty references carrying NON_NULL annotations.
    const cacheFixture = createNitroCacheFixture(path.join(temporary, 'cache-lifetime-nitro'));
    entries.push({
      file: cacheLifetimeTest,
      name: 'patched Nitro cache fixture',
      flags: [
        ...directoriesUnder(cacheFixture).flatMap((directory) => ['-isystem', directory]),
        ...flags,
        '-Xclang',
        '-analyzer-config',
        '-Xclang',
        'c++-template-inlining=false',
      ],
    });
    // Parse the scalar-only preprocessor paths as well as the host SIMD backend.
    for (const relative of [
      'cpp/FileDigest.cpp',
      'tests/native-stress.cpp',
      'tests/file-cancel.cpp',
    ])
      entries.push({
        file: path.join(ROOT, relative),
        name: 'scalar',
        flags: [...flags, '-DFILE_HASH_FORCE_SCALAR'],
      });

    const cachedHeaders = path.join(ROOT, 'node_modules/.cache/nitro-xxhash-lint');
    const cachedFbjni = path.join(cachedHeaders, 'fbjni/include');
    const fbjni = process.env.FBJNI_INCLUDE_DIR || (fs.existsSync(cachedFbjni) && cachedFbjni);
    if (fbjni) {
      const include = expandDirectory(fbjni);
      requireFile(path.join(include, 'fbjni/fbjni.h'));
      const jniFlags = [
        ...flags,
        ...jniIncludes(),
        '-isystem',
        include,
        '-isystem',
        path.join(ROOT, 'nitrogen/generated/android'),
      ];
      for (const file of filesUnder(path.join(ROOT, 'android/src/main/cpp'), (file) =>
        file.endsWith('.cpp'),
      ))
        entries.push({ file, name: 'host JNI', flags: jniFlags });
    } else if (process.argv.includes('--require-jni')) {
      throw new Error(
        'Set FBJNI_INCLUDE_DIR to the real fbjni prefab include directory for JNI lint',
      );
    } else {
      console.log(
        'JNI entrypoint lint requires FBJNI_INCLUDE_DIR and a JDK; the portable contexts still run.',
      );
    }

    const cachedHermes = path.join(cachedHeaders, 'hermes/include');
    const hermes =
      process.env.HERMES_INCLUDE_DIR ||
      (process.env.HERMES_ROOT && path.join(expandDirectory(process.env.HERMES_ROOT), 'include')) ||
      (fs.existsSync(cachedHermes) && cachedHermes);
    if (hermes) {
      const include = expandDirectory(hermes);
      requireFile(path.join(include, 'hermes/hermes.h'));
      const jsi = path.join(include, 'jsi/jsi.h');
      if (
        fs.existsSync(jsi) &&
        !fs.readFileSync(jsi).equals(fs.readFileSync(path.join(reactCommon, 'jsi/jsi/jsi.h')))
      )
        throw new Error('Hermes lint headers and installed React Native JSI headers differ');
      for (const relative of hermesHosts)
        entries.push({
          file: path.join(ROOT, relative),
          name: 'Hermes host',
          // Nitro's template-only BorrowingReference intentionally starts empty,
          // contrary to its NON_NULL member annotation. Keep dependency templates
          // opaque for this non-template host; all analyzer checkers stay enabled.
          flags: [...hermesFlags, '-isystem', include],
        });
      const registryFixture = createNitroRuntimeRegistryFixture(
        path.join(temporary, 'runtime-registry-nitro'),
      );
      entries.push({
        file: runtimeRegistryTest,
        name: 'patched Nitro runtime registry fixture',
        flags: [
          ...directoriesUnder(registryFixture).flatMap((directory) => ['-isystem', directory]),
          ...hermesFlags,
          '-isystem',
          include,
        ],
      });
    } else if (process.argv.includes('--require-hermes')) {
      throw new Error('Set HERMES_INCLUDE_DIR or HERMES_ROOT to matching Hermes SDK headers');
    } else {
      console.log(
        'Hermes host lint requires HERMES_INCLUDE_DIR or HERMES_ROOT with matching SDK headers.',
      );
    }

    // These probes have no first-party line filter: their temporary source is
    // intentionally invalid. Matching the checker proves a real lint failure,
    // rather than accepting a missing SDK/tool or a disabled set of checks.
    verifyAnalyzerGuard(
      tidy,
      temporary,
      'owned-allocation-leak',
      'int leak() { auto* value = new int(17); return *value; }\n',
      nitroFlags,
      'clang-analyzer-cplusplus.NewDeleteLeaks',
    );
    verifyAnalyzerGuard(
      tidy,
      temporary,
      'owned-nullability-violation',
      'int readValue(int* _Nonnull pointer) { return *pointer; }\nint main() { return readValue(nullptr); }\n',
      hermesFlags,
      'clang-analyzer-nullability.NullPassedToNonnull',
    );
    console.log(
      'clang-tidy safety guards rejected own allocation leaks and nullability violations.',
    );

    // Keep every first-party source/header line enabled. Interprocedural analyzer
    // paths can still enter SDK internals; their model boundaries are set above.
    const ownFiles = [
      ...filesUnder(
        path.join(ROOT, 'cpp'),
        (file) => /\.(cpp|hpp|h)$/.test(file) && !file.includes('/vendor/'),
      ),
      ...filesUnder(path.join(ROOT, 'tests'), (file) => /\.(cpp|hpp|h)$/.test(file)),
      ...filesUnder(path.join(ROOT, 'android/src/main/cpp'), (file) => /\.(cpp|hpp|h)$/.test(file)),
    ];
    const lineFilter = JSON.stringify(ownFiles.map((name) => ({ name })));
    const failures = [];
    for (const entry of entries) {
      console.log(`clang-tidy ${path.relative(ROOT, entry.file)} (${entry.name})`);
      try {
        run(
          tidy,
          [
            entry.file,
            '--quiet',
            `--config-file=${path.join(ROOT, '.clang-tidy')}`,
            `--line-filter=${lineFilter}`,
            '--',
            ...entry.flags,
          ],
          {
            stdio: 'inherit',
          },
        );
      } catch (error) {
        failures.push(`${path.relative(ROOT, entry.file)} (${entry.name})`);
        if (error.cause) console.error(error.cause.message);
      }
    }
    if (failures.length) throw new Error(`Native lint failed: ${failures.join(', ')}`);
    console.log(
      `Native lint passed: ${entries.length} source/backend contexts. ARMv7-only code needs an Android target build.`,
    );
  });
}

main();
