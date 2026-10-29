import type { HashAlgorithm } from './HashAlgorithm';

export default function validateAlgorithm(algorithm: HashAlgorithm): void {
  if (
    algorithm !== 'xxh32' &&
    algorithm !== 'xxh64' &&
    algorithm !== 'xxh3-64' &&
    algorithm !== 'xxh3-128'
  ) {
    throw new TypeError('Expected xxh32, xxh64, xxh3-64, or xxh3-128');
  }
}
