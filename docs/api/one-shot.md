---
title: One-shot hashes
description: Hash strings and binary data with XXH32, XXH64, XXH3-64 and XXH3-128.
sidebar_position: 1
---

Use a one-shot function when the complete input is already available as a string, `ArrayBuffer` or binary view. The function returns its digest synchronously on the calling JavaScript thread.

```ts
import { xxh32, xxh64, xxh3_64, xxh3_128 } from 'react-native-nitro-xxhash';

const text = 'hello';
const classic32: string = xxh32(text);
const classic64: string = xxh64(text);
const modern64: string = xxh3_64(text);
const modern128: string = xxh3_128(text);

console.log({ classic32, classic64, modern64, modern128 });
```

For data already stored on disk, use a [file helper](../guides/files.md). For multiple synchronous chunks, use [createHasher](create-hasher.md). For an asynchronous source, use [hashStream](../guides/streams.md).

## Functions and algorithms

| Function   | Algorithm     | `createHasher` algorithm ID | Digest width | Default hex length |
| ---------- | ------------- | --------------------------- | ------------ | ------------------ |
| `xxh32`    | Classic XXH32 | `'xxh32'`                   | 32 bits      | 8 characters       |
| `xxh64`    | Classic XXH64 | `'xxh64'`                   | 64 bits      | 16 characters      |
| `xxh3_64`  | XXH3-64       | `'xxh3-64'`                 | 64 bits      | 16 characters      |
| `xxh3_128` | XXH3-128      | `'xxh3-128'`                | 128 bits     | 32 characters      |

The underscore in a function name and the hyphen in an algorithm ID are intentional: call `xxh3_64(input)`, or pass `'xxh3-64'` to `createHasher` and `hashStream`.

XXH64 and XXH3-64 are different algorithms. Their equal output width does not make their results interchangeable. To compare a digest with another implementation, match the algorithm, seed and exact input bytes. The API exposes these explicit algorithm names without older width-only aliases.

xxHash is non-cryptographic. Use a cryptographic primitive for signatures, authentication or integrity checks against an adversary.

## Calling forms

All four functions accept the same calling forms:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const defaultDigest = xxh3_64('hello');
const seededDigest = xxh3_64('hello', 42n);
const optionsDigest = xxh3_64('hello', { seed: 42n, output: 'hex' });

console.log(defaultDigest, seededDigest === optionsDigest);
```

| Parameter                  | Type             | Meaning                                                     |
| -------------------------- | ---------------- | ----------------------------------------------------------- |
| `input`                    | `HashInput`      | UTF-8 text or raw bytes. A view selects its own byte range. |
| Second argument as a seed  | `HashSeed`       | Unsigned integer seed; output remains hex.                  |
| Second argument as options | `HashOptions<T>` | Optional `seed` and `output` fields.                        |

Omitting the second argument, passing `undefined` or using an empty options object selects seed zero and hex output. The synchronous options object accepts only `seed` and `output`. Extra own keys are rejected, even when their value is `undefined`. A `signal` belongs to the asynchronous APIs and is not accepted here.

The overloads below use `xxh3_64` as a representative; `xxh32`, `xxh64` and `xxh3_128` have the same shape:

```ts api-signature
import type {
  HashInput,
  HashOptions,
  HashOutput,
  HashResult,
  HashSeed,
} from 'react-native-nitro-xxhash';

declare function xxh3_64(input: HashInput, seed?: HashSeed): string;
declare function xxh3_64<T extends HashOutput>(
  input: HashInput,
  options: HashOptions<T> & { output: T },
): HashResult<T>;
declare function xxh3_64(input: HashInput, options: HashOptions<'hex'> | undefined): string;
declare function xxh3_64<T extends HashOutput>(
  input: HashInput,
  options?: HashSeed | HashOptions<T>,
): HashResult<T | 'hex'>;
```

## Seeds

The seed is an unsigned integer. It is supplied separately from the input and is not a string prefix or suffix.

| Algorithm                | Minimum seed | Maximum seed                  |
| ------------------------ | ------------ | ----------------------------- |
| XXH32                    | `0` or `0n`  | `0xffffffff` or `0xffffffffn` |
| XXH64, XXH3-64, XXH3-128 | `0` or `0n`  | `0xffffffffffffffffn`         |

A JavaScript number must also satisfy `Number.isSafeInteger`. Use `bigint` when the desired seed exceeds `Number.MAX_SAFE_INTEGER`; converting an already rounded number to `bigint` cannot recover its intended value.

```ts
import { xxh32, xxh64, xxh3_128 } from 'react-native-nitro-xxhash';

