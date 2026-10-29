import type { TurboModule } from 'react-native';
import { Platform, TurboModuleRegistry } from 'react-native';

export interface Spec extends TurboModule {
  load: () => boolean;
}

function loadNativeLibrary(): void {
  if (Platform.OS === 'android') {
    const loader = TurboModuleRegistry.getEnforcing<Spec>('NativeXXHashLoader');
    loader.load();
  }
}

export default loadNativeLibrary;
