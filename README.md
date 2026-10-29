# react-native-nitro-xxhash

Native **XXH32, XXH64, XXH3-64 and XXH3-128** for React Native, powered by [Nitro Modules](https://github.com/margelo/nitro) and [xxHash](https://github.com/Cyan4973/xxHash). Hash UTF-8 strings, binary views and local files, or consume chunks incrementally.

[Documentation](https://NikitaDudin.github.io/react-native-nitro-xxhash/) · [API reference](docs/api/one-shot.md) · [Installation](docs/installation.md) · [Contributing](CONTRIBUTING.md)

## Installation

Requires React Native **0.88+**, iOS **15.1+** or Android **API 24+**, and **Nitro Modules exactly 0.37.1**.

For a bare React Native application:

```sh
npm install react-native-nitro-xxhash react-native-nitro-modules@0.37.1
npx --no-install nitro-xxhash-compat
```

Apply the helper on both platforms before native builds or `pod install`, then rebuild Nitro and all native consumers together. Repeat after dependency installation. See [installation](docs/installation.md) for platform steps and [compatibility](docs/compatibility.md) for host settings and the iOS scene lifecycle.

Expo SDK 58 applications can use the bundled [config plugin](docs/expo.md) to prepare Nitro during prebuild. Expo requires a development build; Expo Go, web and remote JavaScript debugging are unsupported.

## Quick start

For a runnable native example, see the [Expo example application](https://github.com/NikitaDudin/react-native-nitro-xxhash/tree/main/example).

```ts
import { xxh32, xxh3_64, xxh3_128, createHasher } from 'react-native-nitro-xxhash';

const hex = xxh32('hello');
const seeded = xxh3_64('hello', 42n);
const bytes = xxh3_128(new Uint8Array([1, 2, 3]), { output: 'bytes' });
const integer = xxh3_128('hello', { output: 'bigint' });

const hasher = createHasher('xxh3-128', 42n);
try {
  hasher.update('hello').update(' world');
  console.log({ hex, seeded, bytes, integer, incremental: hasher.digest() });
} finally {
  hasher.dispose();
}
```

## API

| Workflow                                  | Public API                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| Synchronous text and binary hashing       | [`xxh32`, `xxh64`, `xxh3_64`, `xxh3_128`](docs/api/one-shot.md)                 |
| Incremental state, checkpoints and clones | [`createHasher` and `HashStream`](docs/api/create-hasher.md)                    |
| Background local-file hashing             | [`xxh32File`, `xxh64File`, `xxh3_64File`, `xxh3_128File`](docs/guides/files.md) |
| Async iterables and readable streams      | [`hashStream`](docs/guides/streams.md)                                          |

All algorithms accept unsigned seeds and return lowercase hex by default. [Bytes and bigint outputs](docs/api/inputs-and-outputs.md#digest-representations) preserve the full digest. XXH64 and XXH3-64 are different algorithms.

[Strings, ArrayBuffer, TypedArray, DataView and Buffer](docs/api/inputs-and-outputs.md) are accepted. Views preserve their exact byte offset and length without copying the payload. Numbers, ordinary arrays and objects require caller-selected encoding.

Integration examples cover [fetch responses](docs/guides/streams.md#fetch-responses), [downloaded files](docs/guides/files.md#download-a-file-then-hash-it) and [Metro `require()` assets](docs/guides/bundled-assets.md), including extra binary extensions.

See [public types](docs/api/types.md) and [errors and cancellation](docs/guides/errors-and-cancellation.md) for detailed contracts and examples. xxHash is non-cryptographic; use a cryptographic primitive for authentication, signatures or adversarial integrity checks.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, checks, documentation editing and publishing.

MIT licensed; maintained by [Nikita Dudin](https://github.com/NikitaDudin). The vendored xxHash header retains its [BSD-2-Clause license](cpp/vendor/LICENSE.xxHash). Nitro repairs retain [Nitro's MIT license](compat/LICENSE.Nitro).
