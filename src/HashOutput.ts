/** Canonical hex, big-endian digest bytes, or an unsigned integer. */
export type HashOutput = 'hex' | 'bytes' | 'bigint';

export type HashResult<T extends HashOutput> = T extends 'hex'
  ? string
  : T extends 'bytes'
    ? Uint8Array<ArrayBuffer>
    : bigint;
