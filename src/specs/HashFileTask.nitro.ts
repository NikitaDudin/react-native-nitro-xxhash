import type { HybridObject } from 'react-native-nitro-modules';

/** Private factory-created background task; holds no JS buffers or callbacks. */
export interface HashFileTask extends HybridObject<{ ios: 'c++'; android: 'c++' }> {
  /** Return the same native completion for this task. */
  result(): Promise<string>;
  /** Request cancellation before opening or between bounded file reads. */
  cancel(): void;
}
