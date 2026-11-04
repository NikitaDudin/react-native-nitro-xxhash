# Changelog

Notable changes to `react-native-nitro-xxhash` are documented here.

## Unreleased

## 0.2.0 - 2026-11-04

### Changed

- Require Nitro Modules 0.37.2; applications using 0.37.1 must upgrade Nitro and rebuild their native dependencies before adopting this release. The hashing API and platform baseline are unchanged.
- Regenerate bindings with Nitrogen 0.37.2 and migrate native validation to Nitro's reorganized core and Apple sources.
- Rebase the remaining explicit compatibility repairs onto 0.37.2 while preserving upstream `Object.create` detection and `Promise.resolve` / `Promise.reject` receiver fixes.

### Removed

- Remove the compatibility backports for Swift/C++ exception conversion, now included in Nitro 0.37.2.
- Remove the CocoaPods private-header search path workaround now that Nitro publishes `ThreadPool.hpp` as a public header.

## 0.1.2 - 2026-10-30

### Changed

- Optimize only the Android Debug hashing kernels by default, with an [opt-out for kernel debugging](docs/compatibility.md#android-debug-hashing).
- Optimize only the iOS Debug hashing kernels through CocoaPods source flags, with an [Xcode setting or pod-install opt-out](docs/compatibility.md#ios-debug-hashing).
- Use `-O2` for the iOS Release hashing kernels, with an [independent opt-out to inherit host optimization](docs/compatibility.md#ios-release-hashing).

## 0.1.1 - 2026-10-29

### Fixed

- Resolve Nitro 0.37.1's private worker-pool header during CocoaPods builds without application-owned header search paths.

## 0.1.0 - 2026-10-29

### Added

- Native XXH32, XXH64, XXH3-64 and XXH3-128 hashing for strings, ArrayBuffers, TypedArrays, DataViews and Buffers, preserving byte offsets and lengths without copying binary inputs.
- Seeded hashing, multiple digest formats, incremental hashers and asynchronous stream hashing.
- Asynchronous local-file hashing with bounded native work and cancellation.
- React Native 0.88+ support, guarded Nitro 0.37.1 compatibility repairs and an optional Expo SDK 58 prebuild plugin.
- An iOS/Android example application, API documentation and automated JavaScript, native and package validation.
- Yarn installation and launch instructions for React Native, Expo and the example application.

### Changed

- Use `xxHash` as the native module identity on iOS and Android, with the matching `🔥 xxHash is boosted by nitro!` build message.

### Fixed

- Run repository package checks, code generation, example setup and Expo validation correctly when launched through Yarn.
