const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const {
  ROOT,
  findExecutable,
  run,
  withTemporaryDirectory,
} = require('../scripts/native-test-utils.cjs');

test('real Java loader stays lazy, retries failures and synchronizes concurrent contexts', (t) => {
  const javac = findExecutable('javac');
  const java = findExecutable('java');
  const compiler = findExecutable('clang');
  if (!javac || !java || !compiler) {
    t.skip('Requires a JDK and clang');
    return;
  }
  if (!['darwin', 'linux'].includes(process.platform)) {
    t.skip('Host JNI fixture supports macOS and Linux');
    return;
  }
  withTemporaryDirectory('nitro-xxhash-loader-', (directory) => {
    const sources = {
      'androidx/annotation/NonNull.java':
        'package androidx.annotation;\npublic @interface NonNull {}',
      'com/facebook/react/bridge/ReactApplicationContext.java':
        'package com.facebook.react.bridge;\npublic class ReactApplicationContext {}',
      'com/facebook/react/module/annotations/ReactModule.java':
        'package com.facebook.react.module.annotations;\npublic @interface ReactModule { String name(); }',
      'com/margelo/nitro/filehash/NativeNitroFileHashLoaderSpec.java': `package com.margelo.nitro.filehash;
import com.facebook.react.bridge.ReactApplicationContext;
public abstract class NativeNitroFileHashLoaderSpec {
  public NativeNitroFileHashLoaderSpec(ReactApplicationContext context) {}
  public abstract String getName();
  public abstract boolean load();
}`,
      'LoaderContract.java': String.raw`import com.facebook.react.bridge.ReactApplicationContext;
import com.margelo.nitro.filehash.NitroFileHashLoaderModule;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

public class LoaderContract {
  public static void main(String[] compilerCommand) throws Exception {
    Field didLoad = NitroFileHashLoaderModule.class.getDeclaredField("didLoad");
    didLoad.setAccessible(true);
    Path log = Path.of(System.getenv("NITRO_XXHASH_LOADER_LOG"));
    if (didLoad.getBoolean(null) || Files.exists(log)) {
      throw new AssertionError("Class initialization loaded the native library");
    }
    NitroFileHashLoaderModule module = new NitroFileHashLoaderModule(new ReactApplicationContext());
    if (!module.getName().equals("NativeNitroFileHashLoader")) {
      throw new AssertionError("Unexpected TurboModule name");
    }
    try {
      module.load();
      throw new AssertionError("Missing native library did not reject");
    } catch (UnsatisfiedLinkError expected) {
      if (didLoad.getBoolean(null)) throw new AssertionError("Failed load was cached");
    }
    Process compiler = new ProcessBuilder(compilerCommand).inheritIO().start();
    if (compiler.waitFor() != 0) throw new AssertionError("JNI fixture compilation failed");
    ExecutorService workers = Executors.newFixedThreadPool(8);
    try {
      List<Callable<Boolean>> calls = new ArrayList<>();
      for (int i = 0; i < 64; i++) {
        calls.add(() -> new NitroFileHashLoaderModule(new ReactApplicationContext()).load());
      }
      for (Future<Boolean> result : workers.invokeAll(calls)) {
        if (!result.get()) throw new AssertionError("Successful load returned false");
      }
    } finally {
      workers.shutdownNow();
    }
    if (!didLoad.getBoolean(null)) throw new AssertionError("Successful load was not cached");
    if (!module.load()) throw new AssertionError("Repeated load failed");
    if (!Files.readString(log).equals("loaded\n")) {
      throw new AssertionError("Native library initialized more than once");
    }
    System.out.println("Java loader: lazy import, failure recovery, 64 concurrent contexts, reuse passed");
  }
}`,
    };
    const javaSources = [];
    for (const [relative, content] of Object.entries(sources)) {
      const source = path.join(directory, relative);
      fs.mkdirSync(path.dirname(source), { recursive: true });
      fs.writeFileSync(source, content);
      javaSources.push(source);
    }
    const loader = path.join(
      ROOT,
      'android/src/main/java/com/margelo/nitro/filehash/NitroFileHashLoaderModule.java',
    );
    const classes = path.join(directory, 'classes');
    run(javac, ['-d', classes, ...javaSources, loader], { stdio: 'inherit' });
    const settings = run(java, ['-XshowSettings:properties', '-version']).stderr;
    const javaHome = settings.match(/^\s*java\.home\s*=\s*(.+)$/m)?.[1].trim();
    assert(javaHome, 'Cannot determine java.home from the selected JDK');
    const native = path.join(directory, 'loader.c');
    fs.writeFileSync(
      native,
      String.raw`#include <jni.h>
#include <stdio.h>
#include <stdlib.h>
JNIEXPORT jint JNICALL JNI_OnLoad(JavaVM* vm, void* reserved) {
  (void)vm;
  (void)reserved;
  FILE* log = fopen(getenv("NITRO_XXHASH_LOADER_LOG"), "a");
  if (!log) return JNI_ERR;
  fputs("loaded\n", log);
  fclose(log);
  return JNI_VERSION_1_6;
}
`,
    );
    const host = process.platform === 'darwin' ? 'darwin' : 'linux';
    const library = path.join(
      directory,
      host === 'darwin' ? 'libNitroFileHash.dylib' : 'libNitroFileHash.so',
    );
    const command = [
      compiler,
      '-shared',
      '-fPIC',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-I',
      path.join(javaHome, 'include'),
      '-I',
      path.join(javaHome, 'include', host),
      native,
      '-o',
      library,
    ];
    run(java, [`-Djava.library.path=${directory}`, '-cp', classes, 'LoaderContract', ...command], {
      stdio: 'inherit',
      env: { ...process.env, NITRO_XXHASH_LOADER_LOG: path.join(directory, 'loaded.log') },
    });
  });
});
