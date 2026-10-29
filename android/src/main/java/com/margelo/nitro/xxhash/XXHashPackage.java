package com.margelo.nitro.xxhash;

import androidx.annotation.Nullable;
import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import java.util.HashMap;
import java.util.Map;

public final class XXHashPackage extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    if (XXHashLoaderModule.NAME.equals(name)) {
      return new XXHashLoaderModule(reactContext);
    }
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return () -> {
      Map<String, ReactModuleInfo> modules = new HashMap<>();
      modules.put(
          XXHashLoaderModule.NAME,
          new ReactModuleInfo(XXHashLoaderModule.NAME, XXHashLoaderModule.class.getName(), false, false, false, true));
      return modules;
    };
  }
}
