---
title: Asynchronous streams
description: Hash AsyncIterable and readable-stream sources one chunk at a time, with explicit cleanup and cancellation.
sidebar_position: 2
---

# Asynchronous streams

`hashStream(source, options?)` consumes chunks from an asynchronous source and returns one final digest. Use it when another API already supplies chunks. If the input is a local file, [file helpers](files.md) read it directly in native code.

The function creates and owns an internal incremental hasher. You do not need to dispose that state yourself.

## Options and result

| Field       | Default      | Meaning                                            |
| ----------- | ------------ | -------------------------------------------------- |
| `algorithm` | `'xxh3-128'` | `'xxh32'`, `'xxh64'`, `'xxh3-64'` or `'xxh3-128'`. |
| `seed`      | `0`          | Seed valid for the selected algorithm.             |
| `output`    | `'hex'`      | `'hex'`, `'bytes'` or `'bigint'`.                  |
| `signal`    | Omitted      | AbortSignal for the entire consumption operation.  |

Unlike one-shot and file helpers, `hashStream` takes an options object rather than a bare seed. Unknown option keys are rejected.

Omitted options return `Promise<string>`. A literal `output: 'bytes'` returns a Promise of canonical digest bytes; `output: 'bigint'` returns a Promise of an unsigned bigint. See [types](../api/types.md) for generic result types and [input/output formats](../api/inputs-and-outputs.md) for seed and encoding rules.

## AsyncIterable

Every yielded chunk must be a `HashInput`: string, ArrayBuffer or an ArrayBuffer-backed TypedArray/DataView/Buffer.

```ts
import { hashStream, type HashInput } from 'react-native-nitro-xxhash';

async function* chunks(): AsyncGenerator<HashInput> {
  yield 'header:';
  yield new Uint8Array([1, 2, 3]);
  yield new DataView(new Uint8Array([9, 4, 5, 9]).buffer, 1, 2);
}

const digest: string = await hashStream(chunks());
const bytes: Uint8Array<ArrayBuffer> = await hashStream(chunks(), {
  algorithm: 'xxh64',
  seed: 42n,
  output: 'bytes',
});

console.log(digest, bytes);
```

The chunks above hash UTF-8 `header:` followed by bytes `1, 2, 3, 4, 5`. A string resembling a path remains text; yielding it does not open a file.

Only asynchronous iterables are accepted. A regular array or a plain synchronous iterator is not a stream source. Wrap synchronous data in an async generator when that ownership model is appropriate; for one in-memory value, use a [one-shot function](../api/one-shot.md) instead.

## Readable sources without DOM types

A source exposing `getReader()` can be passed directly when its reader follows this contract:

- `read()` returns a Promise-like result with `done: false` and a valid chunk, or `done: true` at EOF.
- `cancel(reason?)` requests that the source stop producing data.
- `releaseLock()` releases the acquired reader.

The public `HashStreamSource` type is structural. Your React Native TypeScript project does not need DOM declarations just to describe a source. The package does not install a `ReadableStream` polyfill.

```ts
import { hashStream, type HashStreamSource } from 'react-native-nitro-xxhash';

const source: HashStreamSource = {
  getReader() {
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4])];
    let index = 0;

    return {
      async read() {
        const value = chunks[index++];
        if (value === undefined) return { done: true as const };
        return { done: false as const, value };
      },
      cancel() {
        index = chunks.length;
      },
      releaseLock() {
        // Release source-specific resources here when your source owns them.
      },
    };
  },
};

const digest: bigint = await hashStream(source, { output: 'bigint' });
console.log(digest);
```

If a source exposes both `getReader()` and `Symbol.asyncIterator`, the reader path takes precedence. An already-locked standard ReadableStream can fail when `getReader()` is acquired; avoid consuming the same stream concurrently elsewhere.

Reader results at EOF may omit `value`; an EOF value is not hashed. Before EOF, the value must be a supported chunk. Empty strings, ArrayBuffers and views are valid chunks. A source with no chunks produces the selected algorithm's empty-input digest.

## Fetch responses

`hashStream` consumes a source, not a fetch `Response` object. Pass `response.body` only when the chosen fetch implementation actually exposes a readable body with `getReader()`. Check `response.ok` before hashing so that an HTTP error page is not mistaken for the requested content.

