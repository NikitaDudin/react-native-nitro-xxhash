import type { HashOutput, HashResult } from './HashOutput';

export function validateHashOutput(output: unknown): asserts output is HashOutput {
  if (output !== 'hex' && output !== 'bytes' && output !== 'bigint') {
    throw new TypeError('Expected hash output to be hex, bytes or bigint');
  }
}

/** Convert the canonical native digest without rounding through a JS number. */
export default function convertHashOutput<T extends HashOutput>(
  hex: string,
  output: T,
): HashResult<T> {
  if (output === 'hex') return hex as HashResult<T>;
  if (output === 'bigint') return BigInt(`0x${hex}`) as HashResult<T>;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes as HashResult<T>;
}
