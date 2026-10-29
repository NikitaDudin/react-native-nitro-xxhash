import { NitroModules } from 'react-native-nitro-modules';

import type { HashAlgorithm, HashInput, HashSeed } from '../index';
import {
  createHasher,
  xxh32,
  xxh64,
  xxh3_64,
  xxh3_128,
  xxh32File,
  xxh64File,
  xxh3_64File,
  xxh3_128File,
} from '../index';
import vectors from './algorithm-vectors.json';
import originalVectors from './vectors.json';

interface FixtureIO {
  write: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

interface BinaryViewConstructor {
  new (buffer: ArrayBuffer, byteOffset: number, length: number): ArrayBufferView<ArrayBuffer>;
  readonly BYTES_PER_ELEMENT: number;
  readonly name: string;
}

function availableViewConstructors(): BinaryViewConstructor[] {
  const constructors: BinaryViewConstructor[] = [
    Int8Array,
    Uint8Array,
    Uint8ClampedArray,
    Int16Array,
    Uint16Array,
    Int32Array,
    Uint32Array,
    Float32Array,
    Float64Array,
  ];
  const optional = globalThis as unknown as {
    BigInt64Array?: BinaryViewConstructor;
    BigUint64Array?: BinaryViewConstructor;
    Float16Array?: BinaryViewConstructor;
  };
  for (const Constructor of [
    optional.BigInt64Array,
    optional.BigUint64Array,
    optional.Float16Array,
  ]) {
    if (typeof Constructor === 'function') constructors.push(Constructor);
  }
  return constructors;
}

function paddedRange(
  bytes: Uint8Array<ArrayBuffer>,
  nativeOwned: boolean,
): Uint8Array<ArrayBuffer> {
  const length = bytes.byteLength + 16;
  const buffer = nativeOwned
    ? NitroModules.createNativeArrayBuffer(length)
    : new ArrayBuffer(length);
  const padded = new Uint8Array(buffer);
  padded.fill(0xa5);
  padded.set(bytes, 8);
  return padded.subarray(8, 8 + bytes.byteLength);
}

const methods: Record<
  HashAlgorithm,
  {
    hash: (input: HashInput, seed?: HashSeed) => string;
    file: (uri: string, seed?: HashSeed) => Promise<string>;
  }
> = {
  xxh32: { hash: xxh32, file: xxh32File },
  xxh64: { hash: xxh64, file: xxh64File },
  'xxh3-64': { hash: xxh3_64, file: xxh3_64File },
  'xxh3-128': { hash: xxh3_128, file: xxh3_128File },
};

/** Real Nitro/device checks for all algorithms; the host supplies fixture ownership. */
export default async function runAlgorithmRuntimeTests(io: FixtureIO): Promise<number> {
  let checks = 0;
  function equal(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected)
      throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
    checks += 1;
  }
  const fixtures = new Map<
    string,
    {
      bytes: Uint8Array<ArrayBuffer>;
      range: Uint8Array<ArrayBuffer>;
      nativeRange: Uint8Array<ArrayBuffer>;
      uri: string;
      text?: string;
    }
  >();
  for (const [name] of Object.entries(vectors.vectors.xxh32['0'])) {
    let bytes: Uint8Array<ArrayBuffer>;
    let text: string | undefined;
    if (name.startsWith('string-')) {
      const vector = originalVectors.strings[Number(name.slice('string-'.length))];
      text = vector.input;
      bytes = new Uint8Array(vector.utf8.length / 2);
      for (let i = 0; i < bytes.length; i += 1)
        bytes[i] = Number.parseInt(vector.utf8.slice(i * 2, i * 2 + 2), 16);
    } else {
      bytes = new Uint8Array(Number(name));
      for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 17) % 256;
    }
    fixtures.set(name, {
      bytes,
      range: paddedRange(bytes, false),
      nativeRange: paddedRange(bytes, true),
      text,
      uri: await io.write(`seeded-${name}.bin`, bytes),
    });
  }
  for (const [algorithm, seeds] of Object.entries(vectors.vectors)) {
    const selected = algorithm as HashAlgorithm;
    const { hash, file } = methods[selected];
    for (const [seedString, cases] of Object.entries(seeds)) {
      const seed = BigInt(seedString);
      for (const [name, expected] of Object.entries(cases)) {
        const fixture = fixtures.get(name);
        if (!fixture) throw new Error(`Missing fixture ${name}`);
        const label = `${algorithm}/${seedString}/${name}`;
        equal(hash(fixture.bytes.buffer, seed), expected, `buffer/${label}`);
        equal(hash(fixture.bytes, seed), expected, `Uint8Array/${label}`);
        equal(hash(fixture.range, seed), expected, `subarray excludes sentinels/${label}`);
        equal(
          hash(new DataView(fixture.range.buffer, 8, fixture.bytes.byteLength), seed),
          expected,
          `DataView excludes sentinels/${label}`,
        );
        equal(hash(fixture.nativeRange, seed), expected, `native-owned subarray/${label}`);
        equal(
          hash(new DataView(fixture.nativeRange.buffer, 8, fixture.bytes.byteLength), seed),
          expected,
          `native-owned DataView/${label}`,
        );
        equal(await file(fixture.uri, seed), expected, `file/${label}`);
        if (fixture.text !== undefined)
          equal(hash(fixture.text, seed), expected, `string/${label}`);
        const stream = createHasher(selected, seed);
        try {
          for (let offset = 0; offset < fixture.bytes.length; offset += 127) {
            const end = Math.min(offset + 127, fixture.bytes.length);
            if (offset % 2 === 0) {
              stream.update(fixture.range.subarray(offset, end));
            } else {
              stream.update(new DataView(fixture.nativeRange.buffer, 8 + offset, end - offset));
            }
          }
          equal(stream.digest(), expected, `stream/${label}`);
          equal(stream.digest(), expected, `repeated digest/${label}`);
          stream.reset().update(fixture.nativeRange);
          equal(stream.digest(), expected, `reset preserves seed/${label}`);
          stream.update('');
          equal(stream.digest(), expected, `update after digest/${label}`);
          stream.reset(0);
          equal(stream.digest(), hash('', 0), `reset changes seed/${label}`);
        } finally {
          stream.dispose();
        }
        stream.dispose();
        let disposed = false;
        try {
          stream.digest();
        } catch {
          disposed = true;
        }
        equal(disposed, true, `disposed/${label}`);
      }
      const fixture = fixtures.get('32');
      if (!fixture) throw new Error('Missing typed-view fixture');
      const expected = hash(fixture.bytes.buffer, seed);
      const empty = hash('', seed);
      const viewTypes = availableViewConstructors().map((Constructor) => ({
        name: Constructor.name,
        create: (buffer: ArrayBuffer): ArrayBufferView<ArrayBuffer> =>
          new Constructor(buffer, 8, fixture.bytes.byteLength / Constructor.BYTES_PER_ELEMENT),
      }));
      viewTypes.push({
        name: 'DataView',
        create: (buffer) => new DataView(buffer, 8, fixture.bytes.byteLength),
      });
      for (const viewType of viewTypes) {
        const label = `${algorithm}/${seedString}/${viewType.name}`;
        const jsRange = paddedRange(fixture.bytes, false);
        const nativeRange = paddedRange(fixture.bytes, true);
        const jsView = viewType.create(jsRange.buffer);
        const nativeView = viewType.create(nativeRange.buffer);
        equal(hash(jsView, seed), expected, `raw typed bytes/${label}`);
        equal(hash(nativeView, seed), expected, `raw native-owned typed bytes/${label}`);
        const changed = new Uint8Array(fixture.bytes);
        changed[0] ^= 255;
        const changedExpected = hash(changed.buffer, seed);
        const stream = createHasher(selected, seed);
        try {
          stream.update(jsView);
          jsRange[0] ^= 255;
          equal(hash(jsView, seed), changedExpected, `typed mutation observed/${label}`);
          equal(stream.digest(), expected, `typed update consumes immediately/${label}`);
          stream.reset().update(jsView);
          equal(stream.digest(), changedExpected, `typed mutation after reset/${label}`);
          stream.reset().update(nativeView);
          nativeRange[0] ^= 255;
          equal(hash(nativeView, seed), changedExpected, `native typed mutation/${label}`);
          equal(stream.digest(), expected, `native update consumes immediately/${label}`);
        } finally {
          stream.dispose();
        }
      }
      for (const range of [fixture.range, fixture.nativeRange]) {
        const end = range.buffer.byteLength;
        const emptyViews = [
          new Uint8Array(range.buffer, end, 0),
          new Uint32Array(range.buffer, end, 0),
          new DataView(range.buffer, end, 0),
        ];
        for (const [index, view] of emptyViews.entries()) {
          const label = `${algorithm}/${seedString}/${index}/${range === fixture.nativeRange}`;
          equal(hash(view, seed), empty, `empty view at allocation end/${label}`);
          const stream = createHasher(selected, seed);
          try {
            stream.update(view);
            equal(stream.digest(), empty, `empty stream update/${label}`);
            stream.update(fixture.range).update(view);
            equal(stream.digest(), expected, `empty update preserves bytes/${label}`);
          } finally {
            stream.dispose();
          }
        }
      }
    }
    const input = fixtures.get('65537') ?? fixtures.values().next().value;
    if (!input) throw new Error('Missing concurrency fixture');
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, (_, seed) => file(input.uri, seed)),
    );
    concurrent.forEach((actual, seed) =>
      equal(actual, hash(input.bytes.buffer, seed), `concurrent/${algorithm}/${seed}`),
    );
    const invalidInputs: unknown[] = [
      undefined,
      null,
      1,
      true,
      [],
      {},
      Object.create(ArrayBuffer.prototype),
      Object.create(Uint8Array.prototype),
      new Proxy(new Uint8Array(8), {}),
      new Proxy(new DataView(new ArrayBuffer(8)), {}),
    ];
    if (typeof SharedArrayBuffer === 'function') {
      const shared = new SharedArrayBuffer(8);
      invalidInputs.push(shared, new Uint8Array(shared), new DataView(shared));
    }
    const transfer = (
      globalThis as unknown as {
        structuredClone?: (input: ArrayBuffer, options: { transfer: ArrayBuffer[] }) => unknown;
      }
    ).structuredClone;
    if (typeof transfer === 'function') {
      const detached = new ArrayBuffer(8);
      const typed = new Uint8Array(detached);
      const dataView = new DataView(detached);
      try {
        transfer.call(globalThis, detached, { transfer: [detached] });
      } catch {
        // Some React Native hosts expose cloning without ArrayBuffer transfer support.
      }
      if (detached.byteLength === 0) invalidInputs.push(detached, typed, dataView);
    }
    const stream = createHasher(selected);
    try {
      invalidInputs.forEach((input, index) => {
        let hashTypeError = false;
        try {
          hash(input as HashInput);
        } catch (error) {
          hashTypeError = error instanceof TypeError;
        }
        equal(hashTypeError, true, `invalid hash input/${algorithm}/${index}`);
        let streamTypeError = false;
        try {
          stream.update(input as HashInput);
        } catch (error) {
          streamTypeError = error instanceof TypeError;
        }
        equal(streamTypeError, true, `invalid stream input/${algorithm}/${index}`);
      });
      equal(stream.digest(), hash(''), `rejected updates preserve empty state/${algorithm}`);
    } finally {
      stream.dispose();
    }
  }
  return checks;
}
