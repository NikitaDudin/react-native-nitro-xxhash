---
title: createHasher and HashStream
description: Incremental hashing, digest snapshots, cloning, resetting and disposal.
sidebar_position: 3
---

`createHasher` creates independent native hashing state. Feed chunks with `update()`, inspect the current digest and explicitly release the state when finished.

```ts
import { createHasher, xxh3_128 } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh3-128', 42n);
try {
  hasher.update('hello').update(' world');
  console.log(hasher.digest() === xxh3_128('hello world', 42n));
} finally {
  hasher.dispose();
}
```

Use [hashStream](../guides/streams.md) when a source produces chunks asynchronously and should own automatic cleanup.

## Signature and creation

```ts api-signature
import type { HashAlgorithm, HashSeed, HashStream } from 'react-native-nitro-xxhash';

declare function createHasher(algorithm: HashAlgorithm, seed?: HashSeed): HashStream;
```

| Argument    | Meaning                                                      |
| ----------- | ------------------------------------------------------------ |
| `algorithm` | Required: `'xxh32'`, `'xxh64'`, `'xxh3-64'` or `'xxh3-128'`. |
| `seed`      | Optional unsigned integer; defaults to zero.                 |

There is no default algorithm for `createHasher`. An unsupported algorithm throws `TypeError`; invalid seeds follow the [one-shot seed rules](one-shot.md#seeds). Creation is synchronous and may throw an initialization/native error. Each successful call creates an independent state owned by the calling JavaScript runtime.

## `algorithm`

The read-only `algorithm: HashAlgorithm` property reports the algorithm chosen at creation. `reset()` cannot switch algorithms. This property remains readable after disposal; it does not require live native state.

```ts
import { createHasher } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh64');
console.log(hasher.algorithm); // 'xxh64'
hasher.dispose();
console.log(hasher.algorithm); // Still 'xxh64'.
```

## `update(input): this`

Consumes one `HashInput` immediately and returns the same hasher for chaining. Strings contribute UTF-8 bytes; buffers contribute their entire allocation; TypedArrays, `DataView` and compatible Buffer instances contribute exactly their selected byte range.

```ts
import { createHasher, xxh3_64 } from 'react-native-nitro-xxhash';

const allocation = new Uint8Array([9, 1, 2, 3, 9]);
const selected = allocation.subarray(1, 4);
const hasher = createHasher('xxh3-64');
try {
  hasher.update(selected.subarray(0, 1));
  hasher.update(new DataView(selected.buffer, selected.byteOffset + 1, 2));
  console.log(hasher.digest() === xxh3_64(new Uint8Array([1, 2, 3])));
} finally {
  hasher.dispose();
}
```

Binary payloads are borrowed only during `update()`, without copying their bytes or retaining the input. Once the call returns, reusing or mutating the source cannot change the bytes already consumed. Do not modify its storage concurrently from native code during the call.

Updates execute synchronously on the calling JavaScript thread. They do not schedule a background job or accumulate every previous chunk in JavaScript. Unsupported input throws before it is consumed; previous valid chunks remain part of the state. See [inputs and outputs](inputs-and-outputs.md) for byte ranges and rejected storage.

### Text chunk boundaries

Each string chunk is encoded separately. ASCII chunks such as `'hello'` and `' world'` have the same bytes as the combined string. A UTF-16 surrogate pair split between chunks does not have that guarantee.

If a source may split text inside a surrogate pair, keep complete code points in each text chunk or encode to bytes before splitting. String and binary chunks may be mixed; the digest follows their contributed byte sequence in update order.

## `digest(output?)`

Reads the current digest without clearing or finalizing the state. You may call it repeatedly, select another representation and continue updating afterward. Calling it before the first update returns the chosen algorithm's digest of empty input with the current seed.

```ts api-signature
import type { HashOutput, HashResult } from 'react-native-nitro-xxhash';

declare const hasher: {
  digest(output?: 'hex'): string;
  digest<T extends HashOutput>(output: T): HashResult<T>;
  digest<T extends HashOutput>(output?: T): HashResult<T | 'hex'>;
};
```

```ts
import { createHasher, xxh32 } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh32');
try {
  console.log(hasher.digest() === xxh32(''));
  hasher.update('hello');

  const snapshot: string = hasher.digest();
  const bytes: Uint8Array<ArrayBuffer> = hasher.digest('bytes');
  const integer: bigint = hasher.digest('bigint');

  hasher.update(' world');
  console.log(snapshot === xxh32('hello'));
  console.log(hasher.digest() === xxh32('hello world'));
  console.log(bytes, integer);
} finally {
  hasher.dispose();
}
```

The default is `'hex'`. Formats and canonical byte order match the [one-shot outputs](inputs-and-outputs.md#digest-representations). Each `'bytes'` result is an independent allocation; changing it does not mutate the hasher. An invalid format throws `TypeError` and leaves the state available.

## `clone(): HashStream`

Creates a separate hasher with the same algorithm, accumulated bytes and current seed. The original and clone can then diverge. Disposing or resetting either one does not affect the other.

```ts
import { createHasher, xxh3_64 } from 'react-native-nitro-xxhash';

const base = createHasher('xxh3-64', 7n);
try {
  base.update('prefix:');
  const branch = base.clone();
  try {
    base.update('left');
    branch.update('right');
    console.log(base.digest() === xxh3_64('prefix:left', 7n));
    console.log(branch.digest() === xxh3_64('prefix:right', 7n));

    branch.reset().update('new');
    console.log(branch.digest() === xxh3_64('new', 7n));
  } finally {
    branch.dispose();
  }
} finally {
  base.dispose();
}
```

The caller owns both states and must dispose both. If cloning fails, the original remains available.

## `reset(seed?): this`

Clears accumulated input and returns the same hasher. Omitting `seed`, including an explicit `undefined`, preserves the current seed. Providing a seed replaces it for future updates and subsequent resets. Use `0` or `0n` when you intend to return to seed zero.

```ts
import { createHasher, xxh64 } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh64', 42n);
try {
  hasher.update('discarded');
  hasher.reset().update('kept');
  console.log(hasher.digest() === xxh64('kept', 42n));

  hasher.reset(0n).update('kept');
  console.log(hasher.digest() === xxh64('kept'));
} finally {
  hasher.dispose();
}
```

A reset clone preserves the seed copied at cloning, independently of later resets to the original. Seed validation follows the same algorithm-specific limits as creation. If the supplied seed is invalid, the current chunks and seed remain intact. A failed native reset does not replace the JavaScript-side remembered seed.

## `dispose(): void`

Releases the owned native state. Repeated disposal is harmless. After disposal, `update()`, `digest()`, `clone()` and `reset()` throw; the `algorithm` property remains readable.

Use `try`/`finally` around the state, including when updates or source acquisition can fail. The object has no `Symbol.dispose` protocol and is not an async stream: call its explicit `dispose()` method.

```ts
import { createHasher } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh32');
try {
  hasher.update('payload');
  console.log(hasher.digest());
} finally {
  hasher.dispose();
}

hasher.dispose(); // Safe to repeat.
```

A `HashStream` is a runtime-owned handle. It is not a transferable value or a worklet API. Create separate state for independent operations rather than sharing one mutable hasher between unrelated callers.
