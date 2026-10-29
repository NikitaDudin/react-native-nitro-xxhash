const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const definitions = require('../compat/patches.json');
const { sharedAsanRuntime } = require('./native/threadpool-startup/clang-runtime.cjs');
const {
  ROOT,
  nitroHeaderMap,
  requiredExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

const supported = ['darwin', 'linux'].includes(process.platform);
const scenarios = ['normal', 'failure-first', 'failure-second', 'expansion'];

function replaceExactlyOnce(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'unknown Nitro ThreadPool source');
  return source.replace(before, () => after);
}

function sources(installed) {
  const targets = definitions.targets.filter(
    (target) => target.path === 'cpp/threading/ThreadPool.cpp',
  );
  assert(targets.length > 0, 'missing Nitro ThreadPool compatibility patch');
  let clean = fs.readFileSync(installed, 'utf8');
  for (const target of targets) {
    if (clean.includes(target.patched))
      clean = replaceExactlyOnce(clean, target.patched, target.original);
    else assert.equal(clean.split(target.original).length - 1, 1, target.signature);
  }
  let fixed = clean;
  for (const target of targets) fixed = replaceExactlyOnce(fixed, target.original, target.patched);
  assert.notEqual(fixed, clean, 'negative control must use the actual unpatched source');
  return { clean, fixed };
}

function child(binary, hook, scenario, sanitizerRuntime) {
  const loader = process.platform === 'darwin' ? 'DYLD_INSERT_LIBRARIES' : 'LD_PRELOAD';
  const result = spawnSync(binary, [scenario], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 8000,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
    // Inject only the disposable test executable, never Node or the user's app.
    env: { ...process.env, [loader]: [sanitizerRuntime, hook].filter(Boolean).join(':') },
    shell: false,
  });
  return result;
}

function requirePass(result, scenario) {
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`^PASS ${scenario}$`, 'm'));
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

function runtimeFixture(target, libraries, check, interpreter = process.execPath) {
  withTemporaryDirectory('nitro-xxhash-clang-runtime-', (root) => {
    const directory = path.join(root, 'compiler runtime');
    fs.mkdirSync(directory);
    for (const name of libraries) fs.writeFileSync(path.join(directory, name), 'runtime fixture');
    const script = path.join(root, "compiler's runtime.cjs");
    fs.writeFileSync(
      script,
      `const values = ${JSON.stringify({ '-dumpmachine': target, '--print-runtime-dir': directory })};
if (process.argv.length !== 3 || !Object.hasOwn(values, process.argv[2])) process.exit(2);
console.log(values[process.argv[2]]);
`,
    );
    const compiler = path.join(root, 'clang++');
    fs.writeFileSync(
      compiler,
      `#!/bin/sh\nexec ${shellQuote(interpreter)} ${shellQuote(script)} "$@"\n`,
      { mode: 0o755 },
    );
    check(compiler, directory);
  });
}

// These two basenames coexist in Ubuntu Noble's actual amd64 compiler-rt package.
const ubuntuMultiarch = ['libclang_rt.asan-i386.so', 'libclang_rt.asan-x86_64.so'];

test('Clang target chooses the x86_64 runtime from an Ubuntu multiarch directory', () => {
  runtimeFixture('x86_64-pc-linux-gnu', ubuntuMultiarch, (compiler, directory) => {
    assert.equal(sharedAsanRuntime(compiler), path.join(directory, 'libclang_rt.asan-x86_64.so'));
  });
});

test('fake Clang supports a Node executable path containing spaces and single quotes', () => {
  withTemporaryDirectory('nitro-xxhash-quoted-node-', (root) => {
    const interpreter = path.join(root, "Node's runtime");
    fs.symlinkSync(process.execPath, interpreter);
    runtimeFixture(
      'x86_64-pc-linux-gnu',
      ubuntuMultiarch,
      (compiler, directory) => {
        assert.equal(
          sharedAsanRuntime(compiler),
          path.join(directory, 'libclang_rt.asan-x86_64.so'),
        );
      },
      interpreter,
    );
  });
});

test('32-bit Clang target chooses i386 even when Node is running on another architecture', () => {
  runtimeFixture('i686-pc-linux-gnu', ubuntuMultiarch, (compiler, directory) => {
    assert.equal(sharedAsanRuntime(compiler), path.join(directory, 'libclang_rt.asan-i386.so'));
  });
});

test('AArch64 Clang target chooses its own runtime among other architectures', () => {
  runtimeFixture(
    'aarch64-unknown-linux-gnu',
    [...ubuntuMultiarch, 'libclang_rt.asan-aarch64.so'],
    (compiler, directory) => {
      assert.equal(
        sharedAsanRuntime(compiler),
        path.join(directory, 'libclang_rt.asan-aarch64.so'),
      );
    },
  );
});

