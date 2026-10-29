const fs = require('node:fs');
const path = require('node:path');

// This host deliberately overrides RN 0.88 defaults to exercise host ownership.
const profiles = {
  rn88: {
    name: 'rn88',
    reactNative: '0.88.0',
    agp: '9.3.1',
    gradleVersion: '9.6.0',
    ndkVersion: '30.0.16248370',
    kotlinVersion: '2.2.0',
    minSdk: 26,
    compileSdk: 37,
    targetSdk: 37,
    buildTools: '37.0.0',
    agp9Compatibility: true,
  },
};

function resolveAndroidValidationConfig(args, environment, repository) {
  const config = { dependenciesRoot: repository, keepFixture: false, configOnly: false };
  let profileName;
  for (let i = 0; i < args.length; i++) {
    const argument = args[i];
    if (argument === '--keep-fixture') config.keepFixture = true;
    else if (argument === '--config-only') config.configOnly = true;
    else if (['--profile', '--dependencies-root', '--output'].includes(argument)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${argument}`);
      if (argument === '--profile') profileName = value;
      else
        config[argument === '--output' ? 'outputDirectory' : 'dependenciesRoot'] =
          path.resolve(value);
    } else throw new Error(`Unknown Android validation option: ${argument}`);
  }
  if (!profileName) {
    const installed = JSON.parse(
      fs.readFileSync(
        path.join(config.dependenciesRoot, 'node_modules/react-native/package.json'),
        'utf8',
      ),
    ).version;
    profileName = Object.keys(profiles).find((name) => profiles[name].reactNative === installed);
  }
  if (!profiles[profileName])
    throw new Error('Choose the supported Android validation profile: --profile rn88.');
  config.profile = profiles[profileName];
  config.gradleBin = environment.GRADLE_BIN || 'gradle';
  return config;
}

module.exports = { profiles, resolveAndroidValidationConfig };
