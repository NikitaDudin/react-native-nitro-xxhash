import type { HashAlgorithm } from './HashAlgorithm';
import type { HashInput } from './HashInput';
import type { HashOutput, HashResult } from './HashOutput';
import type { HashSeed } from './HashSeed';

/** An incremental hash owned by the calling JS runtime. */
export interface HashStream {
  readonly algorithm: HashAlgorithm;
  /** Consume raw bytes immediately; views use only byteOffset/byteLength, without copying or retaining their buffer. */
  update(input: HashInput): this;
  /** Read canonical lowercase hex without finalizing or clearing the stream. */
  digest(output?: 'hex'): string;
  digest<T extends HashOutput>(output: T): HashResult<T>;
  digest<T extends HashOutput>(output?: T): HashResult<T | 'hex'>;
  /** Copy the current hash state and seed into an independently owned stream. */
  clone(): HashStream;
  /** Clear chunks, preserving the current seed unless a new one is supplied. */
  reset(seed?: HashSeed): this;
  /** Release native state. Idempotent; other operations then throw. */
  dispose(): void;
}
