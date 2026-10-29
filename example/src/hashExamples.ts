import { Directory, File, Paths } from 'expo-file-system';
import { createHasher, xxh3_64, xxh3_64File } from 'react-native-nitro-xxhash';

export type HashExampleId = 'string' | 'view' | 'file' | 'incremental';

export interface HashExampleResult {
  digest: string;
  detail: string;
  expected: string | null;
}

export const HASH_EXAMPLES: readonly {
  id: HashExampleId;
  title: string;
  description: string;
}[] = [
  {
    id: 'string',
    title: 'Hash string',
    description: 'Hash the input as UTF-8 with XXH3-64.',
  },
  {
    id: 'view',
    title: 'Hash TypedArray',
    description: 'Hash five bytes at a nonzero offset, excluding surrounding bytes.',
  },
  {
    id: 'file',
    title: 'Hash local file',
    description: 'Write a temporary file, hash its URI, then remove the owned fixture.',
  },
  {
    id: 'incremental',
    title: 'Hash incrementally',
    description: 'Update one hasher with a string and byte view, then dispose it.',
  },
];

// Canonical upstream XXH3_64bits("hello", 5), seed zero.
const HELLO_DIGEST = '9555e8555c62dcfd';
let fileSequence = 0;

function result(
  digest: string,
  detail: string,
  expected: string | null = HELLO_DIGEST,
): HashExampleResult {
  if (expected !== null && digest !== expected)
    throw new Error(`Unexpected XXH3-64 digest: expected ${expected}, received ${digest}.`);
  return { digest, detail, expected };
}

async function hashLocalFile(): Promise<HashExampleResult> {
  fileSequence += 1;
  const directory = new Directory(
    Paths.cache,
    `nitro-xxhash-example-${Date.now()}-${fileSequence}`,
  );
  // Create before entering the cleanup scope: a collision must not delete an existing directory.
  directory.create();
  try {
    const file = new File(directory, 'hello.txt');
    file.create();
    await file.write('hello');
    const digest = await xxh3_64File(file.uri);
    return result(digest, 'Five UTF-8 bytes from a local file; the temporary fixture is removed.');
  } finally {
    if (directory.exists) directory.delete();
  }
}

function hashIncrementally(): HashExampleResult {
  const storage = new Uint8Array([0xa5, 0x5a, 0x6c, 0x6c, 0x6f, 0xff]);
  const view = new Uint8Array(storage.buffer, 2, 3);
  const hasher = createHasher('xxh3-64');
  try {
    hasher.update('he').update(view);
    return result(hasher.digest(), 'update("he") + update(view of "llo"); state is disposed.');
  } finally {
    hasher.dispose();
  }
}

export async function runHashExample(
  id: HashExampleId,
  text = 'hello',
): Promise<HashExampleResult> {
  switch (id) {
    case 'string':
      return result(
        xxh3_64(text),
        `UTF-8 text: ${JSON.stringify(text)}`,
        text === 'hello' ? HELLO_DIGEST : null,
      );
    case 'view': {
      const storage = new Uint8Array([0xa5, 0x5a, 0x68, 0x65, 0x6c, 0x6c, 0x6f, 0xff]);
      const view = new Uint8Array(storage.buffer, 2, 5);
      return result(
        xxh3_64(view),
        `The original buffer is borrowed at byteOffset ${view.byteOffset}, byteLength ${view.byteLength}.`,
      );
    }
    case 'file':
      return hashLocalFile();
    case 'incremental':
      return hashIncrementally();
    default:
      throw new Error('Unknown hashing example.');
  }
}
