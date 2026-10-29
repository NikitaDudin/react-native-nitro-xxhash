import type { HashAlgorithm } from './HashAlgorithm';
import type { HashSeed } from './HashSeed';
import type { HashStream } from './HashStream';
import NativeHashStream from './NativeHashStream';
import getFileHasher from './getFileHasher';
import serializeSeed from './serializeSeed';
import validateAlgorithm from './validateAlgorithm';

/** Create independent native streaming state for one algorithm and seed. */
export default function createHasher(algorithm: HashAlgorithm, seed?: HashSeed): HashStream {
  validateAlgorithm(algorithm);
  const serialized = serializeSeed(algorithm, seed);
  return new NativeHashStream(
    algorithm,
    serialized,
    getFileHasher().createHasher(algorithm, serialized),
  );
}
