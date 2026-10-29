import type * as NitroModule from 'react-native-nitro-modules';

import type * as NativeLoaderModule from '../native/NativeNitroFileHashLoader';
import type { FileHasher } from './specs/FileHasher.nitro';

let hasher: FileHasher | undefined;

export default function getFileHasher(): FileHasher {
  if (!hasher) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Importing the public functions must not initialize Nitro.
    const { NitroModules } = require('react-native-nitro-modules') as typeof NitroModule;
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Load Android registration only on the first real hash call.
    const loader = require('../native/NativeNitroFileHashLoader') as typeof NativeLoaderModule;
    loader.default();
    hasher = NitroModules.createHybridObject<FileHasher>('FileHasher');
  }
  return hasher;
}
