import type { HybridObject } from 'react-native-nitro-modules';

/** Internal, runtime-confined native streaming state; created by FileHasher. */
export interface HashState extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  updateString(input: string): void;
  /** Consume only the selected byte range during this synchronous call. */
  updateBuffer(input: ArrayBuffer, byteOffset: number, byteLength: number): void;
  /** Read without finalizing; subsequent updates remain valid. */
  digest(): string;
  reset(seed: string): void;
  /** Copy the current native state; later updates and disposal are independent. */
  clone(): HashState;
}
