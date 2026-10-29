---
title: Public types
description: Exported TypeScript inputs, options, result types and stream contracts.
sidebar_position: 4
---

Import public types from the package root. Type-only imports do not initialize native hashing.

```ts
import type {
  FileHashOptions,
  HashAlgorithm,
  HashInput,
  HashOptions,
  HashOutput,
  HashResult,
  HashSeed,
  HashStream,
  HashStreamOptions,
  HashStreamSource,
} from 'react-native-nitro-xxhash';

const algorithm: HashAlgorithm = 'xxh3-128';
const seed: HashSeed = 42n;
const options: HashOptions<'bytes'> = { seed, output: 'bytes' };

console.log(algorithm, options);
```

These are the complete type names exported by the root entry point. The underlying native Nitro interfaces and factory-helper interfaces are implementation details, not part of the public imports.

## `HashInput`

```ts api-signature
type HashInput = string | ArrayBuffer | ArrayBufferView;
```

A string contributes UTF-8 bytes. A buffer contributes its entire allocation. A binary view contributes its exact `byteOffset` and `byteLength` range. Compatible Buffer implementations participate as Uint8Array views.

The TypeScript view type can describe storage that the runtime does not accept, including shared backing buffers. Runtime validation remains authoritative. See [accepted inputs and storage restrictions](inputs-and-outputs.md#accepted-inputs).

## `HashAlgorithm`

```ts api-signature
type HashAlgorithm = 'xxh32' | 'xxh64' | 'xxh3-64' | 'xxh3-128';
```

Used by `createHasher`, the read-only `HashStream.algorithm` property and `HashStreamOptions.algorithm`. The one-shot function names use underscores for XXH3 variants; algorithm IDs use hyphens.

## `HashSeed`

```ts api-signature
type HashSeed = number | bigint;
```

The type does not encode the permitted integer range. At runtime the value must be unsigned, safe when supplied as a number, and within the algorithm's seed width. See [seed limits](one-shot.md#seeds).

## `HashOutput`

```ts api-signature
type HashOutput = 'hex' | 'bytes' | 'bigint';
```

The format determines the representation, not which bytes or algorithm are hashed. All APIs default to `'hex'` when output is omitted.

## `HashResult`

```ts api-signature
type HashResult<T extends HashOutput> = T extends 'hex'
  ? string
  : T extends 'bytes'
    ? Uint8Array<ArrayBuffer>
    : bigint;
```

Literal format types give a single result type. A union gives the corresponding union of results:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';
import type { HashInput, HashOutput, HashResult } from 'react-native-nitro-xxhash';

function hashAs<T extends HashOutput>(input: HashInput, output: T): HashResult<T> {
  return xxh3_64(input, { output });
}

const hex: string = hashAs('hello', 'hex');
const bytes: Uint8Array<ArrayBuffer> = hashAs('hello', 'bytes');
const integer: bigint = hashAs('hello', 'bigint');

console.log(hex, bytes, integer);
```

A generic options object whose `output` is optional can also select the default hex format. Its inferred result therefore includes `string`. See [output inference](one-shot.md#typescript-inference).

## `HashOptions`

```ts api-signature
interface HashOptions<T extends HashOutput = 'hex'> {
  seed?: HashSeed | undefined;
  output?: T | undefined;
}
```

Used by the [one-shot functions](one-shot.md). Both fields are optional; defaults are seed zero and hex output. Explicit `undefined` is accepted, including in projects with `exactOptionalPropertyTypes` enabled.

When an options type is used without a generic argument, it describes hex output. Specify `HashOptions<'bytes'>`, `HashOptions<'bigint'>` or `HashOptions<HashOutput>` when another format is possible. Unknown own keys are rejected at runtime.

## `FileHashOptions`

```ts api-signature
interface FileHashOptions<T extends HashOutput = 'hex'> extends HashOptions<T> {
  signal?: AbortSignal | undefined;
}
```

Adds optional cancellation to the [local-file helpers](../guides/files.md). The signal must provide the AbortSignal event contract; the package installs no AbortController polyfill.

```ts
import { xxh3_128File } from 'react-native-nitro-xxhash';
import type { FileHashOptions } from 'react-native-nitro-xxhash';

async function hashLocalFile(fileUri: string): Promise<bigint> {
  const options: FileHashOptions<'bigint'> & { output: 'bigint' } = {
    seed: 42n,
    output: 'bigint',
  };
  return xxh3_128File(fileUri, options);
}
```

The intersection in this example states that output is present, so the result is exactly `Promise<bigint>`. If output remains optional in the parameter's type, its result also permits the default hex string.

## `HashStreamOptions`

```ts api-signature
interface HashStreamOptions<T extends HashOutput = 'hex'> extends FileHashOptions<T> {
  algorithm?: HashAlgorithm | undefined;
}
```

Used by [hashStream](../guides/streams.md). Its defaults are algorithm `'xxh3-128'`, seed zero and hex output. `signal` cancels asynchronous consumption. Like the inherited fields, `algorithm` can be explicitly `undefined`.

This options object belongs to the `hashStream` function; `createHasher` takes a required algorithm and optional seed as positional arguments.

## `HashStreamSource`

`HashStreamSource` accepts either an `AsyncIterable<HashInput>` or a readable object with `getReader()`. It is structural, so a React Native project does not need the DOM library merely to name the source type.

The reader shape is:

```ts api-signature
import type { HashInput } from 'react-native-nitro-xxhash';

type ReadableSourceShape = {
  getReader(): {
    read(): PromiseLike<
      { done: false; value: HashInput } | { done: true; value?: HashInput | undefined }
    >;
    cancel(reason?: unknown): unknown;
    releaseLock(): void;
  };
};
```

`ReadableSourceShape` is an illustration, not an exported name. A non-EOF read must provide `value`; an EOF read may omit it. All three reader methods are required. The package does not export its internal reader/helper interface names from the root.

```ts
import { hashStream } from 'react-native-nitro-xxhash';
import type { HashStreamSource } from 'react-native-nitro-xxhash';

const source: HashStreamSource = {
  getReader() {
    let consumed = false;
    return {
      read() {
        if (consumed) return Promise.resolve({ done: true as const });
        consumed = true;
        return Promise.resolve({ done: false as const, value: new Uint8Array([1, 2, 3]) });
      },
      cancel() {},
      releaseLock() {},
    };
  },
};

async function consumeSource(): Promise<string> {
  return hashStream(source);
}
```

If a source exposes both `getReader()` and asynchronous iteration, `hashStream` uses its reader. Plain synchronous iterables are not `HashStreamSource`; wrap them in an async generator when asynchronous consumption is intended. Protocol cleanup and cancellation are covered in [streaming sources](../guides/streams.md).

## `HashStream`

The interface returned by [createHasher](create-hasher.md) exposes:

| Member            | Type / behavior                                                         |
| ----------------- | ----------------------------------------------------------------------- |
| `algorithm`       | Read-only `HashAlgorithm`; remains readable after disposal.             |
| `update(input)`   | Takes `HashInput`, consumes one chunk and returns `this`.               |
| `digest(output?)` | Returns `HashResult` for the selected format; defaults to a hex string. |
| `clone()`         | Returns an independent `HashStream`.                                    |
| `reset(seed?)`    | Clears input, optionally replaces the seed and returns `this`.          |
| `dispose()`       | Releases native state; returns `void` and is idempotent.                |

A `HashStream` is not an `AsyncIterable`, Web `ReadableStream` or transferable worker handle. It is synchronous mutable hashing state owned by one JavaScript runtime. See its [full method reference](create-hasher.md) for ownership and failure behavior.
