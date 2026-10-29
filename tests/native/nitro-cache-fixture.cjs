const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runCompatibility } = require('../../compat/apply.cjs');
const definitions = require('../../compat/patches.json');

/**
 * Prepare real patched Nitro headers with test-only cache observation hooks.
 * The caller owns this disposable directory and must clean it after compilation.
 * Returns the copied cpp root for compiler include directories/header mapping.
 */
function createNitroCacheFixture(directory, sourceDirectory) {
  const installed =
    sourceDirectory ?? path.dirname(require.resolve('react-native-nitro-modules/package.json'));
  // Linked/workspace SDKs may contain source symlinks. Own their contents before
  // restoring or instrumenting files so fixture writes cannot reach the SDK.
  fs.cpSync(path.join(installed, 'cpp'), path.join(directory, 'cpp'), {
    recursive: true,
    dereference: true,
  });
  fs.mkdirSync(path.join(directory, 'ios/utils'), { recursive: true });
  for (const relativePath of new Set(definitions.targets.map((target) => target.path))) {
    const targetPath = path.join(directory, relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    let original = fs.readFileSync(path.join(installed, relativePath), 'utf8');
    const targets = definitions.targets.filter((target) => target.path === relativePath);
    for (const target of targets)
      original = original.replace(target.patched, () => target.original);
    for (const target of targets)
      assert(original.includes(target.original), `Unknown installed source for ${relativePath}`);
    fs.writeFileSync(targetPath, original);
  }
  fs.copyFileSync(path.join(installed, 'package.json'), path.join(directory, 'package.json'));
  assert.equal(runCompatibility({ nitroPath: directory }).status, 'applied');
  assert.equal(runCompatibility({ nitroPath: directory, check: true }).status, 'already-fixed');

  // Only the disposable copy gets observation hooks. They add no instance fields
  // and do not alter reference ownership or the production pruning algorithm.
  const cachePath = path.join(directory, 'cpp/jsi/JSICache.hpp');
  let cache = fs.readFileSync(cachePath, 'utf8');
  cache = cache.replace(
    'class JSICacheReference final {\npublic:',
    'class JSICacheReference final {\npublic:\n' +
      '  template <typename T> static void cacheProbeRetain(std::vector<WeakReference<T>>& entries, const BorrowingReference<T>& owner) { retain(entries, owner); }\n',
  );
  fs.writeFileSync(cachePath, cache);
  const weakPath = path.join(directory, 'cpp/utils/WeakReference.hpp');
  let weak = fs.readFileSync(weakPath, 'utf8');
  weak = weak.replace(
    'namespace margelo::nitro {',
    'namespace margelo::nitro {\ninline std::atomic_size_t cacheProbeExpiredChecks{0};',
  );
  weak = weak.replace(
    'bool expired() const noexcept {',
    'bool expired() const noexcept {\n    ++cacheProbeExpiredChecks;',
  );
  fs.writeFileSync(weakPath, weak);
  const statePath = path.join(directory, 'cpp/utils/ReferenceState.hpp');
  let state = fs.readFileSync(statePath, 'utf8');
  state = state.replace(
    'struct ReferenceState {',
    'inline std::atomic_size_t cacheProbeLiveStates{0};\nstruct ReferenceState {',
  );
  state = state.replace(
    'explicit ReferenceState() : strongRefCount(1), weakRefCount(1), isDeleted(false) {}',
    'explicit ReferenceState() : strongRefCount(1), weakRefCount(1), isDeleted(false) { ++cacheProbeLiveStates; }\n  ~ReferenceState() { --cacheProbeLiveStates; }',
  );
  fs.writeFileSync(statePath, state);
  return path.join(directory, 'cpp');
}

module.exports = { createNitroCacheFixture };

/** Add read-only registry counts to the same disposable real SDK fixture. */
function createNitroRuntimeRegistryFixture(directory, sourceDirectory) {
  const cpp = createNitroCacheFixture(directory, sourceDirectory);
  for (const [relative, registry, probe] of [
    ['jsi/JSICache.cpp', 'jsiCacheRegistry', 'cacheProbeJSIRuntimeEntries'],
    ['utils/PropNameIDCache.cpp', 'propNameRegistry', 'cacheProbePropRuntimeEntries'],
    ['utils/CommonGlobals.cpp', 'globalFunctionRegistry', 'cacheProbeGlobalRuntimeEntries'],
    ['threading/Dispatcher.cpp', 'dispatcherRegistry', 'cacheProbeDispatcherRuntimeEntries'],
    [
      'prototype/HybridObjectPrototype.cpp',
      'prototypeRegistry',
      'cacheProbePrototypeRuntimeEntries',
    ],
  ]) {
    const file = path.join(cpp, relative);
    const source = fs.readFileSync(file, 'utf8');
    const end = source.lastIndexOf('\n}');
    assert(end >= 0 && source.includes(`${registry}Existing`), relative);
    const observer = `
std::size_t ${probe}() {
  auto* registry = ${registry}Existing.load();
  if (registry == nullptr) return 0;
  const std::scoped_lock lock(registry->mutex);
  return registry->entries.size();
}
`;
    fs.writeFileSync(file, source.slice(0, end) + observer + source.slice(end));
  }
  return cpp;
}

module.exports.createNitroRuntimeRegistryFixture = createNitroRuntimeRegistryFixture;
