---
title: Expo config plugin
description: Configure Nitro compatibility repairs and optional AGP 9 settings during Expo prebuild.
---

The config plugin supports Expo SDK 58 (`expo` 58.x). Use the React Native version supported by that SDK; the package's React Native and Nitro requirements still apply. Expo projects must also satisfy their SDK’s own Node.js and native toolchain requirements. The plugin does not upgrade Expo or React Native. Expo Go is unsupported.

Expo SDK 58's native dependencies require iOS 16.4 or newer, even though the standalone library's podspec supports iOS 15.1. Keep the Expo application's deployment target at its SDK's requirement.

Install the package and its exact Nitro peer:

**npm**

```sh
npx expo install react-native-nitro-xxhash react-native-nitro-modules@0.37.1 --npm
```

**Yarn**

```sh
yarn expo install react-native-nitro-xxhash react-native-nitro-modules@0.37.1 --yarn
```

Register the bundled config plugin in your app configuration:

```json
{
  "expo": {
    "plugins": [["react-native-nitro-xxhash", { "nitroCompatibility": "apply" }]]
  }
}
```

Then generate the native projects and create a development build:

**npm**

```sh
npx expo prebuild
npx expo run:ios
# Or: npx expo run:android
```

**Yarn**

```sh
yarn expo prebuild
yarn expo run:ios
# Or: yarn expo run:android
```

Expo SDK 58 recreates the native directories by default. Use `npx expo prebuild --no-clean` or `yarn expo prebuild --no-clean` to apply changes to existing native projects instead. To start Metro separately, use `npx expo start` or `yarn expo start`.

| Option                      | Default   | Behavior                                                                                                                                                                       |
| --------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nitroCompatibility`        | `"apply"` | Applies the guarded [Nitro repairs](compatibility.md#nitro-0371-repairs) during native generation. Use `"check"` to require repairs already persisted by your package manager. |
| `android.agp9Compatibility` | `false`   | Set to `true` only for AGP 9 hosts to write `android.builtInKotlin=false` and `android.newDsl=false` to the application's `gradle.properties`. These affect the whole app.     |

Adding the plugin explicitly enables its default repair behavior. It reuses the compatibility helper; unsupported Nitro versions, conflicting sources and missing repairs in `"check"` mode stop prebuild. Repairs run during native generation, not while importing the plugin or evaluating the app configuration. Repeated prebuilds safely reuse existing repairs.

Expo SDK 58 templates may already supply the AGP 9 switches. Leave `android.agp9Compatibility` disabled when the host already has the required values; enable it only when the plugin should write or override them.

The plugin preserves the host's SDK, NDK and deployment target choices. Configure supported Expo build settings through [`expo-build-properties`](https://docs.expo.dev/versions/latest/sdk/build-properties/). Native autolinking is already supplied by this package; no hashing permissions or application lifecycle changes are added.

When prebuild is skipped, including builds using committed native directories, the plugin cannot prepare Nitro. Apply the [manual helper](compatibility.md#nitro-0371-repairs) after dependency installation or persist the repairs with your package manager. Rebuild Nitro and all consumers together after a repair changes native sources.
