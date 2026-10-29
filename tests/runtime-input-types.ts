import type { Buffer } from 'node:buffer';
import { createHasher, hashStream, xxh32, xxh64, xxh3_64, xxh3_128, xxh64File } from '../index';
import type {
  FileHashOptions,
  HashInput,
  HashOptions,
  HashOutput,
  HashSeed,
  HashStreamOptions,
  HashStreamSource,
} from '../index';

type PublicExports = typeof import('../index');
// @ts-expect-error ambiguous hash64 alias is not part of the public API
export type RemovedHash64 = PublicExports['hash64'];
// @ts-expect-error ambiguous hash128 alias is not part of the public API
export type RemovedHash128 = PublicExports['hash128'];
// @ts-expect-error ambiguous hashFile64 alias is not part of the public API
export type RemovedHashFile64 = PublicExports['hashFile64'];
// @ts-expect-error ambiguous hashFile128 alias is not part of the public API
export type RemovedHashFile128 = PublicExports['hashFile128'];

/** Compile-only contract: ordinary library annotations must not require casts. */
export function checkPublicInputTypes(
  typed: Uint8Array,
  numeric: Float32Array,
  data: DataView,
  buffer: Buffer,
  genericView: ArrayBufferView,
): void {
  const inputs: HashInput[] = [
    'text',
    new ArrayBuffer(0),
    typed,
    numeric,
    data,
    buffer,
    genericView,
  ];
  for (const hash of [xxh32, xxh64, xxh3_64, xxh3_128]) {
    for (const input of inputs) {
      const digest: string = hash(input);
      void digest;
    }
    // @ts-expect-error numbers require an explicit encoding
    hash(123);
    // @ts-expect-error ordinary arrays are not binary views
    hash([1, 2, 3]);
    // @ts-expect-error objects require an explicit serializer
    hash({ value: 123 });
  }
  const stream = createHasher('xxh3-128');
  for (const input of inputs) stream.update(input);
  // @ts-expect-error stream input follows the same explicit byte contract
  stream.update({ value: 123 });
  stream.dispose();
}

/** Wrappers may forward omitted options or a seed/options union without narrowing first. */
export function checkForwardedOptions(
  input: HashInput,
  source: AsyncIterable<HashInput>,
  options?: HashOptions,
  byteOptions?: HashOptions<'bytes'>,
  fileOptions?: FileHashOptions<'bigint'>,
  streamOptions?: HashStreamOptions<'bytes'>,
  seedOrOptions?: HashSeed | HashOptions<'bigint'>,
): void {
  const text: string = xxh64(input, options);
  const bytesOrText: string | Uint8Array = xxh64(input, byteOptions);
  const integerOrText: string | bigint = xxh64(input, seedOrOptions);
  const fileIntegerOrText: Promise<string | bigint> = xxh64File('/file', fileOptions);
  const fileSeedOrOptions: Promise<string | bigint> = xxh64File('/file', seedOrOptions);
  const streamBytesOrText: Promise<string | Uint8Array> = hashStream(source, streamOptions);
  const hasher = createHasher('xxh64');
  const digestBytesOrText: string | Uint8Array<ArrayBuffer> = hasher.digest(byteOptions?.output);
  const digestDefault: string = hasher.digest(undefined);
  // @ts-expect-error an omitted format selects hex
  const definitelyDigestBytes: Uint8Array = hasher.digest(byteOptions?.output);
  hasher.dispose();
  // @ts-expect-error omitted options and an omitted output both select hex
  const definitelyBytes: Uint8Array = xxh64(input, byteOptions);
  // @ts-expect-error omitted stream options select hex
  const definitelyStreamBytes: Promise<Uint8Array> = hashStream(source, streamOptions);
  void [
    text,
    bytesOrText,
    integerOrText,
    fileIntegerOrText,
    fileSeedOrOptions,
    streamBytesOrText,
    digestBytesOrText,
    digestDefault,
    definitelyDigestBytes,
    definitelyBytes,
    definitelyStreamBytes,
  ];
}

