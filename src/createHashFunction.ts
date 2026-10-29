import type { HashAlgorithm } from './HashAlgorithm';
import type { HashInput } from './HashInput';
import type { HashOptions } from './HashOptions';
import type { HashOutput, HashResult } from './HashOutput';
import type { HashSeed } from './HashSeed';
import convertHashOutput from './convertHashOutput';
import getFileHasher from './getFileHasher';
import normalizeHashInput from './normalizeHashInput';
import parseHashOptions from './parseHashOptions';
import type { FileHasher } from './specs/FileHasher.nitro';

export interface HashFunction {
  (input: HashInput, seed?: HashSeed): string;
  <T extends HashOutput>(input: HashInput, options: HashOptions<T> & { output: T }): HashResult<T>;
  (input: HashInput, options: HashOptions<'hex'> | undefined): string;
  <T extends HashOutput>(
    input: HashInput,
    options?: HashSeed | HashOptions<T>,
  ): HashResult<T | 'hex'>;
}

/** Public helpers deliberately hide the private, transport-oriented Nitro API. */
export default function createHashFunction(algorithm: HashAlgorithm): HashFunction {
  let hashString: FileHasher['hashString'] | undefined;
  let hashBuffer: FileHasher['hashBuffer'] | undefined;
  const hash = (input: HashInput, options?: HashSeed | HashOptions<HashOutput>) => {
    // A primitive string and omitted options already establish UTF-8 input,
    // seed zero and hex output. Keep the general validation path for all else.
    if (options === undefined && typeof input === 'string') {
      if (!hashString) {
        const hasher = getFileHasher();
        hashString = hasher.hashString.bind(hasher);
      }
      return hashString(input, algorithm, '0');
    }
    const parsed = parseHashOptions(options, algorithm);
    const normalized = normalizeHashInput(input);
    if (typeof normalized === 'string') {
      if (!hashString) {
        const hasher = getFileHasher();
        hashString = hasher.hashString.bind(hasher);
      }
      return convertHashOutput(hashString(normalized, algorithm, parsed.seed), parsed.output);
    }
    if (!hashBuffer) {
      const hasher = getFileHasher();
      hashBuffer = hasher.hashBuffer.bind(hasher);
    }
    return convertHashOutput(
      hashBuffer(
        normalized.buffer,
        normalized.byteOffset,
        normalized.byteLength,
        algorithm,
        parsed.seed,
      ),
      parsed.output,
    );
  };
  return hash as HashFunction;
}
