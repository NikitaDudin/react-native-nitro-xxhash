package com.margelo.nitro.xxhash;

import androidx.annotation.NonNull;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.annotations.ReactModule;

@ReactModule(name = XXHashLoaderModule.NAME)
public final class XXHashLoaderModule extends NativeXXHashLoaderSpec {
  public static final String NAME = "NativeXXHashLoader";
  private static boolean didLoad = false;

  public XXHashLoaderModule(ReactApplicationContext reactContext) { super(reactContext); }

  @NonNull
  @Override
  public String getName() {
    return NAME;
  }

  @Override
  public boolean load() {
    // Share the load lock across React contexts; Nitro registration belongs to the process.
    synchronized (XXHashLoaderModule.class) {
      if (!didLoad) {
        System.loadLibrary("xxHash");
        didLoad = true;
      }
      return true;
    }
  }
}
