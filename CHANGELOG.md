# Changelog

Notable changes to `react-native-nitro-xxhash` are documented here.

## Unreleased

## 0.1.0 - 2026-10-29

### Added

- Native XXH32, XXH64, XXH3-64 and XXH3-128 hashing for strings, ArrayBuffers, TypedArrays, DataViews and Buffers, preserving byte offsets and lengths without copying binary inputs.
- Seeded hashing, multiple digest formats, incremental hashers and asynchronous stream hashing.
- Asynchronous local-file hashing with bounded native work and cancellation.
- React Native 0.88+ support, guarded Nitro 0.37.1 compatibility repairs and an optional Expo SDK 58 prebuild plugin.
- An iOS/Android example application, API documentation and automated JavaScript, native and package validation.

### Changed

- Use `xxHash` as the native module identity on iOS and Android, with the matching `🔥 xxHash is boosted by nitro!` build message.
