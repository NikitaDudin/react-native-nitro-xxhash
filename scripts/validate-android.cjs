const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { copyAndroidValidationFixture } = require('./copy-android-validation-fixture.cjs');
const { resolveAndroidValidationConfig } = require('./android-validation-config.cjs');
const {
  sourceManifest,
  verifySourceManifest,
} = require('../tests/native/strings/source-manifest.cjs');

const repository = path.resolve(__dirname, '..');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const config = resolveAndroidValidationConfig(process.argv.slice(2), process.env, repository);
const { profile, dependenciesRoot, outputDirectory, keepFixture, configOnly } = config;
const {
  ndkVersion,
  minSdk,
  compileSdk,
  targetSdk,
  buildTools,
  kotlinVersion,
  agp,
  reactNative,
  gradleVersion,
} = profile;
const architectures = ['armeabi-v7a', 'arm64-v8a', 'x86', 'x86_64'];
if (!sdk || !fs.existsSync(path.join(sdk, 'ndk', ndkVersion))) {
  throw new Error(
    `Set ANDROID_HOME to an Android SDK containing NDK ${ndkVersion}, API ${compileSdk} and CMake 3.22.1.`,
  );
}

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nitro-xxhash-android-'));
function write(relative, contents) {
  const target = path.join(fixture, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}
function dependency(name) {
  return path.dirname(require.resolve(`${name}/package.json`, { paths: [dependenciesRoot] }));
}

const installedReactNative = require(path.join(dependency('react-native'), 'package.json')).version;
if (installedReactNative !== reactNative) {
  throw new Error(
    `Profile ${profile.name} requires React Native ${reactNative}; found ${installedReactNative} in ${dependenciesRoot}.`,
  );
}
if (outputDirectory) fs.mkdirSync(outputDirectory, { recursive: true });
copyAndroidValidationFixture(repository, path.join(fixture, 'library'));
copyAndroidValidationFixture(dependency('react-native-nitro-modules'), path.join(fixture, 'nitro'));
copyAndroidValidationFixture(
  dependency('@react-native/gradle-plugin'),
  path.join(fixture, 'gradle-plugin'),
);
fs.symlinkSync(
  path.join(dependenciesRoot, 'node_modules'),
  path.join(fixture, 'node_modules'),
  'dir',
);
write('gradle-plugin/gradle.properties', 'kotlin.compiler.execution.strategy=in-process\n');
const repair = spawnSync(
  process.execPath,
  [path.join(repository, 'compat/cli.cjs'), '--nitro-path', path.join(fixture, 'nitro')],
  { stdio: 'inherit' },
);
if (repair.error || repair.status !== 0)
  throw repair.error || new Error('Could not repair the isolated Nitro copy.');
const packageScopes = [
  'cpp',
  'android/build.gradle',
  'android/CMakeLists.txt',
  'android/src',
  'nitrogen/generated',
];
const nitroScopes = [
  'cpp',
  'ios',
  'android/src',
  'android/build.gradle',
  'android/gradle.properties',
  'package.json',
];
const sources = {
  package: sourceManifest(repository, packageScopes),
  fixturePackage: sourceManifest(path.join(fixture, 'library'), packageScopes),
  nitro: sourceManifest(dependency('react-native-nitro-modules'), nitroScopes),
  fixtureNitro: sourceManifest(path.join(fixture, 'nitro'), nitroScopes),
};
if (JSON.stringify(sources.package) !== JSON.stringify(sources.fixturePackage))
  throw new Error('Android fixture production sources differ from the repository.');
if (outputDirectory)
  fs.writeFileSync(
    path.join(outputDirectory, 'source-before.json'),
    JSON.stringify(sources, null, 2) + '\n',
  );
function verifySources() {
  for (const [key, base, scopes] of [
    ['package', repository, packageScopes],
    ['fixturePackage', path.join(fixture, 'library'), packageScopes],
    ['nitro', dependency('react-native-nitro-modules'), nitroScopes],
    ['fixtureNitro', path.join(fixture, 'nitro'), nitroScopes],
  ])
    verifySourceManifest(base, scopes, sources[key], key);
  if (outputDirectory)
    fs.writeFileSync(
      path.join(outputDirectory, 'source-after.json'),
      JSON.stringify(sources, null, 2) + '\n',
    );
}
write(
  'android/settings.gradle',
  `pluginManagement {
  includeBuild('../gradle-plugin')
  repositories { google(); mavenCentral(); gradlePluginPortal() }
}
rootProject.name = 'NitroXxHashValidation'
include ':app', ':react-native-nitro-modules', ':react-native-nitro-xxhash'
project(':react-native-nitro-modules').projectDir = file('../nitro/android')
project(':react-native-nitro-xxhash').projectDir = file('../library/android')
includeBuild('../gradle-plugin')
`,
);
write(
  'android/build.gradle',
  `buildscript {
  ext {
    minSdkVersion = ${minSdk}
    compileSdkVersion = ${compileSdk}
    targetSdkVersion = ${targetSdk}
    buildToolsVersion = '${buildTools}'
    ndkVersion = '${ndkVersion}'
    kotlinVersion = '${kotlinVersion}'
  }
  repositories { google(); mavenCentral() }
  dependencies {
    classpath 'com.android.tools.build:gradle:${agp}'
    classpath 'com.facebook.react:react-native-gradle-plugin'
    classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:${kotlinVersion}'
  }
}
allprojects { repositories { google(); mavenCentral() } }
apply plugin: 'com.facebook.react.rootproject'

tasks.register('reportToolchain') {
  doLast {
    def sdkLevel = { value -> value instanceof Number ? value.intValue() : value?.apiLevel }
    def projectsToCheck = [project(':app'), project(':react-native-nitro-modules'), project(':react-native-nitro-xxhash')]
    def modules = projectsToCheck.collectEntries { module ->
      def androidPlugin = module.plugins.findPlugin('com.android.application') ?: module.plugins.getPlugin('com.android.library')
      def actualAgp = androidPlugin.class.classLoader.loadClass('com.android.Version').getField('ANDROID_GRADLE_PLUGIN_VERSION').get(null)
      def model = module.extensions.getByName('android')
      [(module.path): [agp: actualAgp, compileSdk: model.compileSdk, minSdk: sdkLevel(model.defaultConfig.minSdk), targetSdk: sdkLevel(model.defaultConfig.targetSdk), ndkVersion: model.ndkVersion]]
    }
    def report = [gradle: gradle.gradleVersion, reactNative: '${reactNative}', profile: '${profile.name}', modules: modules]
    file('../toolchain.json').text = groovy.json.JsonOutput.prettyPrint(groovy.json.JsonOutput.toJson(report))
    modules.each { name, values ->
      if (values.agp != '${agp}' || values.minSdk != ${minSdk} || values.compileSdk != ${compileSdk} || values.targetSdk != ${targetSdk} || values.ndkVersion != '${ndkVersion}') {
        throw new GradleException("Unexpected toolchain for " + name + ": " + values)
      }
    }
    if (gradle.gradleVersion != '${gradleVersion}') throw new GradleException('Unexpected Gradle version: ' + gradle.gradleVersion)
  }
}

tasks.register('verifyXxHashAar') {
  dependsOn(':react-native-nitro-xxhash:assembleRelease')
  doLast {
    def library = project(':react-native-nitro-xxhash')
    def aar = library.layout.buildDirectory.file('outputs/aar/react-native-nitro-xxhash-release.aar').get().asFile
    new java.util.zip.ZipFile(aar).withCloseable { archive ->
      def entries = Collections.list(archive.entries()).findAll { !it.directory }.collect { it.name }
      def actual = entries.findAll { it.startsWith('jni/') && it.endsWith('.so') }.toSet()
      def expected = ${JSON.stringify(architectures)}.collect { 'jni/' + it + '/libNitroFileHash.so' }.toSet()
      if (actual != expected) {
        throw new GradleException("Unexpected xxhash AAR native libraries: " + actual.sort())
      }
      def classes = archive.getEntry('classes.jar')
      def manifest = archive.getEntry('AndroidManifest.xml')
      if (classes == null || manifest == null) {
        throw new GradleException('The xxhash AAR must include classes.jar and AndroidManifest.xml')
      }
      def classNames = [] as Set
      new java.util.jar.JarInputStream(archive.getInputStream(classes)).withCloseable { jar ->
        for (def entry = jar.nextJarEntry; entry != null; entry = jar.nextJarEntry) {
          if (!entry.directory) classNames.add(entry.name)
        }
      }
      def requiredClasses = [
        'NitroFileHashPackage', 'NitroFileHashLoaderModule', 'NativeNitroFileHashLoaderSpec'
      ].collect { 'com/margelo/nitro/filehash/' + it + '.class' }
      if (!classNames.containsAll(requiredClasses)) {
        throw new GradleException('Missing xxhash AAR classes: ' + (requiredClasses - classNames))
      }
      def parser = javax.xml.parsers.DocumentBuilderFactory.newInstance()
      parser.namespaceAware = true
      parser.setFeature('http://apache.org/xml/features/disallow-doctype-decl', true)
      archive.getInputStream(manifest).withCloseable { input ->
        def usesSdk = parser.newDocumentBuilder().parse(input).getElementsByTagName('uses-sdk')
        if (usesSdk.length != 1 || usesSdk.item(0).getAttributeNS('http://schemas.android.com/apk/res/android', 'minSdkVersion') != '${minSdk}') {
          throw new GradleException('The xxhash AAR must declare minSdkVersion ${minSdk}')
        }
      }
    }
  }
}
`,
);
write(
  'android/gradle.properties',
  `org.gradle.jvmargs=-Xmx6g -XX:MaxMetaspaceSize=2g
org.gradle.workers.max=8
android.useAndroidX=true
${profile.agp9Compatibility ? 'android.builtInKotlin=false\nandroid.newDsl=false\n' : ''}newArchEnabled=true
reactNativeArchitectures=${architectures.join(',')}
kotlin.compiler.execution.strategy=in-process
`,
);
write('android/local.properties', `sdk.dir=${sdk.replaceAll('\\', '\\\\')}\n`);
function writeApplication(prebuilt) {
  write(
    'android/app/build.gradle',
    `plugins {
  id 'com.android.application'
  id 'com.facebook.react'
}
react {
  // This Java/native consumer fixture has no JS entry point. Skip bundling
  // while keeping the Android Release build type and native compilation.
  debuggableVariants = ['release']
}
android {
  namespace = 'com.nitroxxhash.validation'
  compileSdk = ${compileSdk}
  ndkVersion = rootProject.ext.ndkVersion
  defaultConfig {
    applicationId = 'com.nitroxxhash.validation'
    minSdk = ${minSdk}
    targetSdk = ${targetSdk}
    versionCode = 1
    versionName = '1.0'
  }
}
dependencies {
  implementation 'com.facebook.react:react-android'
  implementation 'com.facebook.react:hermes-android'
  implementation project(':react-native-nitro-modules')
  implementation ${prebuilt ? "files('../../library/android/build/outputs/aar/react-native-nitro-xxhash-release.aar')" : "project(':react-native-nitro-xxhash')"}
}
`,
  );
}
writeApplication(false);
write(
  'android/app/src/main/AndroidManifest.xml',
  '<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>\n',
);
write(
  'android/app/src/main/java/com/nitroxxhash/validation/ConsumerProbe.java',
  `package com.nitroxxhash.validation;

import com.facebook.react.bridge.ReactApplicationContext;
import com.margelo.nitro.filehash.NativeNitroFileHashLoaderSpec;
import com.margelo.nitro.filehash.NitroFileHashLoaderModule;
import com.margelo.nitro.filehash.NitroFileHashPackage;

public final class ConsumerProbe {
  public static NitroFileHashPackage createPackage() { return new NitroFileHashPackage(); }
  public static NativeNitroFileHashLoaderSpec createLoader(ReactApplicationContext context) {
    return new NitroFileHashLoaderModule(context);
  }
}
`,
);
write(
  'android/build/generated/autolinking/autolinking.json',
  JSON.stringify({
    root: fixture,
    reactNativePath: path.join(fixture, 'node_modules/react-native'),
    dependencies: {},
    project: {
      android: {
        sourceDir: path.join(fixture, 'android'),
        appName: 'app',
        packageName: 'com.nitroxxhash.validation',
      },
    },
  }),
);

const environment = {
  ...process.env,
  SKIP_BUILD_ARTIFACT_UPLOADS: '1',
  GRADLE_USER_HOME: process.env.GRADLE_USER_HOME || path.join(fixture, 'gradle-home'),
  CMAKE_BUILD_PARALLEL_LEVEL: '8',
  CCACHE_DIR: path.join(fixture, 'ccache'),
};
const cachedDependencies = path.join(os.homedir(), '.gradle/caches');
if (!environment.GRADLE_RO_DEP_CACHE && fs.existsSync(cachedDependencies)) {
  environment.GRADLE_RO_DEP_CACHE = cachedDependencies;
}
console.log(`Building isolated Android fixture (${profile.name}): ${fixture}`);
const runs = [];
function gradle(tasks) {
  const started = new Date().toISOString();
  const result = spawnSync(
    config.gradleBin,
    [...tasks, '--no-daemon', '--console=plain', '--max-workers=8'],
    { cwd: path.join(fixture, 'android'), env: environment, stdio: 'inherit' },
  );
  runs.push({
    tasks,
    started,
    ended: new Date().toISOString(),
    status: result.status,
    signal: result.signal,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`Gradle exited with status ${result.status}`);
}

try {
  gradle([':reportToolchain']);
  if (!configOnly) {
    gradle([
      ':react-native-nitro-xxhash:compileReleaseJavaWithJavac',
      ':verifyXxHashAar',
      ':app:compileReleaseJavaWithJavac',
      ':app:checkReleaseDuplicateClasses',
      ':app:mergeReleaseNativeLibs',
      ':app:mergeReleaseJavaResource',
    ]);
    // A prebuilt AAR must not rebundle Nitro/React Native libraries. Project
    // dependency filtering and the RN plugin's pickFirsts can hide that defect.
    writeApplication(true);
    gradle([
      ':app:compileReleaseJavaWithJavac',
      ':app:checkReleaseDuplicateClasses',
      ':app:mergeReleaseNativeLibs',
      ':app:mergeReleaseJavaResource',
    ]);
  }
  verifySources();
  console.log(
    configOnly
      ? 'Android host and Nitro toolchain configuration passed.'
      : 'Android Java/codegen, four-ABI AAR contents, and project/prebuilt consumer merges passed.',
  );
  if (outputDirectory) {
    fs.copyFileSync(
      path.join(fixture, 'toolchain.json'),
      path.join(outputDirectory, 'toolchain.json'),
    );
    let aar;
    if (!configOnly) {
      const builtAar = path.join(
        fixture,
        'library/android/build/outputs/aar/react-native-nitro-xxhash-release.aar',
      );
      const bytes = fs.readFileSync(builtAar);
      aar = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
      fs.copyFileSync(
        builtAar,
        path.join(outputDirectory, 'react-native-nitro-xxhash-release.aar'),
      );
    }
    fs.writeFileSync(
      path.join(outputDirectory, 'validation-result.json'),
      JSON.stringify({ status: 'passed', fixture, profile, configOnly, runs, aar }, null, 2) + '\n',
    );
  }
  if (keepFixture) console.log('Fixture retained: ' + fixture);
  else fs.rmSync(fixture, { recursive: true, force: true });
} catch (error) {
  if (outputDirectory)
    fs.writeFileSync(
      path.join(outputDirectory, 'validation-result.json'),
      JSON.stringify({ status: 'failed', fixture, profile, runs, error: error.message }, null, 2) +
        '\n',
    );
  console.error(error);
  console.error(`Fixture retained for investigation: ${fixture}`);
  process.exitCode = 1;
}
