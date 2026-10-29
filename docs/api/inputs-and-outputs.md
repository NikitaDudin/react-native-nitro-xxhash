---
title: Inputs and outputs
description: UTF-8 text, exact binary ranges, zero-copy ownership and canonical digest formats.
sidebar_position: 2
---

A digest is determined by the algorithm, seed and exact input bytes. The API does not serialize application values or infer a file operation from a string.

## Accepted inputs

All [one-shot functions](one-shot.md) and [HashStream.update](create-hasher.md#updateinput-this) accept the same `HashInput`:

| Input                      | Bytes consumed                                   |
| -------------------------- | ------------------------------------------------ |
| Primitive `string`         | Its UTF-8 representation.                        |
| `ArrayBuffer`              | The entire current allocation.                   |
| TypedArray                 | Its current `byteOffset`/`byteLength` range.     |
| `DataView`                 | Its selected byte range.                         |
| Compatible Buffer instance | Its selected range through Uint8Array semantics. |

For an asynchronous source, each yielded chunk follows this same contract. A [file helper](../guides/files.md) instead accepts a local path or `file://` URI.

### Values requiring caller-selected encoding

Numbers, ordinary arrays and plain objects are not hash inputs. Choose an encoding that is stable for your application, then pass its text or bytes.

```ts
import { xxh3_128 } from 'react-native-nitro-xxhash';

const numberAsText = xxh3_128(String(42));
const selectedByteEncoding = xxh3_128(new Uint8Array([1, 2, 3]));

// Explicit field order and text encoding are an application-level decision.
const recordAsText = xxh3_128(JSON.stringify({ id: 'item-1', revision: 2 }));

console.log(numberAsText, selectedByteEncoding, recordAsText);
```

`JSON.stringify` is only an example encoding choice, not a built-in canonical-object contract. If field order, omitted values or cross-language compatibility matter, define a serialization independently of hashing.

## Strings

Strings contribute UTF-8 bytes, including embedded NUL characters. The empty string is valid. There is no Unicode normalization: canonically equivalent text can have different byte sequences unless the caller normalizes it.

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const empty = xxh3_64('');
const withNul = xxh3_64('a\0b');
const precomposed = '\u00e9';
const decomposed = 'e\u0301';

const normalizedA = xxh3_64(precomposed.normalize('NFC'));
const normalizedB = xxh3_64(decomposed.normalize('NFC'));

console.log(empty, withNul, normalizedA === normalizedB);
```

Use a normalization implementation supported by your host if your protocol requires one. Normalization is separate from this package.

A URI-looking string remains text:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const digestOfUriText = xxh3_64('file:///documents/photo.bin');
console.log(digestOfUriText); // Does not open a file.
```

With incremental hashing, each text chunk is encoded separately. Do not split a UTF-16 surrogate pair across string chunks when expecting the same bytes as one combined string. Prefer binary chunks when a source's text boundaries cannot preserve complete code points.

## Exact binary ranges

A view selects a byte range without requiring a sliced copy. Prefix and suffix bytes outside that range are excluded.

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const allocation = new Uint8Array([99, 1, 2, 3, 99]);
const selected = allocation.subarray(1, 4);
const dataView = new DataView(allocation.buffer, 1, 3);

console.log(xxh3_64(selected) === xxh3_64(dataView));
console.log(xxh3_64(selected) === xxh3_64(new Uint8Array([1, 2, 3])));
```

Pass the view itself when you mean its selected bytes. Passing `selected.buffer` hashes the entire backing allocation instead. This distinction is especially important for slices and pooled buffers.

For a TypedArray, `.length` counts elements; hashing uses `.byteLength`. A view with four 32-bit elements contributes sixteen raw bytes, not four converted values.

### TypedArrays and byte order

Numeric TypedArrays are not serialized by numeric value. A `Uint16Array`, `Float32Array` or BigInt TypedArray contributes the bytes already stored in its backing allocation. Native multi-byte TypedArrays use the host's byte order. Equal numerical elements stored in different element types can therefore produce different digests.

For a canonical numeric encoding, write the selected byte order explicitly:

```ts
import { xxh3_64 } from 'react-native-nitro-xxhash';

const storage = new ArrayBuffer(4);
const encoded = new DataView(storage);
encoded.setUint32(0, 0x01020304, false); // Explicit big-endian encoding.

console.log(xxh3_64(encoded) === xxh3_64(new Uint8Array([1, 2, 3, 4])));
```

### Buffer

The package does not install a Buffer polyfill or depend on Node's runtime. If your app supplies a compatible Buffer implementation, pass the Buffer instance directly as a Uint8Array view.

```ts
import { Buffer } from 'buffer'; // Install/provide this polyfill in the application.
import { createHasher, xxh3_64 } from 'react-native-nitro-xxhash';

const allocation = Buffer.from([99, 1, 2, 3, 99]);
const selected = Buffer.from(allocation.buffer, allocation.byteOffset + 1, 3);

console.log(xxh3_64(selected) === xxh3_64(new Uint8Array([1, 2, 3])));

const hasher = createHasher('xxh3-64');
try {
  hasher.update(selected);
  console.log(hasher.digest() === xxh3_64(selected));
} finally {
  hasher.dispose();
}
```

The example's Buffer shares its original backing allocation. Supplying `.buffer` alone can include unrelated pooled bytes. Buffer support does not make this native React Native package a Node.js hashing implementation.

## Storage validity and ownership

Empty buffers and valid empty views are accepted. Empty input is not evidence that the storage is detached or invalid.

Detached ArrayBuffers, out-of-bounds views and SharedArrayBuffer-backed input are rejected with `TypeError`. Proxies and objects forged to resemble buffers or views are rejected; user-defined `buffer`, `byteOffset` or `byteLength` properties do not select another range.

When an engine provides resizable ArrayBuffers, a buffer/view is accepted only while its current range is valid. An out-of-bounds view is rejected rather than treated as an empty view; it may become valid again if its backing storage is resized appropriately. The package does not polyfill resizing or transfer APIs.

The native call borrows binary storage synchronously. It does not copy the input payload into a temporary byte buffer or retain it after the call. This does not imply that a call allocates nothing: range metadata, hashing state and returned digest representations can still allocate.

After `update()` returns, modifying its source cannot change bytes already incorporated into the state. Do not mutate, resize or detach an allocation concurrently from native code while it is being hashed. The string path performs UTF-8 encoding and does not share this binary no-copy contract.

```ts
import { createHasher, xxh3_64 } from 'react-native-nitro-xxhash';

const chunk = new Uint8Array([1, 2, 3]);
const hasher = createHasher('xxh3-64');
try {
  hasher.update(chunk);
  chunk.fill(9);
  console.log(hasher.digest() === xxh3_64(new Uint8Array([1, 2, 3])));
} finally {
  hasher.dispose();
}
```

## Digest representations

All algorithms return lowercase, fixed-width hex by default. The number of bytes is fixed by the algorithm:

| Algorithm | Hex characters | Digest bytes | Unsigned integer width |
| --------- | -------------- | ------------ | ---------------------- |
| XXH32     | 8              | 4            | 32 bits                |
| XXH64     | 16             | 8            | 64 bits                |
| XXH3-64   | 16             | 8            | 64 bits                |
| XXH3-128  | 32             | 16           | 128 bits               |

`'bytes'` uses canonical big-endian digest order, independent of the device's native byte order. It is the byte-pair representation of the hex string. Each call returns a new Uint8Array backed by a new ArrayBuffer. Changing that result cannot change hashing state or another result.

`'bigint'` returns the complete unsigned integer represented by the hex string; it never rounds through a JavaScript number. BigInt's string representation is not fixed-width, so converting it to text can omit leading zeros. Preserve hex or bytes when a protocol requires a fixed width.

```ts
import { xxh3_128 } from 'react-native-nitro-xxhash';

const input = new Uint8Array([1, 2, 3]);
const hex = xxh3_128(input);
const bytes = xxh3_128(input, { output: 'bytes' });
const integer = xxh3_128(input, { output: 'bigint' });

const hexFromBytes = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
console.log(hexFromBytes === hex);
console.log(integer === BigInt(`0x${hex}`));
```

All three representations describe the same digest for the same algorithm, input and seed. This does not make different algorithms interchangeable, even when they have the same width.
