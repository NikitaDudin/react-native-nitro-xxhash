import type { HashAlgorithm } from './HashAlgorithm';
import type { FileHashOptions } from './HashOptions';
import type { HashOutput, HashResult } from './HashOutput';
import type { HashSeed } from './HashSeed';
import convertHashOutput from './convertHashOutput';
import getFileHasher from './getFileHasher';
import parseHashOptions from './parseHashOptions';
import runFileHash from './runFileHash';
import type { FileHasher } from './specs/FileHasher.nitro';

export interface FileHashFunction {
  (fileUri: string, seed?: HashSeed): Promise<string>;
  <T extends HashOutput>(
    fileUri: string,
    options: FileHashOptions<T> & { output: T },
  ): Promise<HashResult<T>>;
  (fileUri: string, options: FileHashOptions<'hex'> | undefined): Promise<string>;
  <T extends HashOutput>(
    fileUri: string,
    options?: HashSeed | FileHashOptions<T>,
  ): Promise<HashResult<T | 'hex'>>;
}

export default function createFileHashFunction(algorithm: HashAlgorithm): FileHashFunction {
  let hashFile: FileHasher['hashFile'] | undefined;
  let startFileHash: FileHasher['startFileHash'] | undefined;
  const hash = async (fileUri: string, options?: HashSeed | FileHashOptions<HashOutput>) => {
    if (typeof fileUri !== 'string') throw new TypeError('Expected a file path or URI string');
    const parsed = parseHashOptions(options, algorithm, { allowSignal: true });
    if (parsed.signal !== undefined) {
      const hex = await runFileHash(parsed.signal, () => {
        if (!startFileHash) {
          const hasher = getFileHasher();
          startFileHash = hasher.startFileHash.bind(hasher);
        }
        return startFileHash(fileUri, algorithm, parsed.seed);
      });
      return convertHashOutput(hex, parsed.output);
    }
    const hex = await runFileHash(undefined, () => ({
      result() {
        if (!hashFile) {
          const hasher = getFileHasher();
          hashFile = hasher.hashFile.bind(hasher);
        }
        return hashFile(fileUri, algorithm, parsed.seed);
      },
    }));
    return convertHashOutput(hex, parsed.output);
  };
  return hash as FileHashFunction;
}