test('target-specific compiler-rt layouts accept an unsuffixed shared ASan library', () => {
  runtimeFixture('x86_64-unknown-linux-gnu', ['libclang_rt.asan.so'], (compiler, directory) => {
    assert.equal(sharedAsanRuntime(compiler), path.join(directory, 'libclang_rt.asan.so'));
  });
});

test('a missing target runtime fails instead of loading another architecture', () => {
  runtimeFixture('aarch64-unknown-linux-gnu', ubuntuMultiarch, (compiler) => {
    assert.throws(
      () => sharedAsanRuntime(compiler),
      /ASan runtime for aarch64-unknown-linux-gnu was not found/,
    );
  });
});

test(
  'real Nitro workers recover after pthread creation failures',
  { skip: supported ? false : 'pthread injection requires macOS or Linux', timeout: 120000 },
  () => {
    withTemporaryDirectory('nitro-xxhash-threadpool-startup-', (work) => {
      const compiler = requiredExecutable('clang++');
      const nitro = path.join(ROOT, 'node_modules/react-native-nitro-modules/cpp');
      const includes = nitroHeaderMap(nitro, path.join(work, 'NitroModules'));
      const fixture = path.join(ROOT, 'tests/native/threadpool-startup');
      const variants = sources(path.join(nitro, 'threading/ThreadPool.cpp'));
      const libraries = process.platform === 'linux' ? ['-ldl'] : [];
      for (const sanitizer of [[], ['-fsanitize=address,undefined', '-fno-sanitize-recover=all']]) {
        const mode = sanitizer.length ? 'sanitized' : 'release';
        let sanitizerRuntime;
        const sharedSanitizer = [];
        if (sanitizer.length && process.platform === 'linux') {
          // A static ASan pthread interceptor in the main executable can bypass
          // LD_PRELOAD. A shared runtime first forwards through our real hook.
          sanitizerRuntime = sharedAsanRuntime(compiler);
          const directory = path.dirname(sanitizerRuntime);
          sharedSanitizer.push('-shared-libasan', `-Wl,-rpath,${directory}`);
        }
        const hook = path.join(work, `${mode}.${process.platform === 'darwin' ? 'dylib' : 'so'}`);
        run(compiler, [
          '-std=c++20',
          '-O2',
          '-pthread',
          ...sanitizer,
          ...sharedSanitizer,
          ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-fPIC']),
          path.join(fixture, 'pthread-failure.cpp'),
          ...libraries,
          '-o',
          hook,
        ]);
        for (const variant of sanitizer.length ? ['fixed'] : ['clean', 'fixed']) {
          const source = path.join(work, `${variant}.cpp`);
          fs.writeFileSync(source, variants[variant]);
          const binary = path.join(work, `${variant}-${mode}`);
          run(compiler, [
            '-std=c++20',
            '-O2',
            '-DNDEBUG',
            '-pthread',
            ...sanitizer,
            ...sharedSanitizer,
            '-I',
            work,
            '-I',
            path.join(ROOT, 'node_modules/react-native/ReactCommon/jsi'),
            ...includes.flatMap((directory) => ['-I', directory]),
            source,
            path.join(fixture, 'main.cpp'),
            ...libraries,
            '-o',
            binary,
          ]);
          for (const scenario of scenarios) {
            const result = child(binary, hook, scenario, sanitizerRuntime);
            if (variant === 'clean' && scenario === 'failure-second') {
              assert.match(result.stderr, /INJECTED pthread_create EAGAIN at 2/);
              if (result.error?.code === 'ETIMEDOUT') {
                // Some standard libraries wait in condition_variable destruction
                // before reaching the joinable std::thread destructor.
                assert.equal(result.signal, 'SIGKILL');
              } else {
                assert.ifError(result.error);
                assert.equal(result.signal, null, result.stderr);
                assert.equal(result.status, 86, result.stderr);
                assert.match(result.stderr, /TERMINATE: partially started pool/);
              }
            } else if (variant === 'clean' && scenario === 'expansion') {
              assert.ifError(result.error);
              assert.equal(result.signal, null, result.stderr);
              assert.equal(result.status, 41, result.stderr);
              assert.match(result.stderr, /INJECTED pthread_create EAGAIN at 2/);
              assert.match(result.stderr, /EXPANSION_RETRY_MISSING/);
            } else requirePass(result, scenario);
          }
          console.log(`${variant} ${mode}: pthread startup/expansion failure checks passed`);
        }
      }
    });
  },
);
