import { createHasher, hashStream, xxh64, xxh64File } from 'react-native-nitro-xxhash';
import type {
  FileHashOptions,
  HashAlgorithm,
  HashInput,
  HashOptions,
  HashOutput,
  HashResult,
  HashStreamOptions,
  HashStreamSource,
} from 'react-native-nitro-xxhash';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type Bytes = Uint8Array<ArrayBuffer>;

declare const input: HashInput;
declare const source: AsyncIterable<HashInput>;
declare const output: HashOutput | undefined;
declare const optionalBytes: HashOptions<'bytes'> | undefined;

export function forwardOptionalValues(
  seed?: HashOptions['seed'],
  requested?: HashOutput,
  signal?: AbortSignal,
  algorithm?: HashAlgorithm,
) {
  return [
    xxh64(input, { seed }),
    xxh64(input, { output: requested }),
    xxh64File('/file', { seed, output: requested, signal }),
    hashStream(source, { seed, output: requested, signal, algorithm }),
  ];
}

export const defaults: HashOptions = { seed: undefined, output: undefined };
export const fileDefaults: FileHashOptions = { signal: undefined };
export const streamDefaults: HashStreamOptions = { algorithm: undefined };

const text = xxh64(input, { seed: undefined, output: undefined });
const bytes = xxh64(input, { seed: undefined, output: 'bytes' });
const integer = xxh64(input, { output: 'bigint' });
const mixed = xxh64(input, { output });
const maybeBytes = xxh64(input, optionalBytes);
const fileBytes = xxh64File('/file', { output: 'bytes', signal: undefined });
const streamBytes = hashStream(source, { output: 'bytes', algorithm: undefined });
const state = createHasher('xxh64');
const defaultDigest = state.digest(undefined);
const byteDigest = state.digest('bytes');
xxh64(bytes.buffer);
xxh64(byteDigest.buffer);

export type ResultAssertions = [
  Expect<Equal<typeof text, string>>,
  Expect<Equal<typeof bytes, Bytes>>,
  Expect<Equal<typeof integer, bigint>>,
  Expect<Equal<typeof mixed, HashResult<HashOutput>>>,
  Expect<Equal<typeof maybeBytes, string | Bytes>>,
  Expect<Equal<typeof fileBytes, Promise<Bytes>>>,
  Expect<Equal<typeof streamBytes, Promise<Bytes>>>,
  Expect<Equal<typeof defaultDigest, string>>,
  Expect<Equal<typeof byteDigest, Bytes>>,
];

export const hashArguments: Parameters<typeof xxh64> = [input];
export const fileArguments: Parameters<typeof xxh64File> = ['/file'];
export const sourceArguments: Parameters<typeof hashStream> = [source];

export const structural: HashStreamSource = {
  getReader: () => ({
    read: async () => ({ done: true, value: undefined }),
    cancel() {},
    releaseLock() {},
  }),
};
export const terminalChunk: HashStreamSource = {
  getReader: () => ({
    read: async () => ({ done: true, value: 'ignored terminal chunk' }),
    cancel() {},
    releaseLock() {},
  }),
};
declare const booleanAndChunk: { done: boolean; value: HashInput };
export const booleanReader: HashStreamSource = {
  getReader: () => ({
    read: () => Promise.resolve(booleanAndChunk),
    cancel() {},
    releaseLock() {},
  }),
};
const missingChunk = {
  getReader: () => ({
    read: async () => ({ done: false as const }),
    cancel() {},
    releaseLock() {},
  }),
};
const undefinedChunk = {
  getReader: () => ({
    read: async () => ({ done: false as const, value: undefined }),
    cancel() {},
    releaseLock() {},
  }),
};
const invalidDone = {
  getReader: () => ({
    read: async () => ({ done: undefined, value: 'chunk' }),
    cancel() {},
    releaseLock() {},
  }),
};

// @ts-expect-error A readable reader still requires a boolean done flag.
void hashStream(invalidDone);
// @ts-expect-error A nonterminal reader result must provide a chunk.
void hashStream(missingChunk);
// @ts-expect-error Undefined is not a valid nonterminal chunk.
void hashStream(undefinedChunk);
// @ts-expect-error An omitted output may return hex.
export const definitelyBytes: Bytes = xxh64(input, optionalBytes);
// @ts-expect-error Only declared output formats are supported.
xxh64(input, { output: 'number' });
// @ts-expect-error Synchronous hashing does not accept cancellation.
xxh64(input, { signal: undefined });
