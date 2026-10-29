import type { HashAlgorithm } from './HashAlgorithm';
import type { FileHashOptions, HashOptions } from './HashOptions';
import type { HashOutput } from './HashOutput';
import type { HashSeed } from './HashSeed';
import { validateHashOutput } from './convertHashOutput';
import serializeSeed from './serializeSeed';

interface ParsedHashOptions {
  readonly seed: string;
  readonly output: HashOutput;
  readonly signal?: AbortSignal;
}

const DEFAULT_OPTIONS: ParsedHashOptions = Object.freeze({
  seed: '0',
  output: 'hex',
  signal: undefined,
});

/** Snapshot and validate options before native loading or borrowing input bytes. */
export default function parseHashOptions(
  value: HashSeed | HashOptions<HashOutput> | FileHashOptions<HashOutput> | undefined,
  algorithm: HashAlgorithm,
  configuration?: { allowSignal?: boolean },
): ParsedHashOptions {
  if (value === undefined) return DEFAULT_OPTIONS;
  const allowSignal = configuration?.allowSignal ?? false;
  let seed: HashSeed | undefined;
  let output: HashOutput = 'hex';
  let signal: AbortSignal | undefined;
  if (typeof value === 'number' || typeof value === 'bigint') {
    seed = value;
  } else {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new TypeError('Expected a seed or hash options object');
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
      throw new TypeError('Expected a seed or hash options object');
    }
    for (const key of Reflect.ownKeys(value)) {
      if (key !== 'seed' && key !== 'output' && !(allowSignal && key === 'signal')) {
        throw new TypeError(`Unknown hash option: ${String(key)}`);
      }
    }
    seed = value.seed;
    const requested = value.output;
    if (requested !== undefined) {
      validateHashOutput(requested);
      output = requested;
    }
    if (allowSignal) {
      signal = (value as FileHashOptions<HashOutput>).signal;
      // RN's AbortSignal polyfill is not necessarily an instance of the host's
      // global class. Validate its event contract instead of using instanceof.
      if (
        signal !== undefined &&
        (typeof signal !== 'object' ||
          signal === null ||
          typeof signal.aborted !== 'boolean' ||
          typeof signal.addEventListener !== 'function' ||
          typeof signal.removeEventListener !== 'function')
      ) {
        throw new TypeError('Expected an AbortSignal');
      }
    }
  }
  return { seed: serializeSeed(algorithm, seed), output, signal };
}
