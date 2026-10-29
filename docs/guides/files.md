---
title: File hashing
description: Hash regular local files with XXH32, XXH64, XXH3-64 and XXH3-128, including seeds, result formats and cancellation.
sidebar_position: 1
---

# File hashing

Use file helpers when the input already lives on disk. They read and hash the file on native background workers and return the digest as a Promise. File bytes do not need to pass through JavaScript.

| Function                       | Algorithm     | Default result             |
| ------------------------------ | ------------- | -------------------------- |
| `xxh32File(path, options?)`    | XXH32         | 8-character lowercase hex  |
| `xxh64File(path, options?)`    | Classic XXH64 | 16-character lowercase hex |
| `xxh3_64File(path, options?)`  | XXH3-64       | 16-character lowercase hex |
| `xxh3_128File(path, options?)` | XXH3-128      | 32-character lowercase hex |

Classic XXH64 and XXH3-64 are different algorithms. Choose the function that matches the format or system with which you exchange hashes.

## Hash a local file

Obtain a readable file path from your app's storage or file-selection layer. Replace the example path with a real, application-accessible file:

```ts
import { xxh32File, xxh64File, xxh3_64File, xxh3_128File } from 'react-native-nitro-xxhash';

async function hashFileWithEveryAlgorithm(path: string) {
  const classic32 = await xxh32File(path);
  const classic64 = await xxh64File(path);
  const xxh3_64 = await xxh3_64File(path);
  const xxh3_128 = await xxh3_128File(path);

  return { classic32, classic64, xxh3_64, xxh3_128 };
}

await hashFileWithEveryAlgorithm('/application-owned/documents/archive.bin');
```

Each call performs its own read. Calling several algorithms on one path does not reuse another operation's file data or state.

All file helpers return Promises, including for invalid input or initialization failure. Use `await` inside `try`/`catch`, or attach a rejection handler. Calling a helper without awaiting or observing its Promise can leave an error unhandled.

## Seeds and output formats

The second argument is either a seed or an options object. Options are:

| Field    | Default | Meaning                                                    |
| -------- | ------- | ---------------------------------------------------------- |
| `seed`   | `0`     | Unsigned number or bigint seed for the selected algorithm. |
| `output` | `'hex'` | `'hex'`, `'bytes'` or `'bigint'`.                          |
| `signal` | Omitted | AbortSignal for cancelling this operation.                 |

A bare seed returns hex. To select another format, pass an options object:

```ts
import { xxh64File, xxh3_128File } from 'react-native-nitro-xxhash';

async function hashSeededFile(path: string) {
  const seededHex: string = await xxh64File(path, 42n);
  const bytes: Uint8Array<ArrayBuffer> = await xxh3_128File(path, {
    seed: 42n,
    output: 'bytes',
  });
  const integer: bigint = await xxh3_128File(path, { output: 'bigint' });

  return { seededHex, bytes, integer };
}

await hashSeededFile('/application-owned/documents/archive.bin');
```

Seed limits are the same as for [one-shot hashing](../api/one-shot.md): unsigned 32-bit for XXH32 and unsigned 64-bit for the other algorithms. Number seeds must be safe integers; use bigint for larger values. The `'bytes'` result is canonical big-endian digest data, not the file's original bytes. See [input and output formats](../api/inputs-and-outputs.md).

Keep `output` required in the options value when you want a precise inferred result type. `satisfies` checks the options shape without widening the literal:

```ts
import { xxh3_128File, type FileHashOptions } from 'react-native-nitro-xxhash';

const options = { output: 'bytes', seed: 7n } satisfies FileHashOptions<'bytes'>;
const digest: Uint8Array<ArrayBuffer> = await xxh3_128File(
  '/application-owned/documents/archive.bin',
  options,
);

console.log(digest.byteLength);
```

A variable annotated only as `FileHashOptions<'bytes'>` can omit `output`, so its result may include the default hex type. Use a literal, `satisfies`, or explicit narrowing when exact result types matter.

## Accepted paths and URIs

The input must be a string naming a regular local file that the application can read.

| Input                                                     | Behavior                                               |
| --------------------------------------------------------- | ------------------------------------------------------ |
| Absolute path beginning with `/`                          | Passed to the native file layer as a path.             |
| `file:///absolute/path`                                   | Accepted; percent escapes are decoded.                 |
| `file://localhost/absolute/path`                          | Accepted local authority; percent escapes are decoded. |
| Relative path                                             | Rejected.                                              |
| `content://`, `https://`, or another scheme               | Rejected.                                              |
| `file://remote-host/path`                                 | Rejected.                                              |
| Empty string, NUL, malformed percent escape in a file URI | Rejected.                                              |
| Directory, pipe or another non-regular file               | Rejected.                                              |

Use the lowercase `file://` forms shown above. The library does not interpret other URI spellings or normalize remote authorities into local ones.

For a raw absolute path, `%`, `?` and `#` are literal filename characters. For a file URI, percent-encode them as `%25`, `%3F` and `%23`. A URI containing an unescaped query or fragment character is rejected rather than truncated:

