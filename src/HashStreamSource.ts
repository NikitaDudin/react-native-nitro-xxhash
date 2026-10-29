import type { HashInput } from './HashInput';

/** The default-reader shape shared by platform ReadableStream implementations. */
export interface ReadableHashStreamReader {
  read(): PromiseLike<
    { done: false; value: HashInput } | { done: true; value?: HashInput | undefined }
  >;
  cancel(reason?: unknown): unknown;
  releaseLock(): void;
}

/** A structural stream type that does not require the DOM library in RN projects. */
export interface ReadableHashStream {
  getReader(): ReadableHashStreamReader;
}

/** A sequential source of UTF-8 text or borrowed binary chunks. */
export type HashStreamSource = AsyncIterable<HashInput> | ReadableHashStream;
