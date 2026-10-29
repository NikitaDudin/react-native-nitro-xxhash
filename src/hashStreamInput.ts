import type { HashAlgorithm } from './HashAlgorithm';
import type { HashInput } from './HashInput';
import type { HashOutput, HashResult } from './HashOutput';
import type { HashStream } from './HashStream';
import type { HashStreamOptions } from './HashStreamOptions';
import type { HashStreamSource } from './HashStreamSource';
import HashStreamAbort from './HashStreamAbort';
import convertHashOutput from './convertHashOutput';
import createHasher from './createHasher';
import createHashSource from './createHashSource';
import type { HashSource } from './createHashSource';
import parseHashOptions from './parseHashOptions';
import validateAlgorithm from './validateAlgorithm';

function parseOptions(options: HashStreamOptions<HashOutput> | undefined) {
  if (options === undefined) {
    return { algorithm: 'xxh3-128' as const, ...parseHashOptions(undefined, 'xxh3-128') };
  }
  if (typeof options !== 'object' || options === null || Array.isArray(options))
    throw new TypeError('Expected hash stream options');
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null)
    throw new TypeError('Expected hash stream options');
  for (const key of Reflect.ownKeys(options)) {
    if (key !== 'algorithm' && key !== 'seed' && key !== 'output' && key !== 'signal')
      throw new TypeError(`Unknown hash stream option: ${String(key)}`);
  }
  const requested = options.algorithm;
  const algorithm: HashAlgorithm = requested === undefined ? 'xxh3-128' : requested;
  validateAlgorithm(algorithm);
  const parsed = parseHashOptions(
    { seed: options.seed, output: options.output, signal: options.signal },
    algorithm,
    { allowSignal: true },
  );
  return { algorithm, ...parsed };
}

export default function hashStream<T extends HashOutput>(
  source: HashStreamSource,
  options: HashStreamOptions<T> & { output: T },
): Promise<HashResult<T>>;
export default function hashStream(
  source: HashStreamSource,
  options?: HashStreamOptions<'hex'>,
): Promise<string>;
export default function hashStream<T extends HashOutput>(
  source: HashStreamSource,
  options?: HashStreamOptions<T>,
): Promise<HashResult<T | 'hex'>>;
/** Consume one chunk at a time and release native/source ownership on every exit. */
export default async function hashStream(
  source: HashStreamSource,
  options?: HashStreamOptions<HashOutput>,
): Promise<HashResult<HashOutput>> {
  const parsed = parseOptions(options);
  const abort = new HashStreamAbort(parsed.signal);
  let input: HashSource | undefined;
  let sourceDone = false;
  let hasher: HashStream | undefined;
  let failed = false;
  let failure: unknown;
  let output: HashResult<HashOutput>;
  let cleanupFailure: unknown;
  let cleanupFailed = false;
  try {
    input = createHashSource(source);
    input.validate();
    abort.throwIfAborted();
    hasher = createHasher(parsed.algorithm, BigInt(parsed.seed));
    abort.throwIfAborted();
    while (true) {
      const { value: step } = await abort.wait(() => input!.next(), input.settled);
      abort.throwIfAborted();
      if (step === null || (typeof step !== 'object' && typeof step !== 'function'))
        throw new TypeError('Expected an iterator result object');
      const result = step as IteratorResult<HashInput>;
      const done = result.done;
      // Once EOF is observed, later hash/abort failures must not close it again.
      if (done) sourceDone = true;
      abort.throwIfAborted();
      if (done) break;
      const chunk = result.value;
      abort.throwIfAborted();
      hasher.update(chunk);
      abort.throwIfAborted();
    }
    abort.throwIfAborted();
    const digest = hasher.digest();
    abort.throwIfAborted();
    output = convertHashOutput(digest, parsed.output);
    abort.throwIfAborted();
  } catch (error) {
    failed = true;
    failure = error;
    throw error;
  } finally {
    const cleanup = (operation: () => void): void => {
      try {
        operation();
      } catch (error) {
        if (!cleanupFailed) cleanupFailure = error;
        cleanupFailed = true;
      }
    };
    cleanup(() => abort.dispose());
    if (input) {
      if (failed && !sourceDone) cleanup(() => input!.close(failure));
      cleanup(() => input!.release());
    }
    if (hasher) cleanup(() => hasher!.dispose());
  }
  if (cleanupFailed) throw cleanupFailure;
  return output;
}
