import type { HashInput, HashStreamSource } from '../index';
import {
  createHasher,
  hashStream,
  xxh32,
  xxh64,
  xxh3_64,
  xxh3_128,
  xxh32File,
  xxh64File,
  xxh3_64File,
  xxh3_128File,
} from '../index';

interface FixtureIO {
  write: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

/** Real host integration for the new lifecycle and result-format contracts. */
export default async function runStreamRuntimeTests(io: FixtureIO): Promise<number> {
  let checks = 0;
  const equal = (actual: unknown, expected: unknown, label: string): void => {
    if (actual !== expected) throw new Error(`${label}: ${String(actual)} !== ${String(expected)}`);
    checks += 1;
  };
  const hex = (bytes: Uint8Array): string =>
    Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  const bytes = new Uint8Array(131073);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 131 + 17) % 256;
  const uri = await io.write('streams-and-formats.bin', bytes);
  const methods = [
    ['xxh32', xxh32, xxh32File],
    ['xxh64', xxh64, xxh64File],
    ['xxh3-64', xxh3_64, xxh3_64File],
    ['xxh3-128', xxh3_128, xxh3_128File],
  ] as const;
  const chunks: HashInput[] = [
    bytes.subarray(0, 17),
    new DataView(bytes.buffer, 17, 65536),
    bytes.subarray(65553),
  ];
  const source: AsyncIterable<HashInput> = {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Promise.resolve(chunk);
    },
  };
  for (const [algorithm, hash, file] of methods) {
    const seed = algorithm === 'xxh32' ? 0xffffffffn : 0xffffffffffffffffn;
    const expected = hash(bytes, seed);
    equal(hex(hash(bytes, { seed, output: 'bytes' })), expected, `one-shot bytes/${algorithm}`);
    equal(
      hash(bytes, { seed, output: 'bigint' }),
      BigInt(`0x${expected}`),
      `one-shot bigint/${algorithm}`,
    );
    const stream = createHasher(algorithm, seed).update(bytes.subarray(0, 17));
    const clone = stream.clone();
    try {
      stream.update(bytes.subarray(17));
      clone.update(bytes.subarray(17));
      equal(stream.digest(), expected, `original clone/${algorithm}`);
      equal(hex(clone.digest('bytes')), expected, `clone bytes/${algorithm}`);
      equal(clone.digest('bigint'), BigInt(`0x${expected}`), `clone bigint/${algorithm}`);
      stream.dispose();
      clone.reset().update(bytes);
      equal(clone.digest(), expected, `clone lifetime and seed/${algorithm}`);
    } finally {
      stream.dispose();
      clone.dispose();
    }
    equal(await hashStream(source, { algorithm, seed }), expected, `AsyncIterable/${algorithm}`);
    equal(
      hex(await hashStream(source, { algorithm, seed, output: 'bytes' })),
      expected,
      `AsyncIterable bytes/${algorithm}`,
    );
    let releases = 0;
    const readable: HashStreamSource = {
      getReader() {
        let index = 0;
        return {
          read: () =>
            Promise.resolve(
              index < chunks.length ? { done: false, value: chunks[index++] } : { done: true },
            ),
          cancel() {
            throw new Error('Completed source must not be cancelled');
          },
          releaseLock() {
            releases += 1;
          },
        };
      },
    };
    equal(
      await hashStream(readable, { algorithm, seed, output: 'bigint' }),
      BigInt(`0x${expected}`),
      `ReadableStream bigint/${algorithm}`,
    );
    equal(releases, 1, `reader release/${algorithm}`);
    equal(hex(await file(uri, { seed, output: 'bytes' })), expected, `file bytes/${algorithm}`);
    const controller = new AbortController();
    equal(
      await file(uri, { seed, output: 'bigint', signal: controller.signal }),
      BigInt(`0x${expected}`),
      `file task success/${algorithm}`,
    );
    const abort = new AbortController();
    const pending = file(uri, { signal: abort.signal });
    abort.abort('runtime cancellation');
    let name: unknown;
    try {
      await pending;
    } catch (error) {
      name = (error as Error).name;
    }
    equal(name, 'AbortError', `file task cancellation/${algorithm}`);
  }
  return checks;
}
