import { Buffer } from 'node:buffer';
import { ReadableStream } from 'node:stream/web';
import { hashStream, xxh64 } from 'react-native-nitro-xxhash';
import type { HashInput, HashStreamSource } from 'react-native-nitro-xxhash';

type Reader = ReturnType<Extract<HashStreamSource, { getReader(): unknown }>['getReader']>;

const source = new ReadableStream<HashInput>();
export const standardReader: Reader = source.getReader();
export const acceptedSource: HashStreamSource = source;
export const bytes: Promise<Uint8Array<ArrayBuffer>> = hashStream(source, { output: 'bytes' });
export const integer: bigint = xxh64(Buffer.from([1, 2, 3]), { output: 'bigint' });

const eof: Awaited<ReturnType<Reader['read']>> = { done: true, value: undefined };
export const explicitEofSource: HashStreamSource = {
  getReader: () => ({
    read: () => Promise.resolve(eof),
    cancel() {},
    releaseLock() {},
  }),
};
