package com.margelo.nitro.filehash;

import androidx.annotation.Nullable;
import com.facebook.react.BaseReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.module.model.ReactModuleInfo;
import com.facebook.react.module.model.ReactModuleInfoProvider;
import java.util.HashMap;
import java.util.Map;

public final class NitroFileHashPackage extends BaseReactPackage {
  @Nullable
  @Override
  public NativeModule getModule(String name, ReactApplicationContext reactContext) {
    if (NitroFileHashLoaderModule.NAME.equals(name)) {
      return new NitroFileHashLoaderModule(reactContext);
    }
    return null;
  }

  @Override
  public ReactModuleInfoProvider getReactModuleInfoProvider() {
    return () -> {
      Map<String, ReactModuleInfo> modules = new HashMap<>();
      modules.put(NitroFileHashLoaderModule.NAME,
                  new ReactModuleInfo(NitroFileHashLoaderModule.NAME, NitroFileHashLoaderModule.class.getName(), false,
                                      false, false, true));
      return modules;
    };
  }
}
