import type { HashOutput } from './HashOutput';
import type { HashSeed } from './HashSeed';

export interface HashOptions<T extends HashOutput = 'hex'> {
  seed?: HashSeed | undefined;
  output?: T | undefined;
}

export interface FileHashOptions<T extends HashOutput = 'hex'> extends HashOptions<T> {
  signal?: AbortSignal | undefined;
}
