---
title: Compatibility
description: React Native, Nitro, platform and native toolchain requirements, compatibility repairs, and host application configuration.
---

## Versions and platform baseline

| Component     | Requirement                                                            |
| ------------- | ---------------------------------------------------------------------- |
| React Native  | 0.88.0 or newer, New Architecture / JSI.                               |
| Nitro Modules | Exactly 0.37.1 on both platforms.                                      |
| Node.js       | `^22.13.0 \|\| ^24.3.0 \|\| >=26.0.0`.                                 |
| iOS           | 15.1 or newer; newer React Native requirements still apply.            |
| Android       | API 24 or newer; Java 17 and C++20.                                    |
| Android ABIs  | armeabi-v7a, arm64-v8a, x86 and x86_64; flexible 16 KiB pages enabled. |

Native toolchains must also satisfy [Nitro's requirements](https://nitro.margelo.com/docs/getting-started/minimum-requirements): Xcode 16.4+, Swift 5.9+, Android compile SDK 34+ and NDK 27+.

On iOS, keep the React Native template's application deployment target and Podfile helper:

```ruby
platform :ios, min_ios_version_supported
```

The library's podspec declares 15.1; React Native and other dependencies may require a higher application target. Rebuild the native app after installation. Expo requires a development build; Expo Go, web and remote JavaScript debugging are unsupported.

Do not link this package alongside another copy of the native `xxHash` module: their native library and HybridObject registration identities collide.

### iOS app lifecycle with Xcode 27

Apps built with the iOS 27 SDK must adopt [UIKit's scene lifecycle](https://developer.apple.com/documentation/uikit/transitioning-to-the-uikit-scene-based-life-cycle) to launch on iOS 27. Configure `UIApplicationSceneManifest`, a single app-owned `UIWindowSceneDelegate` and `UIWindow(windowScene:)`.

Use [React Native's SceneDelegate entry points and migration instructions](https://reactnative.dev/blog/2026/10/19/react-native-0.88#ios-scenedelegate-support), preserving application bootstrap, initial URLs, user activities and window behavior. The Nitro helper does not configure application lifecycle.

### iOS Debug hashing

In the standard `Debug` configuration, CocoaPods applies `-O2` only to `FileDigest.cpp` and `Armv7Neon.cpp`. Wrappers and generated bindings keep the target's Debug settings, symbols and checks. Optimized kernel code can skip or reorder source lines while stepping.

Set the Xcode build setting `XXHASH_OPTIMIZE_DEBUG=NO` to debug unoptimized kernels; this takes effect without reinstalling Pods. For a persistent generated default, run `XXHASH_OPTIMIZE_DEBUG=NO pod install` from the app's `ios/` directory. Use `YES` to restore the default. Rebuild the native target after changing either setting. The root pod continues to select both implementation subspecs automatically.

### iOS Release hashing

In the standard `Release` configuration, the same two kernels use `-O2` by default; wrappers and generated bindings inherit the host's Release flags. Set the independent Xcode build setting `XXHASH_OPTIMIZE_RELEASE=NO` to retain the host's optimization for kernels too, commonly `-Os`. For a persistent generated default, run `XXHASH_OPTIMIZE_RELEASE=NO pod install`. Use `YES` to restore `-O2`, and rebuild the native target after changing either setting. Debug configuration is controlled separately by `XXHASH_OPTIMIZE_DEBUG`.

## Expo prebuild

Expo SDK 58 applications can use the bundled [config plugin](expo.md) to prepare Nitro during native generation. The Expo guide owns plugin options, setup and prebuild limitations.

## Android host configuration

The host supplies AGP and the React Native Gradle plugin. Shared `rootProject.ext` values override the library defaults:

| Property            | Default                                                      |
| ------------------- | ------------------------------------------------------------ |
| `minSdkVersion`     | 24; lower values are clamped to 24.                          |
| `compileSdkVersion` | 37                                                           |
| `targetSdkVersion`  | 36                                                           |
| `ndkVersion`        | 27.1.12297006; an explicit host `ndkPath` is also supported. |

Expose these shared values when using a version catalog or configuring SDKs only in the app module. The application owns its final target SDK. The package does not pin AGP; the [RN 0.88 version catalog](https://github.com/facebook/react-native/blob/v0.88.0/packages/react-native/gradle/libs.versions.toml) provides its standard toolchain versions.

### Android Debug hashing

Android Debug builds compile only the hashing kernels (`FileDigest.cpp` and `Armv7Neon.cpp`) with `-O2` by default. xxHash's hot loops depend on compiler optimization and inlining; the JSI wrappers and other sources retain the host's Debug flags, debug symbols and checks. Release flags are unchanged. Stepping through optimized kernel code can skip or reorder source lines.

For unoptimized kernel debugging, set `xxhashOptimizeDebug=false` in the application's `android/gradle.properties`, or pass `-PxxhashOptimizeDebug=false` to its Gradle build. The library always forwards `XXHASH_OPTIMIZE_DEBUG=ON` or `OFF` to CMake, so changing this property updates an existing native build cache. Direct CMake consumers can use `-DXXHASH_OPTIMIZE_DEBUG=OFF`; the option defaults to `ON`. Rebuild the Android native library after changing it.

### Android Gradle Plugin 9

Nitro 0.37.1 applies the Kotlin Android plugin and uses legacy Gradle APIs. AGP 9 hosts need these application `gradle.properties` settings:

```properties
android.builtInKotlin=false
android.newDsl=false
```

AGP 8 hosts do not need these switches. For Expo prebuild, the [config plugin](#expo-prebuild) can write them when `android.agp9Compatibility` is explicitly enabled; otherwise configure them in the host. See [AGP 9 migration guidance](https://developer.android.com/build/releases/agp-9-0-0-release-notes) and [built-in Kotlin migration](https://developer.android.com/build/migrate-to-built-in-kotlin). Using AGP 9 built-in Kotlin requires compatible changes in Nitro.

## Nitro 0.37.1 repairs

Install the exact required peer and apply the explicit compatibility helper from your application root:

**npm**

```sh
npm install react-native-nitro-xxhash react-native-nitro-modules@0.37.1
npx --no-install nitro-xxhash-compat
```

**Yarn**

```sh
yarn add react-native-nitro-xxhash react-native-nitro-modules@0.37.1
yarn nitro-xxhash-compat
```

Run this on **Android and iOS before any native build or pod install**. Expo projects using the [config plugin](#expo-prebuild) in `"apply"` mode perform this step during prebuild. The helper repairs Nitro cache/reference lifetimes, runtime registries and Xcode 27 exception interoperability. It validates the installed version and known source contents before changing files; unsupported versions or conflicting patches are refused. [Repair definitions](https://github.com/NikitaDudin/react-native-nitro-xxhash/blob/main/compat/patches.json) record the exact changes and their provenance.

The command changes the installed Nitro dependency shared by every Nitro library in the app. Clean stale native build artifacts and **rebuild Nitro and all native C++/Swift consumers of its headers together**. Do not mix repaired headers with prebuilt binaries compiled from the original sources.

There is no automatic library `postinstall`. Reapply the helper after dependency reinstalls, including `npm ci` or `yarn install`. Repeated application is safe. An application may append `nitro-xxhash-compat` to its existing root `postinstall`; preserve other commands in that hook.

### Inspect or select an installation

**npm**

```sh
# Inspect without changing files.
npx --no-install nitro-xxhash-compat --check

# Select a specific unpacked Nitro installation.
npx --no-install nitro-xxhash-compat --nitro-path /absolute/path/to/react-native-nitro-modules

npx --no-install nitro-xxhash-compat --help
```

**Yarn**

```sh
yarn nitro-xxhash-compat --check
yarn nitro-xxhash-compat --nitro-path /absolute/path/to/react-native-nitro-modules
yarn nitro-xxhash-compat --help
```

With no flags the command applies repairs. `--check` exits with 0 when all repairs are present, 1 when application is needed, or 2 on an error. Do not suppress failures.

### Yarn PnP and read-only dependency stores

Yarn Classic uses the required `node_modules` layout by default. With modern Yarn, configure the application's `.yarnrc.yml` before installing native dependencies:

```yaml
nodeLinker: node-modules
```

The helper requires writable, unpacked Nitro sources. For PnP or read-only stores, use your package manager's dependency-patching workflow to create an editable Nitro 0.37.1 workspace, apply the helper with `--nitro-path`, review the changes and persist the patch. Do not modify a shared package cache in place. If an editable workspace cannot be created, use the shipped repair definitions with the package manager's native patch mechanism.

If the application already maintains custom Nitro patches, merge these repair definitions into that patch while preserving the application's other fixes. Keep one patch owner; the helper intentionally rejects differing sources, so do not chain it after a custom patch.

## Xcode 27 below iOS 18

Nitro 0.37.1's Swift/C++ exception conversion can import an iOS 18-only libc++ symbol under Xcode 27. The compatibility helper includes the required exception backport for older deployment targets. Raising or lowering the deployment target alone does not replace that repair. See the [upstream issue](https://github.com/margelo/nitro/issues/1652) and [fix](https://github.com/margelo/nitro/pull/1824).