Plain React Native's built-in fetch uses its [whatwg-fetch/XHR implementation](https://github.com/react/react-native/blob/v0.88.0/packages/react-native/Libraries/Network/fetch.js); do not assume it has browser-style response-body streaming. Its body readers such as `arrayBuffer()` provide a whole-body fallback. Expo and other networking packages can replace the global fetch implementation, so a function named `fetch` alone does not establish which behavior you have.

### Whole-body fallback

This helper works with a fetch implementation that supports `response.arrayBuffer()`. Give each download its own controller and keep that controller with the screen or task that owns the operation:

```ts
import { xxh3_128 } from 'react-native-nitro-xxhash';

export async function hashBufferedDownload(
  url: string,
  controller: AbortController,
): Promise<string> {
  const signal = controller.signal;
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

    const bytes = await response.arrayBuffer();
    if (signal.aborted) {
      const error = new Error('Download aborted');
      error.name = 'AbortError';
      throw error;
    }
    return xxh3_128(bytes);
  } catch (error) {
    controller.abort();
    throw error;
  }
}
```

`arrayBuffer()` materializes the entire response body. The networking implementation may also buffer or copy it while converting from native data or a Blob. The subsequent hash borrows the resulting ArrayBuffer, but this is not an end-to-end zero-copy or bounded-memory download. Do not divide that already-buffered allocation into chunks and describe it as network streaming. For large disk-backed downloads, another option is to download into an app-owned file and use a [file helper](files.md).

The post-read abort check prevents starting the synchronous hash after an abort has been observed. It cannot interrupt an ArrayBuffer conversion or a hash already executing. Passing the signal to fetch controls the network operation according to that implementation's cancellation contract.

### Streaming with Expo fetch