/** Parameters-based wrappers preserve the optional second argument of each API. */
export function checkForwardedArgumentTuples(
  input: HashInput,
  source: AsyncIterable<HashInput>,
): void {
  const hashArguments: Parameters<typeof xxh64> = [input];
  const fileArguments: Parameters<typeof xxh64File> = ['/file'];
  const streamArguments: Parameters<typeof hashStream> = [source];
  const hash = (...arguments_: Parameters<typeof xxh64>) => xxh64(...arguments_);
  const hashFile = (...arguments_: Parameters<typeof xxh64File>) => xxh64File(...arguments_);
  const consume = (...arguments_: Parameters<typeof hashStream>) => hashStream(...arguments_);
  hash(...hashArguments);
  hash(input);
  void hashFile(...fileArguments);
  void hashFile('/file');
  void consume(...streamArguments);
  void consume(source);
}

/** Byte digests own an ordinary ArrayBuffer that can be fed back into native APIs. */
export async function checkOwnedDigestBytes(
  input: HashInput,
  source: AsyncIterable<HashInput>,
): Promise<void> {
  const bytes: Uint8Array<ArrayBuffer> = xxh64(input, { output: 'bytes' });
  const backing: ArrayBuffer = bytes.buffer;
  xxh64(backing);
  const hasher = createHasher('xxh64');
  try {
    const snapshot: Uint8Array<ArrayBuffer> = hasher.digest('bytes');
    hasher.update(snapshot.buffer);
  } finally {
    hasher.dispose();
  }
  const fileBytes: Uint8Array<ArrayBuffer> = await xxh64File('/file', { output: 'bytes' });
  const streamBytes: Uint8Array<ArrayBuffer> = await hashStream(source, { output: 'bytes' });
  xxh64(fileBytes.buffer);
  xxh64(streamBytes.buffer);
}

/** Literal formats narrow results; an optional format must preserve the hex alternative. */
export function checkPublicResultTypes(
  input: HashInput,
  chunks: AsyncIterable<HashInput>,
  readable: HashStreamSource,
  signal: AbortSignal,
  output: HashOutput,
): void {
  const text: string = xxh64(input, 42n);
  const bytes: Uint8Array = xxh64(input, { seed: 42n, output: 'bytes' });
  const integer: bigint = xxh3_128(input, { output: 'bigint' });
  const fallback: string = xxh32(input, {});
  const optional: HashOptions<'bytes'> = {};
  const maybeBytes: string | Uint8Array = xxh64(input, optional);
  // @ts-expect-error optional output can be absent, returning hex
  const mustBeBytes: Uint8Array = xxh64(input, optional);
  const optionalFile: FileHashOptions<'bigint'> = { signal };
  const maybeInteger: Promise<string | bigint> = xxh64File('/file', optionalFile);
  // @ts-expect-error optional output can be absent, returning hex
  const mustBeInteger: Promise<bigint> = xxh64File('/file', optionalFile);
  const fileBytes: Promise<Uint8Array> = xxh64File('/file', { output: 'bytes', signal });
  const streamText: Promise<string> = hashStream(chunks);
  const streamBytes: Promise<Uint8Array> = hashStream(readable, { output: 'bytes', signal });
  const streamInteger: Promise<bigint> = hashStream(chunks, { output: 'bigint' });
  const union: string | Uint8Array | bigint = xxh64(input, { output });
  const stream = createHasher('xxh3-128');
  const cloned = stream.clone();
  const digestText: string = cloned.digest();
  const digestBytes: Uint8Array = cloned.digest('bytes');
  const digestInteger: bigint = cloned.digest('bigint');
  // @ts-expect-error only declared output formats are supported
  xxh64(input, { output: 'base64' });
  // @ts-expect-error synchronous hash functions do not accept cancellation
  xxh64(input, { signal });
  // @ts-expect-error plain arrays are not an asynchronous source of chunks
  void hashStream([input]);
  stream.dispose();
  cloned.dispose();
  void [
    text,
    bytes,
    integer,
    fallback,
    maybeBytes,
    mustBeBytes,
    maybeInteger,
    mustBeInteger,
    fileBytes,
    streamText,
    streamBytes,
    streamInteger,
    union,
    digestText,
    digestBytes,
    digestInteger,
  ];
}
