---
title: React Native Nitro xxHash
description: Native XXH32, XXH64, XXH3-64 and XXH3-128 for strings, binary data, local files and asynchronous streams in React Native.
slug: /
sidebar_label: Overview
---

import Link from '@docusaurus/Link';

<div className="docs-eyebrow">React Native · Nitro Modules · C++</div>

<p className="docs-lead">Hash strings, bytes and files with a consistent API. Choose a one-shot function, keep incremental state, or consume an asynchronous source.</p>

<div className="api-cards">
  <Link className="api-card" to="/api/one-shot">
    <strong>One-shot hashing ↗</strong>
    <span>XXH32, classic XXH64, XXH3-64 and XXH3-128. Full-width seeds and three output formats.</span>
  </Link>
  <Link className="api-card" to="/api/inputs-and-outputs">
    <strong>Binary data ↗</strong>
    <span>ArrayBuffer, TypedArray, DataView and Buffer. Hash the exact selected byte range without copying its payload.</span>
  </Link>
  <Link className="api-card" to="/guides/files">
    <strong>Local files ↗</strong>
    <span>Background file hashing with bounded concurrency, URI handling and AbortSignal cancellation.</span>
  </Link>
  <Link className="api-card" to="/guides/streams">
    <strong>Streams and chunks ↗</strong>
    <span>Update a hasher yourself, or consume async iterables and readable streams one chunk at a time.</span>
  </Link>
</div>

## Start with a hash

[Install the package and apply the Nitro compatibility helper](installation.md), then import the operation you need:

```ts
import { xxh3_64, xxh3_128, createHasher } from 'react-native-nitro-xxhash';

const hex = xxh3_64('hello');
const bytes = xxh3_128(new Uint8Array([1, 2, 3]), { output: 'bytes' });

const hasher = createHasher('xxh3-128', 42n);
try {
  hasher.update('hello').update(' world');
  const digest = hasher.digest();
  console.log({ hex, bytes, digest });
} finally {
  hasher.dispose();
}
```

## Choose an operation

| Input or workflow                              | API                                                                        | Execution                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Text or in-memory bytes                        | [`xxh32`, `xxh64`, `xxh3_64`, `xxh3_128`](api/one-shot.md)                 | Synchronous on the calling JS thread.                         |
| Several chunks, checkpoints or branching state | [`createHasher`](api/create-hasher.md)                                     | Synchronous updates; explicitly owned native state.           |
| A regular local file                           | [`xxh32File`, `xxh64File`, `xxh3_64File`, `xxh3_128File`](guides/files.md) | Promise; native background file workers.                      |
| An async iterable or readable stream           | [`hashStream`](guides/streams.md)                                          | Promise; sequential reads with synchronous hashing per chunk. |

XXH64 and XXH3-64 are different algorithms. Use the same algorithm, encoding and seed wherever digests need to match. Results are lowercase hex by default; [canonical bytes and bigint](api/inputs-and-outputs.md#digest-representations) are also available.

## Runtime requirements

React Native **0.88+**, iOS **15.1+** or Android **API 24+**, and **Nitro Modules exactly 0.37.1**. Follow [installation](installation.md) for the required Nitro repair and [compatibility](compatibility.md) for host toolchain configuration. Expo requires a development build.

Strings are encoded as UTF-8. Binary views preserve their original allocation, offset and length. Files must stay stable while native reading is in progress. See [input contracts](api/inputs-and-outputs.md) and [cancellation and errors](guides/errors-and-cancellation.md) before integrating untrusted or cancellable sources.

xxHash is non-cryptographic. Use a cryptographic primitive for authentication, signatures or integrity checks against adversarial input.
