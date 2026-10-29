---
title: Bundled assets and Metro
description: Hash require() assets through a real local file, and configure Metro for extra binary extensions.
sidebar_position: 3
---

# Bundled assets and Metro

## Can I pass `require('./image.png')` to a file helper?

Not directly. In a native Metro bundle, `require('./image.png')` normally returns a numeric asset identifier, not a filesystem path or the image bytes. The public file functions accept a path string; there is no generic `hashFile` export. Choose an algorithm such as `xxh3_128File`.

Resolve or materialize the asset through your application's asset/storage layer, then pass its readable local path to the file helper. Converting the identifier to a string does not resolve it, and hashing that string with a one-shot function hashes the identifier's text.

## Expo Asset: materialize, then hash

In an app with [Expo modules configured](../expo.md), install the optional asset integration:

```sh
npx expo install expo-asset
```

[`Asset.fromModule()` and `downloadAsync()`](https://docs.expo.dev/versions/latest/sdk/asset/) provide a local copy when necessary. Keep the `require()` argument a static literal so Metro can discover the file:

```ts
import { Asset } from 'expo-asset';
import { xxh3_128File } from 'react-native-nitro-xxhash';

async function hashBundledAsset(moduleId: number): Promise<string> {
  const asset = await Asset.fromModule(moduleId).downloadAsync();
  const uri = asset.localUri;
  if (!uri?.startsWith('file://')) {
    throw new Error('The asset did not resolve to a readable local file.');
  }
  return xxh3_128File(uri);
}

const image: number = require('./image.png');
console.log(await hashBundledAsset(image));
```

The same helper works for another Metro-registered asset, such as `require('./model.glb')`. These are application files: replace the paths with assets that actually exist in your project.

Some bare Android integrations report an already-loaded drawable resource instead of copying it to a regular file. The `file://` guard deliberately rejects that result; use a resource-copy API from your storage layer in that case. Merely installing Expo modules does not guarantee that every packaged resource becomes a readable file.

`expo-asset` owns this cache. Do not delete its shared file after hashing or assume it persists across app sessions. Downloading/materializing happens before file hashing; a hash operation's `signal` does not cancel `downloadAsync()`. This integration still needs your own native build; the hashing package does not run in Expo Go.

## Bare React Native: inspect the resolved image URI

For images, [`Image.resolveAssetSource()`](https://reactnative.dev/docs/image#resolveassetsource) resolves an asset reference, but its URI is not guaranteed to be a regular local file:

```ts
import { Image } from 'react-native';
import { xxh3_128File } from 'react-native-nitro-xxhash';

async function hashImageIfLocal(moduleId: number): Promise<string> {
  const source = Image.resolveAssetSource(moduleId);
  const uri = source?.uri;
  if (!uri || !(uri.startsWith('file://') || uri.startsWith('/'))) {
    throw new Error('Copy or download this asset to an application-owned file first.');
  }
  return xxh3_128File(uri);
}

const image: number = require('./image.png');
console.log(await hashImageIfLocal(image));
```

Development can resolve to a Metro HTTP URL. Android release bundles can resolve to packaged resource names rather than files; iOS asset catalogs also need resource-aware handling. Use your storage library's resource-copy/download API to obtain a regular file first. A URI accepted by `Image` is not automatically accepted by the native file hasher. See [accepted paths](files.md#accepted-paths-and-uris) and [downloaded files](files.md#download-a-file-then-hash-it).

Image assets can select different density variants (`@2x`, `@3x`) on different devices. Native packaging may also transform resource bytes. The digest covers the actual resolved file bytes, not decoded pixels or a universal identity for the source asset. If you require one digest across builds/devices, generate it from a specific source file during your build or distribute an unchanged binary asset.

## Extra Metro asset extensions

`.png` is already an asset extension. For an additional binary type, extend [`resolver.assetExts`](https://metrobundler.dev/docs/configuration/#assetexts), keeping your existing defaults and custom configuration. Use extension names without a leading dot. These examples add `.bin`, `.glb` and `.wasm`; they do not make a numeric asset ID into a local path.

For bare React Native, merge this with your existing `metro.config.js`:

```js
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const defaults = getDefaultConfig(__dirname);
const binaryExtensions = ['bin', 'glb', 'wasm'];

module.exports = mergeConfig(defaults, {
  resolver: {
    assetExts: [...new Set([...defaults.resolver.assetExts, ...binaryExtensions])],
    sourceExts: defaults.resolver.sourceExts.filter((ext) => !binaryExtensions.includes(ext)),
  },
});
```

For an Expo project, start from Expo's configuration:

```js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const binaryExtensions = ['bin', 'glb', 'wasm'];
config.resolver.assetExts = [...new Set([...config.resolver.assetExts, ...binaryExtensions])];
config.resolver.sourceExts = config.resolver.sourceExts.filter(
  (ext) => !binaryExtensions.includes(ext),
);

module.exports = config;
```

An extension should not simultaneously be treated as JavaScript/source and as a binary asset. Preserve an existing custom transformer's choice, such as SVG transformed into a React component; only move extensions you intend to bundle as raw assets. Restart Metro with its cache reset after changing resolver configuration (`npx react-native start --reset-cache` or `npx expo start --clear`).

Metro only needs this configuration for assets referenced by `require()`/imports. File helpers can hash any regular local file regardless of its extension, without a Metro change.