const max32 = xxh32('hello', 0xffffffff);
const max64 = xxh64('hello', 0xffffffffffffffffn);
const seeded128 = xxh3_128('hello', { seed: 0xffffffffffffffffn });

console.log(max32, max64, seeded128);
```

Negative values, fractions, `NaN`, infinities, unsafe numbers and seeds above the algorithm's limit are rejected with `RangeError`. Seed values with another runtime type are rejected with `TypeError`. Omitted seeds, `0`, `-0` and `0n` all select zero.

A wider digest does not imply a wider seed: XXH3-128 still accepts a 64-bit seed.

## Output formats

Use `output` to select the representation of the same underlying digest:

```ts
import { xxh3_128 } from 'react-native-nitro-xxhash';

const hex: string = xxh3_128('hello', { output: 'hex' });
const bytes: Uint8Array<ArrayBuffer> = xxh3_128('hello', { output: 'bytes' });
const integer: bigint = xxh3_128('hello', { output: 'bigint' });

console.log(hex, bytes, integer);
```

| `output`           | Return type               | Representation                                                 |
| ------------------ | ------------------------- | -------------------------------------------------------------- |
| `'hex'` or omitted | `string`                  | Lowercase, fixed-width hexadecimal, including leading zeros.   |
| `'bytes'`          | `Uint8Array<ArrayBuffer>` | A new allocation containing canonical big-endian digest bytes. |
| `'bigint'`         | `bigint`                  | The complete unsigned digest value without number rounding.    |

See [inputs and outputs](inputs-and-outputs.md#digest-representations) for byte lengths, representation equivalence and ownership.

### TypeScript inference

A required literal `output` produces the corresponding exact result type. Preserve that literal when saving options:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const options = { seed: 42n, output: 'bytes' } as const;
const digest: Uint8Array<ArrayBuffer> = xxh3_64('hello', options);

console.log(digest);
```

A type whose `output` field is optional must allow the default hex result as well:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';
import type { HashOptions } from 'react-native-nitro-xxhash';

function hashWithOptionalOutput(options: HashOptions<'bytes'>) {
  const digest: string | Uint8Array<ArrayBuffer> = xxh3_64('hello', options);
  return digest;
}

console.log(hashWithOptionalOutput({ output: 'bytes' }));
console.log(hashWithOptionalOutput({}));
```

The same rule applies when the selected output is a union: the result type reflects the possible formats. See [public types](types.md#hashresult).

## Errors and execution

One-shot calls throw synchronously:

| Failure                                                            | Error behavior                                 |
| ------------------------------------------------------------------ | ---------------------------------------------- |
| Unsupported input, seed type, options object, option key or output | `TypeError`.                                   |
| Seed outside the allowed integer range                             | `RangeError`.                                  |
| Native module unavailable or native operation fails                | The initialization/native error is propagated. |

The implementation does not coerce numbers, arrays or objects into input data. See the [input contract](inputs-and-outputs.md#accepted-inputs) before choosing a serialization.

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

try {
  xxh3_64('hello', -1);
} catch (error) {
  if (error instanceof RangeError) {
    console.log('Choose an unsigned integer seed.');
  } else {
    throw error;
  }
}
```

Treat error messages as diagnostic text rather than a stable parsing interface. Importing the package does not create its native hashing object; first use initializes it. A later call may retry after initialization failure. There is no worker or Promise boundary for these functions: both string and binary hashing run on the caller's JavaScript thread. For cancellation and asynchronous error handling, see [errors and cancellation](../guides/errors-and-cancellation.md).
