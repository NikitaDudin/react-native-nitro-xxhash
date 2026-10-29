import type { HashAlgorithm } from './HashAlgorithm';
import type { FileHashOptions } from './HashOptions';
import type { HashOutput } from './HashOutput';

/** Options for consuming an asynchronous source without accumulating its chunks. */
export interface HashStreamOptions<T extends HashOutput = 'hex'> extends FileHashOptions<T> {
  algorithm?: HashAlgorithm | undefined;
}
