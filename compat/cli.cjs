#!/usr/bin/env node
const { runCompatibility } = require('./apply.cjs');

const HELP = `Usage: nitro-xxhash-compat [--check] [--nitro-path PATH]

Explicitly repair Nitro 0.37.1 cache/reference lifetimes and runtime registries; apply
the upstream Xcode 27/iOS below 18 exception fixes. No automatic hook is used.

  --check             Read-only check: exit 0 fixed, 1 needs patch, 2 error
  --nitro-path PATH   Select the installed react-native-nitro-modules directory
  --help              Show this help

Resolves Nitro from the current project first, then the helper installation.
An unsupported consumer version is never replaced by a fallback dependency.
After applying, rebuild Nitro and every native C++/Swift consumer of Nitro headers.
Read-only/PnP stores: use your package manager's patched-dependency workflow
with compat/patches.json instead of changing immutable dependency files.
iOS upstream: https://github.com/margelo/nitro/pull/1824
Cache/reference/registry repairs are local. Object layouts are unchanged; compiled Nitro code also changes.
`;

function parseArguments(arguments_) {
  const options = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--help') options.help = true;
    else if (argument === '--check' && !options.check) options.check = true;
    else if (argument === '--nitro-path' && options.nitroPath === undefined) {
      const path = arguments_[index + 1];
      if (!path || path.startsWith('--'))
        throw new Error('--nitro-path requires a package directory');
      options.nitroPath = path;
      index += 1;
    } else throw new Error(`Unknown or repeated argument: ${argument}`);
  }
  return options;
}

function main(arguments_ = process.argv.slice(2)) {
  try {
    const options = parseArguments(arguments_);
    if (options.help) {
      process.stdout.write(HELP);
      return 0;
    }
    const result = runCompatibility(options);
    const description =
      result.status === 'applied'
        ? 'Applied the Nitro compatibility repairs'
        : result.status === 'already-fixed'
          ? 'Nitro compatibility repairs are already present'
          : 'Nitro needs the compatibility repairs';
    console.log(`${description}: ${result.directory} (${result.version})`);
    if (result.status === 'applied')
      console.log('Rebuild Nitro and every native C++/Swift consumer of Nitro headers.');
    return options.check && result.status === 'needs-patch' ? 1 : 0;
  } catch (error) {
    console.error(`nitro-xxhash-compat: ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main();
module.exports = { main, parseArguments };
