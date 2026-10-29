const { createRequire } = require('node:module');
const { dirname, join } = require('node:path');
const {
  createRunOncePlugin,
  withDangerousMod,
  withGradleProperties,
} = require('expo/config-plugins');
const { runCompatibility } = require('../compat/apply.cjs');
const { name, version } = require('../package.json');

function validateOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options))
    throw new Error(`${name}: plugin options must be an object`);
  for (const key of Object.keys(options)) {
    if (key !== 'nitroCompatibility' && key !== 'android')
      throw new Error(`${name}: unknown plugin option ${key}`);
  }
  const mode = options.nitroCompatibility === undefined ? 'apply' : options.nitroCompatibility;
  if (mode !== 'apply' && mode !== 'check')
    throw new Error(`${name}: nitroCompatibility must be "apply" or "check"`);
  if (options.android !== undefined) {
    if (!options.android || typeof options.android !== 'object' || Array.isArray(options.android))
      throw new Error(`${name}: android must be an object`);
    for (const key of Object.keys(options.android)) {
      if (key !== 'agp9Compatibility')
        throw new Error(`${name}: unknown android plugin option ${key}`);
    }
    if (
      options.android.agp9Compatibility !== undefined &&
      typeof options.android.agp9Compatibility !== 'boolean'
    )
      throw new Error(`${name}: android.agp9Compatibility must be a boolean`);
  }
  return { mode, agp9: options.android?.agp9Compatibility === true };
}

function withNitroCompatibility(config, platform, mode) {
  return withDangerousMod(config, [
    platform,
    (mod) => {
      // Config evaluation and introspection must never change dependency sources.
      if (mod.modRequest.introspect) return mod;
      try {
        // Resolve only the host's dependency; never fall back to a library dev copy.
        const projectRequire = createRequire(join(mod.modRequest.projectRoot, 'package.json'));
        const nitroPath = dirname(
          projectRequire.resolve('react-native-nitro-modules/package.json'),
        );
        const result = runCompatibility({ nitroPath, check: mode === 'check' });
        if (result.status === 'needs-patch')
          throw new Error(
            'Nitro compatibility repairs are missing. Apply nitro-xxhash-compat or persist ' +
              'the repairs with your package manager before using nitroCompatibility: "check".',
          );
        if (result.status === 'applied')
          console.log(
            `[${name}] Applied Nitro ${result.version} compatibility repairs. ` +
              'Rebuild Nitro and every native C++/Swift consumer of its headers together.',
          );
      } catch (error) {
        throw new Error(`${name}: ${error.message}`, { cause: error });
      }
      return mod;
    },
  ]);
}

function withNitroXxhash(config, options = {}) {
  const { mode, agp9 } = validateOptions(options);
  config = withNitroCompatibility(config, 'ios', mode);
  config = withNitroCompatibility(config, 'android', mode);
  if (agp9) {
    config = withGradleProperties(config, (mod) => {
      const keys = ['android.builtInKotlin', 'android.newDsl'];
      mod.modResults = mod.modResults.filter(
        (item) => item.type !== 'property' || !keys.includes(item.key),
      );
      for (const key of keys) mod.modResults.push({ type: 'property', key, value: 'false' });
      return mod;
    });
  }
  return config;
}

module.exports = createRunOncePlugin(withNitroXxhash, name, version);