In an Expo development build containing this native package, [Expo's fetch API](https://docs.expo.dev/versions/latest/sdk/expo/#expofetch-api) supplies a readable response body. Use an explicit named import so the selected transport is clear. This helper passes one signal to both the network request and `hashStream`:

```ts
import { fetch as expoFetch } from 'expo/fetch';
import { hashStream, type HashStreamSource } from 'react-native-nitro-xxhash';

type ReadableBody = Extract<HashStreamSource, { getReader(): unknown }>;
type StreamingFetch = (
  url: string,
  options: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; body: ReadableBody | null }>;

async function* emptyBody(): AsyncGenerator<Uint8Array> {
  // A null body represents no response bytes.
}

export async function hashStreamingDownload(
  url: string,
  controller: AbortController,
  fetchWithStreams: StreamingFetch = expoFetch,
): Promise<string> {
  const signal = controller.signal;
  try {
    const response = await fetchWithStreams(url, { signal });
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);

    const body = response.body;
    if (body !== null && (!body || typeof body.getReader !== 'function')) {
      throw new Error('This download requires a readable response body');
    }
    return await hashStream(body === null ? emptyBody() : body, {
      algorithm: 'xxh3-128',
      signal,
    });
  } catch (error) {
    controller.abort();
    throw error;
  }
}

const controller = new AbortController();
try {
  const digest = await hashStreamingDownload('https://example.com/archive.bin', controller);
  console.log(digest);
} finally {
  controller.abort();
}
```

The optional third parameter can accept another fetch implementation whose returned body satisfies the same reader contract. The runtime capability check catches an absent reader; `hashStream` also validates the acquired reader and its chunks. The package does not install a streaming transport or turn a buffered response into one.

Await the helper's returned Promise or attach a rejection handler immediately. Call `controller.abort()` from the operation owner's cleanup to stop both stages. The helper also aborts the request when an HTTP, reader or hashing error occurs, including failures before the body has been acquired. Network failures and network-level aborts follow the transport's error contract; once `hashStream` observes an abort, its own [AbortError contract](errors-and-cancellation.md#aborterror-and-cause) applies.

The helper treats an explicit `body: null` as empty input, as can occur for a bodyless response. It still passes the signal to `hashStream`, so cancellation applies to this case too. An empty readable body is also valid. An absent `body` property or a non-null body without `getReader()` indicates an unsupported transport and throws instead of silently hashing empty input.

### Consume the body once

Hash the binary chunks or ArrayBuffer supplied by fetch to preserve those bytes. `response.text()` decodes text; hashing that JavaScript string encodes it again as UTF-8 and may not reproduce the original body bytes. These helpers hash body content, not HTTP headers or transport framing.

A response body is consumable once. Do not call `arrayBuffer()`, `text()` or `json()` on the same response after streaming its body, and do not give its reader to another consumer at the same time. Cloning/teeing a response can introduce extra buffering, especially when consumers run at different speeds. Choose a single owner for the body rather than duplicating it just to calculate a digest.

Streaming avoids this helper collecting the entire response, but the transport can still buffer data. Each chunk is hashed on the JavaScript thread; the normal [thread and yielding limits](#javascript-thread-behavior) still apply.

## Ordering and buffer lifetime

The library requests one result, waits for it and synchronously hashes its chunk before requesting another. It does not prefetch the next chunk or retain a list of chunks. Each binary chunk uses its view's exact `byteOffset` and `byteLength` without a payload copy.

A producer can reuse a backing allocation after the consumer advances to the next request:

```ts
import { hashStream } from 'react-native-nitro-xxhash';

async function* reusedBuffer() {
  const chunk = new Uint8Array(2);
  chunk.set([1, 2]);
  yield chunk;
  chunk.set([3, 4]);
  yield chunk;
}

// Equivalent input bytes: 1, 2, 3, 4.
console.log(await hashStream(reusedBuffer(), { algorithm: 'xxh3-64' }));
```

Do not mutate a chunk concurrently from another native thread while it is being hashed. A zero-copy input contract requires the producer to keep those bytes stable during the synchronous update.

## Text chunks and Unicode

Each string chunk is independently UTF-8 encoded. Chunking text at arbitrary UTF-16 indices can split a surrogate pair, changing the encoded byte sequence and the digest.

Keep a complete surrogate pair in one chunk, or let the producer encode text to bytes with a streaming encoder before hashing its binary chunks. The package does not normalize Unicode or provide a streaming text encoder. See the [string contract](../api/inputs-and-outputs.md).

## Cancellation and source cleanup

```ts
import { hashStream, type HashInput } from 'react-native-nitro-xxhash';

async function* source(): AsyncGenerator<HashInput> {
  try {
    yield 'first';
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    yield 'second';
  } finally {
    // Release producer-owned resources here.
  }
}

const controller = new AbortController();
const outcome = hashStream(source(), { signal: controller.signal }).then(
  (digest) => ({ status: 'complete' as const, digest }),
  (error: unknown) => {
    if (error instanceof Error && error.name === 'AbortError') {
      return { status: 'cancelled' as const };
    }
    throw error;
  },
);

controller.abort('No longer needed');
console.log(await outcome);
```

For a valid request whose signal is already aborted, no source reader/iterator is acquired and no native hasher is created. Later abort rejects promptly, even if `read()` or `next()` is still pending. The source remains responsible for making its own pending work stoppable.

| Exit                           | Reader source                                        | Async iterator                 |
| ------------------------------ | ---------------------------------------------------- | ------------------------------ |
| Successful EOF                 | Attempt to release the reader lock.                  | No early `return()` request.   |
| Failure or abort before EOF    | Request `cancel(reason)` and attempt lock release.   | Request `return()` if present. |
| Failure after EOF was observed | Attempt lock release; no extra cancellation request. | No extra `return()` request.   |

Native hasher disposal is attempted on every exit. Cancellation and early cleanup do not wait for a source's `cancel()` or `return()` Promise to resolve. Late source/cleanup rejections remain observed, and cleanup failure does not replace the primary read, hash or abort error. A synchronous lock-release or native-disposal failure on an otherwise successful operation can reject that operation.

A nonstandard reader may refuse lock release while its read is pending. The library retries release after that pending operation settles; public cancellation does not wait for the retry. Arbitrary generators and readers may keep their own resources until their producer-specific cancellation completes.

See [errors and cancellation](errors-and-cancellation.md) for error shapes and race behavior.

## JavaScript thread behavior

`hashStream` is asynchronous because it obtains chunks asynchronously. Its `update()` calls still hash strings and buffers on the calling JavaScript thread. Large chunks can block that thread during hashing.

A producer of immediately ready CPU-generated chunks should periodically yield to the host event loop, allowing UI work and cancellation timers to run. An async generator or `await Promise.resolve()` alone does not guarantee a host event-loop yield. For example:

```ts
import { hashStream } from 'react-native-nitro-xxhash';

async function* generatedChunks() {
  for (let index = 0; index < 200; index += 1) {
    yield new Uint8Array([index & 0xff]);
    if ((index + 1) % 20 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
}

console.log(await hashStream(generatedChunks()));
```

Choose yielding frequency for your workload. The library does not add its own timer scheduler, move arbitrary sources to another runtime or expose a worklet API.
