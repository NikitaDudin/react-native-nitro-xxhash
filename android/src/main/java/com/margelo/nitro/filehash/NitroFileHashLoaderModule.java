package com.margelo.nitro.filehash;

import androidx.annotation.NonNull;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.annotations.ReactModule;

@ReactModule(name = NitroFileHashLoaderModule.NAME)
public final class NitroFileHashLoaderModule extends NativeNitroFileHashLoaderSpec {
  public static final String NAME = "NativeNitroFileHashLoader";
  private static boolean didLoad = false;

  public NitroFileHashLoaderModule(ReactApplicationContext reactContext) { super(reactContext); }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public boolean load() {
    // Share the load lock across React contexts; Nitro registration belongs to the process.
    synchronized (NitroFileHashLoaderModule.class) {
      if (!didLoad) {
        System.loadLibrary("NitroFileHash");
        didLoad = true;
      }
      return true;
    }
  }
}
