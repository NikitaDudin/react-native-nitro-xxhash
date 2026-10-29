import type { HashAlgorithm } from './HashAlgorithm';
import type { HashInput } from './HashInput';
import type { HashOutput, HashResult } from './HashOutput';
import type { HashSeed } from './HashSeed';
import type { HashStream } from './HashStream';
import convertHashOutput, { validateHashOutput } from './convertHashOutput';
import normalizeHashInput from './normalizeHashInput';
import serializeSeed from './serializeSeed';
import type { HashState } from './specs/HashState.nitro';

export default class NativeHashStream implements HashStream {
  readonly algorithm: HashAlgorithm;
  private state: HashState | undefined;
  private seed: string;

  constructor(algorithm: HashAlgorithm, seed: string, state: HashState) {
    this.algorithm = algorithm;
    this.seed = seed;
    this.state = state;
  }

  private getState(): HashState {
    if (!this.state) throw new Error('Hash stream has been disposed');
    return this.state;
  }

  update(input: HashInput): this {
    const state = this.getState();
    const normalized = normalizeHashInput(input);
    if (typeof normalized === 'string') state.updateString(normalized);
    else state.updateBuffer(normalized.buffer, normalized.byteOffset, normalized.byteLength);
    return this;
  }

  digest(output?: 'hex'): string;
  digest<T extends HashOutput>(output: T): HashResult<T>;
  digest<T extends HashOutput>(output?: T): HashResult<T | 'hex'>;
  digest(output: HashOutput = 'hex'): HashResult<HashOutput> {
    const state = this.getState();
    validateHashOutput(output);
    return convertHashOutput(state.digest(), output);
  }

  clone(): HashStream {
    return new NativeHashStream(this.algorithm, this.seed, this.getState().clone());
  }

  reset(seed?: HashSeed): this {
    const state = this.getState();
    let serialized = this.seed;
    if (seed !== undefined) serialized = serializeSeed(this.algorithm, seed);
    state.reset(serialized);
    this.seed = serialized;
    return this;
  }

  dispose(): void {
    if (this.state) {
      this.state.dispose();
      this.state = undefined;
    }
  }
}
