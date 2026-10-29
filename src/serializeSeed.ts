import type { HashAlgorithm } from './HashAlgorithm';
import type { HashSeed } from './HashSeed';

const MAX_UINT32 = 0xffffffffn;
const MAX_UINT64 = 0xffffffffffffffffn;

/** Keep seed validation ahead of native initialization and any file work. */
export default function serializeSeed(algorithm: HashAlgorithm, seed?: HashSeed): string {
  if (seed === undefined || seed === 0 || seed === 0n) return '0';
  if (typeof seed !== 'number' && typeof seed !== 'bigint') {
    throw new TypeError('Expected a number or bigint seed');
  }
  if (typeof seed === 'number' && !Number.isSafeInteger(seed)) {
    throw new RangeError('Seed must be a safe integer; use bigint for larger seeds');
  }
  const value = BigInt(seed);
  const maximum = algorithm === 'xxh32' ? MAX_UINT32 : MAX_UINT64;
  if (value < 0n || value > maximum) {
    throw new RangeError(`Seed must be an unsigned ${algorithm === 'xxh32' ? 32 : 64}-bit integer`);
  }
  return value.toString();
}
