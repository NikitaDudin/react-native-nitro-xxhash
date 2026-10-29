const fs = require('node:fs');
const path = require('node:path');
const { run } = require('../../../scripts/native-test-utils.cjs');

/** Resolve the runtime for Clang's target, even when compiler-rt contains several ABIs. */
function sharedAsanRuntime(compiler) {
  const target = run(compiler, ['-dumpmachine']).stdout.trim();
  const architecture = target.split('-')[0];
  // Clang's 32-bit x86 target triples include i486/i586/i686, but compiler-rt
  // uses i386 in the library basename for all of them.
  const runtimeArchitecture = /^i[3-6]86$/.test(architecture) ? 'i386' : architecture;
  if (!/^[a-zA-Z0-9_]+$/.test(runtimeArchitecture))
    throw new Error(`Cannot determine Clang's target architecture: ${target}`);
  const directory = run(compiler, ['--print-runtime-dir']).stdout.trim();
  if (!path.isAbsolute(directory))
    throw new Error(`Cannot determine Clang's runtime directory for ${target}: ${directory}`);
  // New compiler-rt layouts have a target-specific directory and an unsuffixed
  // basename; older layouts put all suffixed architectures in one directory.
  for (const name of ['libclang_rt.asan.so', `libclang_rt.asan-${runtimeArchitecture}.so`]) {
    const runtime = path.join(directory, name);
    try {
      if (fs.statSync(runtime).isFile()) return runtime;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    }
  }
  throw new Error(`Clang shared ASan runtime for ${target} was not found in ${directory}`);
}

module.exports = { sharedAsanRuntime };
