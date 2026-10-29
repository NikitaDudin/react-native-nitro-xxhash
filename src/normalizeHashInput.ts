interface BufferRange {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

function intrinsicGetter<Result>(prototype: object, name: string): (this: unknown) => Result {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, name) as {
    get: (this: unknown) => Result;
  };
  return descriptor.get;
}

const isView = ArrayBuffer.isView.bind(ArrayBuffer);
const getBufferLength = intrinsicGetter<number>(ArrayBuffer.prototype, 'byteLength');
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as {
  values: (this: unknown) => unknown;
};
const getTypedBuffer = intrinsicGetter<unknown>(typedArrayPrototype, 'buffer');
const getTypedOffset = intrinsicGetter<number>(typedArrayPrototype, 'byteOffset');
const getTypedLength = intrinsicGetter<number>(typedArrayPrototype, 'byteLength');
const createTypedIterator = typedArrayPrototype.values;
const getDataBuffer = intrinsicGetter<unknown>(DataView.prototype, 'buffer');
const getDataOffset = intrinsicGetter<number>(DataView.prototype, 'byteOffset');
const getDataLength = intrinsicGetter<number>(DataView.prototype, 'byteLength');
const ByteView = Uint8Array;

/** Read native metadata without user getters, byte copies or retaining the input. */
export default function normalizeHashInput(input: unknown): string | BufferRange {
  if (typeof input === 'string') return input;
  try {
    let buffer = input;
    let byteOffset = 0;
    let byteLength: number;
    if (isView(input)) {
      try {
        buffer = getTypedBuffer.call(input);
        byteOffset = getTypedOffset.call(input);
        byteLength = getTypedLength.call(input);
        // The getters report zero for an out-of-bounds resizable view. Creating
        // an intrinsic iterator validates it without reading or copying elements.
        createTypedIterator.call(input);
      } catch {
        buffer = getDataBuffer.call(input);
        byteOffset = getDataOffset.call(input);
        byteLength = getDataLength.call(input);
      }
      // The ArrayBuffer intrinsic also rejects views backed by SharedArrayBuffer.
      getBufferLength.call(buffer);
    } else {
      byteLength = getBufferLength.call(buffer);
    }
    const arrayBuffer = buffer as ArrayBuffer;
    // Detached ArrayBuffers report zero byteLength. An empty borrowed view detects
    // detachment without allocating or copying any bytes, including for empty input.
    new ByteView(arrayBuffer, 0, 0);
    return { buffer: arrayBuffer, byteOffset, byteLength };
  } catch {
    throw new TypeError('Expected a string, ArrayBuffer or ArrayBuffer-backed view');
  }
}
