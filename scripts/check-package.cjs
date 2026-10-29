const assert = require('node:assert/strict');
const { existsSync, readFileSync } = require('node:fs');
const { basename, resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseNpmPackResult } = require('./npm-pack-result.cjs');

const root = resolve(__dirname, '..');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
assert.equal(pkg.name, 'react-native-nitro-xxhash');
assert.notEqual(pkg.private, true, 'The package must be publishable');
assert.equal(pkg.license, 'MIT');
assert.equal(pkg.publishConfig.access, 'public');
assert.equal(pkg.peerDependencies['react-native-nitro-modules'], '0.37.1');
assert.equal(pkg.devDependencies.nitrogen, '0.37.1');
assert.equal(pkg.devDependencies['react-native-nitro-modules'], '0.37.1');
assert.equal(pkg.peerDependencies['react-native'], '>=0.88.0');
assert.equal(pkg.engines.node, '^22.13.0 || ^24.3.0 || >=26.0.0');
assert.equal(pkg.peerDependencies.expo, '^58.0.0');
assert.equal(pkg.peerDependenciesMeta.expo.optional, true);
assert.equal(pkg.bin['nitro-xxhash-compat'], 'compat/cli.cjs');
assert.equal(pkg.scripts.postinstall, undefined, 'Compatibility repair must remain opt-in');
assert.equal(
  pkg.repository.url,
  'git+https://github.com/NikitaDudin/react-native-nitro-xxhash.git',
);

const npmExecPath = process.env.npm_execpath;
const npmPath = npmExecPath && basename(npmExecPath) === 'npm-cli.js' ? npmExecPath : undefined;
const command = npmPath ? process.execPath : 'npm';
const args = ['pack', '--dry-run', '--json', '--ignore-scripts'];
if (npmPath) args.unshift(npmPath);
const result = spawnSync(command, args, {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const tarball = parseNpmPackResult(result.stdout, pkg.name);
const paths = new Set(tarball.files.map((file) => file.path));
const compatibilityCli = tarball.files.find((file) => file.path === pkg.bin['nitro-xxhash-compat']);
assert(
  compatibilityCli && (compatibilityCli.mode & 0o111) !== 0,
  'Publish an executable compatibility CLI',
);
const required = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  pkg.bin['nitro-xxhash-compat'],
  'compat/apply.cjs',
  'compat/patches.json',
  'compat/LICENSE.Nitro',
  'app.plugin.js',
  'plugin/withNitroXxhash.cjs',
  pkg.main.replace(/^\.\//, ''),
  pkg.types.replace(/^\.\//, ''),
  pkg['react-native'].replace(/^\.\//, ''),
  'lib/native/NativeXXHashLoader.js',
  'native/NativeXXHashLoader.ts',
  'src/specs/FileHasher.nitro.ts',
  'src/specs/HashState.nitro.ts',
  'src/specs/HashFileTask.nitro.ts',
  'src/hashStreamInput.ts',
  'lib/src/hashStreamInput.js',
  'cpp/vendor/xxhash.h',
  'cpp/vendor/LICENSE.xxHash',
  'cpp/HybridFileHasher.cpp',
  'cpp/HybridHashState.cpp',
  'cpp/HybridHashFileTask.cpp',
  'nitro.json',
  'xxHash.podspec',
  'react-native.config.js',
  'android/build.gradle',
  'android/CMakeLists.txt',
  'android/src/main/AndroidManifest.xml',
  'android/src/main/cpp/JNIOnLoad.cpp',
  'android/src/main/java/com/margelo/nitro/xxhash/XXHashPackage.java',
  'android/src/main/java/com/margelo/nitro/xxhash/XXHashLoaderModule.java',
  'nitrogen/generated/shared/c++/HybridFileHasherSpec.hpp',
  'nitrogen/generated/shared/c++/HybridHashStateSpec.hpp',
  'nitrogen/generated/shared/c++/HybridHashFileTaskSpec.hpp',
  'nitrogen/generated/ios/xxHash+autolinking.rb',
  'nitrogen/generated/ios/xxHashAutolinking.mm',
  'nitrogen/generated/android/xxHash+autolinking.cmake',
  'nitrogen/generated/android/xxHashOnLoad.cpp',
];
for (const path of required) {
  assert(paths.has(path), `Missing published file: ${path}`);
  assert(existsSync(resolve(root, path)), `Missing local file: ${path}`);
}
for (const path of paths) {
  assert(!path.startsWith('example/'), `Example application must not be published: ${path}`);
  assert(!path.startsWith('website/'), `Documentation tooling must not be published: ${path}`);
  assert(
    !['docs/contributing.md', 'docs/api/exports.md'].includes(path),
    `Generated documentation must not be published: ${path}`,
  );
  assert(
    !/(^|\/)(node_modules|tests|\.cxx|\.gradle|build|\.git)(\/|$)/.test(path),
    `Unexpected development artifact: ${path}`,
  );
  assert(!/\.(tgz|log|pyc)$/.test(path), `Unexpected artifact: ${path}`);
  assert(
    !/^(?:src|lib\/src)\/(?:hash64|hash128|hashFile64|hashFile128|createLazyMethod)\./.test(path),
    `Removed alias implementation must not be published: ${path}`,
  );
}
const podspec = readFileSync(resolve(root, 'xxHash.podspec'), 'utf8');
assert(podspec.includes(":ios => '15.1'"), 'Keep the supported iOS baseline at 15.1');
assert(
  readFileSync(resolve(root, 'android/build.gradle'), 'utf8').includes('Math.max(24,'),
  'Keep the supported Android baseline at API 24',
);
assert(podspec.includes('https://github.com/NikitaDudin/react-native-nitro-xxhash.git'));
assert(podspec.includes('v#{s.version}'), 'CocoaPods source must track the version tag');
console.log(
  `Verified ${tarball.files.length} published files (${tarball.unpackedSize} bytes unpacked).`,
);
