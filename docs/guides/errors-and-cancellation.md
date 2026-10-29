---
title: Errors and cancellation
description: Handle synchronous errors, asynchronous rejections, AbortError and native/source cleanup without losing resource ownership.
sidebar_position: 3
---

# Errors and cancellation

Use synchronous `try`/`catch` for in-memory hashing and manual hashers. Use `await` inside `try`/`catch` for files and asynchronous sources.

## Which calls throw or reject?

| API                                                     | Error delivery                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------- |
| `xxh32`, `xxh64`, `xxh3_64`, `xxh3_128`                 | Throws synchronously.                                                      |
| `createHasher` and `HashStream` methods                 | Throws synchronously.                                                      |
| `xxh32File`, `xxh64File`, `xxh3_64File`, `xxh3_128File` | Rejects the returned Promise, including argument-validation failures.      |
| `hashStream`                                            | Rejects the returned Promise, including option/source-validation failures. |

`hashStream` returns a Promise even when the source has not been acquired yet. Attach a rejection handler before allowing unrelated work or cancellation to proceed.

## Input and configuration errors

JavaScript validation reports `TypeError` for unsupported input brands, unsupported algorithm/output values, malformed options, unknown option keys and invalid source protocols. Numeric seeds that are negative, outside the algorithm's unsigned range or not safe integers report `RangeError`. The selected algorithm determines the seed range.

```ts
import { xxh32, xxh64 } from 'react-native-nitro-xxhash';

try {
  xxh32('data', -1);
} catch (error) {
  if (error instanceof RangeError) {
    console.log('Choose an unsigned 32-bit seed');
  } else {
    throw error;
  }
}

// TypeScript also protects this call before runtime validation.
try {
  // @ts-expect-error Numbers are not HashInput; choose an explicit encoding.
  xxh64(123);
} catch (error) {
  if (!(error instanceof TypeError)) throw error;
}
```

The implementation does not silently coerce a number, object or ordinary array into bytes or text. Encode those values explicitly before hashing. See [inputs and outputs](../api/inputs-and-outputs.md).

Validation of a file path's JavaScript type and options occurs in JavaScript. The native layer checks its path/URI syntax, accessibility and regular-file status. Such failures are Promise rejections, but their error class/message is not a public contract. Source-provided getters, methods and read operations can also throw their own errors.

## Native and source failures

Missing files, denied access, failed reads and native initialization failures reject asynchronous operations. For synchronous hashing, native failures throw at the call site. Inspect an error for application logging, but do not branch on an exact native message or assume every native failure has the same JavaScript subclass.

```ts
import { xxh3_128File } from 'react-native-nitro-xxhash';

async function digestFile(path: string): Promise<string | undefined> {
  try {
    return await xxh3_128File(path);
  } catch (error) {
    console.error('Unable to hash the selected local file', error);
    return undefined;
  }
}

await digestFile('/application-owned/documents/archive.bin');
```

The package does not automatically retry file reads or stream consumption. Correct the underlying cause before a later call. A later public invocation can retry a failed native initialization. For `hashStream`, a failed attempt may have advanced, cancelled or closed the source; obtain a fresh source before retrying unless its owner explicitly supports reuse.

## AbortError and cause

Only file helpers and `hashStream` accept an AbortSignal. One-shot functions and manual `HashStream.update()` are synchronous and have no cancellation option.

An observed abort rejects with an `Error` whose `name` is `AbortError`. When `signal.reason` is not `undefined`, that value is retained in `error.cause`. The error is not guaranteed to be a DOMException, so check its name rather than using `instanceof DOMException`.

```ts
import { xxh3_128File } from 'react-native-nitro-xxhash';

const controller = new AbortController();
const reason = new Error('The owning screen closed');
const pending = xxh3_128File('/application-owned/documents/archive.bin', {
  signal: controller.signal,
});

const handled = pending.catch((error: unknown) => {
  if (error instanceof Error && error.name === 'AbortError') {
    if ('cause' in error) console.log(error.cause === reason);
    return undefined;
  }
  throw error;
});

controller.abort(reason);
await handled;
```

The package does not install AbortController or AbortSignal polyfills. Use the host's implementation or a compatible implementation supplied by the application.

## Pre-aborted requests

For valid arguments, a pre-aborted file request rejects before opening a file or initializing Nitro. A pre-aborted `hashStream` request rejects before acquiring a reader/iterator or creating native state.

Argument/options validation can fail first. Passing an aborted signal does not turn an invalid seed, unsupported option or wrong path type into a successful request or guarantee AbortError takes precedence over validation.

## Completion and cancellation races

Cancellation is cooperative:

- A successful operation whose public result already settled stays successful after a later abort.
- A queued file operation is removed before native work starts.
- An active file operation rejects promptly on abort, while its native worker may still be finishing an issued OS read. Its admission slot remains occupied until native settlement.
- A stream abort can reject while its producer's read or cleanup is still pending. Later chunks are not consumed after the abort is observed.
- A synchronous hash/update already executing on JavaScript cannot be interrupted by a timer on that same thread.

Do not treat public rejection as proof that arbitrary producer work or an already-issued OS read has stopped. Keep the file stable until the native read has ended, and use source-specific cancellation when your producer owns additional work. Avoid deleting or overwriting an active input merely because its public Promise rejected on abort.

## Resource cleanup

`hashStream` owns its internal hasher and attempts to dispose it on success, failure and cancellation. It requests early source closure only before EOF and attempts reader-lock release on every acquired-reader exit. See [stream cleanup](streams.md#cancellation-and-source-cleanup) for the reader/iterator differences.

If a read, hash or abort already failed, that primary error wins over cleanup failures. An otherwise successful operation can still reject if synchronous lock release or native-state disposal fails. Asynchronous early-close promises are observed without delaying public failure.

A manual hasher belongs to its caller. Release it in `finally`:

```ts
import { createHasher } from 'react-native-nitro-xxhash';

const hasher = createHasher('xxh3-128');
try {
  hasher.update('first').update(new Uint8Array([1, 2, 3]));
  console.log(hasher.digest());
} finally {
  hasher.dispose();
}
```

After normal disposal, repeat disposal is harmless; `update`, `digest`, `reset` and `clone` throw. Each clone owns an independent state and must be disposed separately. See [incremental hashing](../api/create-hasher.md).
