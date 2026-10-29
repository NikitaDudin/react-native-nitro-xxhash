import createFileHashFunction from './createFileHashFunction';
import createHashFunction from './createHashFunction';

/** Synchronous XXH32; defaults to eight lowercase hexadecimal characters. */
export const xxh32 = createHashFunction('xxh32');
/** Synchronous classic XXH64; defaults to 16 lowercase hexadecimal characters. */
export const xxh64 = createHashFunction('xxh64');
/** Synchronous XXH3-64; defaults to 16 lowercase hexadecimal characters. */
export const xxh3_64 = createHashFunction('xxh3-64');
/** Synchronous XXH3-128; defaults to 32 lowercase hexadecimal characters. */
export const xxh3_128 = createHashFunction('xxh3-128');

/** Background XXH32 of a regular local file. */
export const xxh32File = createFileHashFunction('xxh32');
/** Background classic XXH64 of a regular local file. */
export const xxh64File = createFileHashFunction('xxh64');
/** Background XXH3-64 of a regular local file. */
export const xxh3_64File = createFileHashFunction('xxh3-64');
/** Background XXH3-128 of a regular local file. */
export const xxh3_128File = createFileHashFunction('xxh3-128');