```ts
import { xxh3_128File } from 'react-native-nitro-xxhash';

// These identify the same filename when that file exists in the app's storage.
const rawPath = '/application-owned/documents/report #%.bin';
const fileUri = 'file:///application-owned/documents/report%20%23%25.bin';

const fromPath = await xxh3_128File(rawPath);
const fromUri = await xxh3_128File(fileUri);
console.log(fromPath === fromUri);
```

An Android document picker may return a `content://` URI. Copy that document to an application-owned local file using the storage library you already use, then hash the resulting absolute path or `file://` URI. This package does not request storage permissions, resolve document providers or download remote URLs.

Metro's `require('./image.png')` returns an asset reference, not a file path. See [bundled assets and Metro](bundled-assets.md) for a complete `expo-asset` adapter, the limits of `Image.resolveAssetSource()`, and extra asset extensions.

## Download a file, then hash it

When a downloaded file is needed on disk, let your storage/network layer save it first. Await download completion before starting the native hasher. This avoids loading the entire response into a JavaScript ArrayBuffer.

For an app with Expo modules, install the optional integration:

```sh
npx expo install expo-file-system
```

This example uses the current [`File.downloadFileAsync()` API](https://docs.expo.dev/versions/latest/sdk/filesystem/#downloading-files). It creates an operation-owned cache directory and removes only that directory after hashing, including on download/hash failure:

```ts
import { Directory, File, Paths } from 'expo-file-system';
import { xxh3_128File } from 'react-native-nitro-xxhash';

async function downloadAndHash(url: string): Promise<string> {
  const directory = new Directory(
    Paths.cache,
    `xxhash-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  directory.create();
  try {
    const file = await File.downloadFileAsync(url, new File(directory, 'payload.bin'));
    return await xxh3_128File(file.uri);
  } finally {
    directory.delete();
  }
}

console.log(await downloadAndHash('https://example.com/archive.bin'));
```

Replace the URL with your endpoint. If your application needs to keep the download, save it to your storage owner's destination and let that owner decide when to delete it. The hasher never deletes its input. A failed Android download can leave a partial file, which is why the example owns and cleans its destination.

Download cancellation belongs to the downloader. A signal passed to `xxh3_128File()` only governs the hashing operation after download completion. In a bare React Native app without Expo modules, use your existing file downloader and pass the resulting absolute path or local file URI to the same helper.

If you only need a digest and your fetch implementation supplies response chunks, [hash its response body as a stream](streams.md#fetch-responses) instead of saving and rereading a file.

## Cancellation

Pass a signal in the options object. Keep its controller with the operation's owner, such as a screen or upload task, and abort when that owner no longer needs the result:

```ts
import { xxh3_128File } from 'react-native-nitro-xxhash';

const controller = new AbortController();
const outcome = xxh3_128File('/application-owned/documents/archive.bin', {
  output: 'hex',
  signal: controller.signal,
}).then(
  (digest) => ({ status: 'complete' as const, digest }),
  (error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'cancelled' as const };
    }
    throw error;
  },
);

// A screen/task cleanup callback can call this controller too.
controller.abort('Result is no longer needed');
console.log(await outcome);
```

A valid, already-aborted request rejects before Nitro initialization and before file work begins. Later cancellation rejects promptly with an error named `AbortError`. A supplied abort reason is retained as its `cause`.

Queued work is removed before opening a file. An active native worker checks cancellation before opening and between read blocks, closes its descriptor and releases its state. An OS read already in progress is allowed to finish before cancellation is observed. Public Promise rejection therefore does not mean the native worker has already stopped. A result that settled before the abort remains successful.

For race behavior and error handling patterns, see [errors and cancellation](errors-and-cancellation.md).

## Execution and ownership

File helpers share a FIFO admission queue across algorithms. At most two operations per JavaScript runtime enter native code at once; additional operations wait in JavaScript. Two dedicated native file workers service the process, independently of Nitro's shared worker pool. Active cancelled work keeps its admission slot until its native result settles.

Each active read uses its own state and a 64 KiB native buffer. The helper does not accumulate the whole file or expose file chunks to JavaScript. Option validation, native initialization and result delivery still involve the calling JavaScript runtime; a Promise is not a promise that every part of setup runs off that thread.

Keep the file unchanged until the native operation finishes. Hashing is not a filesystem snapshot: concurrent writes, truncation or deletion can cause a failure or a digest of the bytes that were actually read. The library does not lock the file for you.

The queue does not bound the number of requests your application can create. When processing an unbounded list, schedule work in bounded batches so your own pending Promises and paths do not grow without limit.

## Errors

Wrong JavaScript argument types, invalid seeds and unsupported options reject the Promise. File syntax checks, regular-file checks, permissions, missing files and read failures are reported through native rejection. Do not depend on a particular native error message or assume a native path error is a JavaScript `TypeError`.

The helper does not automatically retry a failed file operation. Correct the path, permissions or initialization problem before retrying. A later invocation can retry after initialization failure. See [errors and cancellation](errors-and-cancellation.md) for the shared contract.
