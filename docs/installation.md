---
title: Installation
description: Install react-native-nitro-xxhash, apply the Nitro compatibility helper, and configure your Android or iOS application.
---

## Install the native dependencies

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

Nitro Modules is required on both platforms. Keep its version at exactly **0.37.1**: the shipped helper validates that source version before applying its repairs.

The Yarn commands assume a `node_modules` installation. For modern Yarn configuration and immutable dependency stores, see [Yarn and dependency patching](compatibility.md#yarn-pnp-and-read-only-dependency-stores).

Run the helper from your application root on **both Android and iOS**, before any native build or `pod install`. Expo SDK 58 projects using the [config plugin](expo.md) in `"apply"` mode perform this step during prebuild. It changes the installed Nitro source dependency shared by the application's Nitro libraries. After applying it, clean stale native build artifacts and rebuild Nitro and all of its native C++/Swift consumers together.

The package has no automatic `postinstall`. Dependency reinstalls can restore the original Nitro files, so repeat the command after installation. For optional app-owned hooks, inspection mode and package-manager patches, see [Nitro compatibility setup](compatibility.md#nitro-0371-repairs).

## iOS

Keep the application's deployment target and Podfile platform consistent with React Native, at least iOS 15.1:

```ruby
platform :ios, min_ios_version_supported
```

Then install Pods and rebuild the application:

```sh
cd ios
pod install
cd ..
```

From the application root, launch the native app:

**npm**

```sh
npx react-native run-ios
```

**Yarn**

```sh
yarn react-native run-ios
```

With Xcode 27, the helper also applies Nitro's exception interoperability repair for deployment below iOS 18. Apps built with the iOS 27 SDK need an app-owned UIScene lifecycle using React Native's SceneDelegate integration. Follow [the lifecycle instructions](compatibility.md#ios-app-lifecycle-with-xcode-27).

## Android

Rebuild the native application after installation. Autolinking discovers the library and its Nitro dependency; do not manually load or register the private native factory from application JavaScript.

From the application root:

**npm**

```sh
npx react-native run-android
```

**Yarn**

```sh
yarn react-native run-android
```

The host supplies AGP, SDK and NDK configuration. Defaults match RN 0.88: minimum SDK 24, compile SDK 37, target SDK 36 and NDK 27.1.12297006. Shared `rootProject.ext` values override the defaults. AGP 9 applications need Nitro's legacy Kotlin/DSL compatibility switches; see [Android host configuration](compatibility.md#android-host-configuration).

## Expo and unsupported runtimes

For Expo SDK 58, follow the bundled [config plugin setup](expo.md) and create a development build with these native dependencies installed. Expo Go, web and remote JavaScript debugging do not provide the native runtime required by this package. There is no Node.js implementation or worklet API.

The package does not install stream, AbortController or Buffer polyfills. Supply those APIs through your application's environment when using the corresponding input types or cancellation options.

## Make the first call

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const digest: string = xxh3_64('hello');
console.log(digest);
```

Public import leaves the Nitro JS proxy and Android library loader uninitialized. The first operation creates a cached native factory. If initialization fails, a later operation can retry; successful calls reuse the factory. On iOS, generated native constructor registration occurs separately at application startup.

Next, choose [one-shot hashing](api/one-shot.md), an [incremental hasher](api/create-hasher.md), [file hashing](guides/files.md) or [an asynchronous source](guides/streams.md).
