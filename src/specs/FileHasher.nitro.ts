import type { HybridObject } from 'react-native-nitro-modules';
import type { HashAlgorithm } from '../HashAlgorithm';
import type { HashState } from './HashState.nitro';
import type { HashFileTask } from './HashFileTask.nitro';

/** Private native transport; public helpers validate inputs and preserve full-width seeds. */
export interface FileHasher extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** SIMD selected for this CPU: neon, sse2, or scalar. */
  readonly simdBackend: string;
  /** Internal seeded API; seed is unsigned decimal to preserve all 64 bits. */
  hashString(input: string, algorithm: HashAlgorithm, seed: string): string;
  hashBuffer(
    input: ArrayBuffer,
    byteOffset: number,
    byteLength: number,
    algorithm: HashAlgorithm,
    seed: string,
  ): string;
  /** Stream a regular local file with a 64 KiB buffer on the owned file workers. */
  hashFile(fileUri: string, algorithm: HashAlgorithm, seed: string): Promise<string>;
  createHasher(algorithm: HashAlgorithm, seed: string): HashState;
  /** Start background file hashing with an independently cancellable task. */
  startFileHash(fileUri: string, algorithm: HashAlgorithm, seed: string): HashFileTask;
}
