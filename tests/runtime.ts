import { NitroModules } from 'react-native-nitro-modules';

import type { HashInput } from '../index';
import { xxh3_64, xxh3_128, xxh3_64File, xxh3_128File } from '../index';
import getFileHasher from '../src/getFileHasher';
import type { FileHasher } from '../src/specs/FileHasher.nitro';
import vectors from './vectors.json';
import runAlgorithmRuntimeTests from './runtime-algorithms';
import runStreamRuntimeTests from './runtime-streams';

interface FixtureIO {
  directoryUri: string;
  write: (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
}

/** Runs against the real Nitro object, not a Jest/native mock. */
export default async function runRuntimeTests(
  io: FixtureIO,
): Promise<{ checks: number; simdBackend: string }> {
  const firstHash = xxh3_64('');
  const hasher = getFileHasher();
  let checks = 0;
  function equal(actual: unknown, expected: unknown, label: string): void {
    if (actual !== expected)
      throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
    checks += 1;
  }
  async function rejects(operation: () => Promise<string>, label: string): Promise<void> {
    let rejected = false;
    try {
      await operation();
    } catch {
      rejected = true;
    }
    equal(rejected, true, label);
  }
  function bytesFromHex(hex: string): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1)
      bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }
  equal(firstHash, vectors.vectors['0']['64'], 'First public call initializes the native library');
  const invalidInputs = [
    undefined,
    null,
    1,
    true,
    {},
    [],
    Object.create(Uint8Array.prototype),
    new Proxy(new Uint8Array(1), {}),
  ];
  invalidInputs.push(Object.create(ArrayBuffer.prototype), new Proxy(new ArrayBuffer(4), {}), {
    byteLength: 4,
    [Symbol.toStringTag]: 'ArrayBuffer',
  });
  if (typeof SharedArrayBuffer === 'function') {
    const shared = new SharedArrayBuffer(8);
    invalidInputs.push(shared, new Uint8Array(shared), new DataView(shared));
  }
  for (let inputIndex = 0; inputIndex < invalidInputs.length; inputIndex += 1) {
    [xxh3_64, xxh3_128].forEach((hash) => {
      let typeError = false;
      try {
        hash(invalidInputs[inputIndex] as HashInput);
      } catch (error) {
        typeError = error instanceof TypeError;
      }
      equal(typeError, true, `Invalid input/${inputIndex}`);
    });
  }
  const patterns = Object.entries(vectors.vectors);
  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const [size, expected] = patterns[patternIndex];
    const bytes = new Uint8Array(Number(size));
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = (i * 131 + 17) % 256;
    equal(xxh3_64(bytes.buffer), expected['64'], `JS buffer64/${size}`);
    equal(xxh3_128(bytes.buffer), expected['128'], `JS buffer128/${size}`);
    equal(xxh3_64(bytes), expected['64'], `JS Uint8Array64/${size}`);
    equal(xxh3_128(new DataView(bytes.buffer)), expected['128'], `JS DataView128/${size}`);
    const owned = NitroModules.createNativeArrayBuffer(bytes.length);
    new Uint8Array(owned).set(bytes);
    equal(xxh3_64(owned), expected['64'], `Native buffer64/${size}`);
    equal(xxh3_128(owned), expected['128'], `Native buffer128/${size}`);
    const paddedOwned = NitroModules.createNativeArrayBuffer(bytes.length + 2);
    const paddedBytes = new Uint8Array(paddedOwned);
    paddedBytes.fill(255);
    paddedBytes.set(bytes, 1);
    const nativeView = paddedBytes.subarray(1, bytes.length + 1);
    equal(xxh3_64(nativeView), expected['64'], `Native subarray64/${size}`);
    equal(xxh3_128(nativeView), expected['128'], `Native subarray128/${size}`);
    equal(
      xxh3_128(new DataView(paddedOwned, 1, bytes.length)),
      expected['128'],
      `Native DataView128/${size}`,
    );
    const uri = await io.write(`модель % #${size}.bin`, bytes);
    const paths = [
      uri,
      decodeURIComponent(uri.slice('file://'.length)),
      uri.replace('file:///', 'file://localhost/'),
    ];
    for (let pathIndex = 0; pathIndex < paths.length; pathIndex += 1) {
      const path = paths[pathIndex];
      equal(await xxh3_64File(path), expected['64'], `File64/${size}`);
      equal(await xxh3_128File(path), expected['128'], `File128/${size}`);
    }
    equal(xxh3_64(bytes.buffer), expected['64'], `Repeated public call/${size}`);
    // Synchronous hashing must neither mutate nor retain the buffer's contents.
    equal(xxh3_64(bytes.buffer), expected['64'], `Unchanged buffer/${size}`);
  }
  for (let index = 0; index < vectors.strings.length; index += 1) {
    const vector = vectors.strings[index];
    equal(xxh3_64(vector.input), vector['64'], `UTF-8 string64/${index}`);
    equal(xxh3_128(vector.input), vector['128'], `UTF-8 string128/${index}`);
    const bytes = bytesFromHex(vector.utf8);
    equal(xxh3_64(bytes.buffer), vector['64'], `UTF-8 bytes64/${index}`);
    equal(xxh3_128(bytes.buffer), vector['128'], `UTF-8 bytes128/${index}`);
    const uri = await io.write(`string-${index}.bin`, bytes);
    equal(await xxh3_64File(uri), vector['64'], `UTF-8 file64/${index}`);
    equal(await xxh3_128File(uri), vector['128'], `UTF-8 file128/${index}`);
  }
  // Views borrow only their selected range; .buffer still means the whole allocation.
  const backing = bytesFromHex('ff610062ff');
  const view = backing.subarray(1, 4);
  const dataView = new DataView(backing.buffer, 1, 3);
  const nulVector = vectors.strings.find((vector) => vector.input === 'a\0b');
  if (!nulVector) throw new Error('Missing NUL golden vector');
  equal(xxh3_64(view), nulVector['64'], 'Uint8Array range64');
  equal(xxh3_128(view), nulVector['128'], 'Uint8Array range128');
  equal(xxh3_64(dataView), nulVector['64'], 'DataView range64');
  equal(xxh3_128(dataView), nulVector['128'], 'DataView range128');
  equal(xxh3_128(view.buffer) === nulVector['128'], false, 'Whole backing allocation');
  backing[0] = 1;
  backing[4] = 2;
  equal(xxh3_64(view), nulVector['64'], 'Prefix/suffix changes excluded64');
  equal(xxh3_128(dataView), nulVector['128'], 'Prefix/suffix changes excluded128');
  backing[1] = 98;
  const changedVector = vectors.strings.find((vector) => vector.input === 'b\0b');
  if (!changedVector) throw new Error('Missing mutation golden vector');
  equal(xxh3_64(view), changedVector['64'], 'View mutation64');
  equal(xxh3_128(dataView), changedVector['128'], 'View mutation128');
  equal(xxh3_64(backing.subarray(backing.length)), vectors.vectors['0']['64'], 'Empty view64');
  equal(
    xxh3_128(new DataView(backing.buffer, backing.byteLength, 0)),
    vectors.vectors['0']['128'],
    'Empty DataView128',
  );
  const invalid = [
    '',
    'relative.bin',
    'https://example.com/a',
    'content://media/file',
    'file://remote/a',
    'file:///tmp/%',
    'file:///tmp/%GG',
    'file:///tmp/%00',
    'file:///tmp/a?b',
    'file:///tmp/a#b',
    'file:///tmp/a\0b',
    io.directoryUri,
    `${io.directoryUri}/missing`,
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    const uri = invalid[index];
    await rejects(async () => xxh3_64File(uri), `Invalid file64/${JSON.stringify(uri)}`);
    await rejects(async () => xxh3_128File(uri), `Invalid file128/${JSON.stringify(uri)}`);
  }
  const fixture = vectors.strings[2];
  const uri = await io.write('concurrent.bin', bytesFromHex(fixture.utf8));
  const pending = Array.from({ length: 16 }, async (_, index) => {
    if (index % 2 === 0) return xxh3_64File(uri);
    return xxh3_128File(uri);
  });
  const actual = await Promise.all(pending);
  actual.forEach((digest, index) => {
    const expected = fixture[index % 2 === 0 ? '64' : '128'];
    equal(digest, expected, `Concurrent file/${index}`);
  });
  const disposable = NitroModules.createHybridObject<FileHasher>('FileHasher');
  const afterDispose = disposable.hashFile(uri, 'xxh3-64', '0');
  disposable.dispose();
  equal(await afterDispose, fixture['64'], 'In-flight file survives object disposal');
  checks += await runAlgorithmRuntimeTests(io);
  checks += await runStreamRuntimeTests(io);
  return { checks, simdBackend: hasher.simdBackend };
}
