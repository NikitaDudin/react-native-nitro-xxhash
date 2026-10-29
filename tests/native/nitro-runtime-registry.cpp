#include "CommonGlobals.hpp"
#include "Dispatcher.hpp"
#include "HybridObjectPrototype.hpp"
#include "JSICache.hpp"
#include "PropNameIDCache.hpp"
#include "ThreadUtils.hpp"

#include <barrier>
#include <hermes/hermes.h>
#include <iostream>
#include <jsi/instrumentation.h>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>

namespace margelo::nitro {
// Only platform dispatch setup is replaced. SDK caches, JSI and Hermes are real.
std::string ThreadUtils::getThreadName() { return "registry-test"; }
bool ThreadUtils::isUIThread() { return false; }
std::shared_ptr<Dispatcher> ThreadUtils::createUIThreadDispatcher() {
  throw std::runtime_error("The fixture must install its own dispatcher");
}
std::size_t cacheProbeJSIRuntimeEntries();
std::size_t cacheProbePropRuntimeEntries();
std::size_t cacheProbeGlobalRuntimeEntries();
std::size_t cacheProbeDispatcherRuntimeEntries();
std::size_t cacheProbePrototypeRuntimeEntries();
void Logger::nativeLog(LogLevel, const char*, const std::string&) {}
} // namespace margelo::nitro

namespace {
using namespace margelo::nitro;
using facebook::hermes::makeHermesRuntime;

class PrototypeStub final : public HybridObjectPrototype {
protected:
  void loadHybridMethods() override {
    registerHybrids(this, [](Prototype&) {});
  }
};

class DispatcherStub final : public Dispatcher {
public:
  void runSync(std::function<void()>&& callback) override { callback(); }
  void runAsync(std::function<void()>&& callback) override { callback(); }
};

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

void checkCounts(std::size_t expected) {
  require(cacheProbePrototypeRuntimeEntries() == expected,
          "Prototype registry retained a dead runtime or lost a live runtime");
  require(cacheProbeJSIRuntimeEntries() == expected, "JSICache retained a dead runtime or lost a live runtime");
  require(cacheProbePropRuntimeEntries() == expected, "PropNameIDCache retained a dead runtime or lost a live runtime");
  require(cacheProbeGlobalRuntimeEntries() == expected, "CommonGlobals retained a dead runtime or lost a live runtime");
  require(cacheProbeDispatcherRuntimeEntries() == expected,
          "Dispatcher retained a dead runtime or lost a live runtime");
}

void operation(jsi::Runtime& runtime) {
  const auto& name = PropNameIDCache::get(runtime, "binaryHash");
  jsi::Object object(runtime);
  object.setProperty(runtime, name, 42);
  require(object.getProperty(runtime, name).getNumber() == 42, "A cached property name belongs to another runtime");
  CommonGlobals::Object::freeze(runtime, object);
  auto cache = JSICache::getOrCreateCache(runtime);
  auto owner = cache.makeShared(jsi::Object(runtime));
  require(static_cast<bool>(owner), "A fresh runtime cache reference is already invalid");
}

void initialize(jsi::Runtime& runtime) {
  Dispatcher::installRuntimeGlobalDispatcher(runtime, std::make_shared<DispatcherStub>());
  require(Dispatcher::getRuntimeGlobalDispatcher(runtime) != nullptr, "Runtime dispatcher lookup failed");
  operation(runtime);
  PrototypeStub prototype;
  require(prototype.getPrototype(runtime).isObject(), "The runtime prototype is invalid");
}

void checkLifecycle() {
  checkCounts(0);
  {
    auto runtime = makeHermesRuntime();
    initialize(*runtime);
    for (int index = 0; index < 10000; ++index)
      operation(*runtime);
    checkCounts(1);
  }
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "Runtime teardown retained reference control states");

  std::vector<std::unique_ptr<facebook::hermes::HermesRuntime>> runtimes;
  for (std::size_t index = 0; index < 16; ++index) {
    auto runtime = makeHermesRuntime();
    initialize(*runtime);
    runtimes.push_back(std::move(runtime));
  }
  checkCounts(16);
  runtimes.erase(runtimes.begin(), runtimes.begin() + 8);
  checkCounts(8);
  for (const auto& runtime : runtimes)
    operation(*runtime);
  runtimes.clear();
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "Disjoint runtime teardown retained reference control states");
  for (int index = 0; index < 100; ++index) {
    auto runtime = makeHermesRuntime();
    initialize(*runtime);
    checkCounts(1);
    runtime.reset();
    checkCounts(0);
  }
}

void evaluate(jsi::Runtime& runtime, const std::string& source) {
  runtime.evaluateJavaScript(std::make_shared<jsi::StringBuffer>(source), "registry-generation.js");
}

void checkDispatcherInstallation() {
  checkCounts(0);
  {
    auto runtime = makeHermesRuntime();
    evaluate(*runtime, "Object.defineProperty(globalThis, '__nitroDispatcher', {value: undefined, writable: false});");
    bool failed = false;
    try {
      Dispatcher::installRuntimeGlobalDispatcher(*runtime, std::make_shared<DispatcherStub>());
    } catch (const std::exception&) {
      failed = true;
    }
    require(failed, "Initial installation over a read-only global must fail");
    checkCounts(0);
  }
  checkCounts(0);
  {
    auto runtime = makeHermesRuntime();
    auto original = std::make_shared<DispatcherStub>();
    Dispatcher::installRuntimeGlobalDispatcher(*runtime, original);
    require(Dispatcher::getRuntimeGlobalDispatcher(*runtime) == original,
            "A dispatcher-only runtime lost its installed dispatcher");
    evaluate(*runtime, "Object.defineProperty(globalThis, '__nitroDispatcher', {writable: false});");
    auto replacement = std::make_shared<DispatcherStub>();
    bool failed = false;
    try {
      Dispatcher::installRuntimeGlobalDispatcher(*runtime, replacement);
    } catch (const std::exception&) {
      failed = true;
    }
    require(failed, "Replacing a read-only dispatcher global must fail");
    require(Dispatcher::getRuntimeGlobalDispatcher(*runtime) == original,
            "Failed installation replaced the working runtime dispatcher");
  }
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "A dispatcher-only runtime retained reference states");
}

void prepareReentrantCacheFailure(jsi::Runtime& runtime, std::size_t& failures) {
  runtime.global().setProperty(
      runtime, "tryCache",
      jsi::Function::createFromHostFunction(
          runtime, jsi::PropNameID::forAscii(runtime, "tryCache"), 0,
          [&failures](jsi::Runtime& current, const jsi::Value&, const jsi::Value*, std::size_t) {
            try {
              auto cache = JSICache::getOrCreateCache(current);
            } catch (const std::exception&) {
              ++failures;
            }
            return jsi::Value::undefined();
          }));
  evaluate(runtime, R"JS(
    globalThis.cacheInstallAttempts = 0;
    Object.defineProperty(globalThis, '__nitroJsiCache', {
      configurable: true,
      set(value) {
        if (++globalThis.cacheInstallAttempts === 1) {
          globalThis.savedOldCache = value;
          throw Error('cache installation rejected');
        }
        Object.defineProperty(globalThis, '__nitroJsiCache', {value, configurable:true, writable:true});
      }
    });
  )JS");
}

void finishReentrantRecovery(std::unique_ptr<facebook::hermes::HermesRuntime>& runtime) {
  initialize(*runtime);
  checkCounts(1);
  evaluate(*runtime, "globalThis.savedOldCache = undefined;");
  runtime->instrumentation().collectGarbage("reentrant-cache-recovery");
  checkCounts(1);
  operation(*runtime);
  runtime.reset();
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "Reentrant cache recovery retained reference states after teardown");
}

void checkLookupFailureBeforeCacheCreation() {
  checkCounts(0);
  auto runtime = makeHermesRuntime();
  evaluate(*runtime, R"JS(
    globalThis.lookupCalls = 0;
    const original = Object.freeze;
    Object.defineProperty(Object, 'freeze', {
      configurable: true,
      get() {
        if (++globalThis.lookupCalls === 1) throw Error('lookup rejected before cache creation');
        return original;
      }
    });
  )JS");
  {
    jsi::Object object(*runtime);
    bool failed = false;
    try {
      CommonGlobals::Object::freeze(*runtime, object);
    } catch (const std::exception&) {
      failed = true;
    }
    require(failed, "The first function lookup must propagate its getter failure");
    checkCounts(0);
    CommonGlobals::Object::freeze(*runtime, object);
    CommonGlobals::Object::freeze(*runtime, object);
  }
  evaluate(*runtime, "if (globalThis.lookupCalls !== 2) throw Error('successful lookup was not cached');");
  finishReentrantRecovery(runtime);
}

void checkReentrantLookupRecovery(bool prototypeLookup) {
  checkCounts(0);
  auto runtime = makeHermesRuntime();
  std::size_t failures = 0;
  prepareReentrantCacheFailure(*runtime, failures);
  runtime->global().setProperty(*runtime, "lookupName",
                                jsi::String::createFromAscii(*runtime, prototypeLookup ? "create" : "freeze"));
  evaluate(*runtime, R"JS(
    globalThis.lookupCalls = 0;
    const original = Object[globalThis.lookupName];
    Object.defineProperty(Object, globalThis.lookupName, {
      configurable: true,
      get() {
        ++globalThis.lookupCalls;
        tryCache();
        return original;
      }
    });
  )JS");
  {
    if (prototypeLookup) {
      PrototypeStub prototype;
      auto first = prototype.getPrototype(*runtime);
      auto second = prototype.getPrototype(*runtime);
      require(first.isObject() && jsi::Value::strictEquals(*runtime, first, second),
              "Prototype recovery did not preserve cached reuse");
    } else {
      jsi::Object object(*runtime);
      CommonGlobals::Object::freeze(*runtime, object);
      CommonGlobals::Object::freeze(*runtime, object);
      runtime->global().setProperty(*runtime, "frozenTarget", std::move(object));
      evaluate(*runtime, "if (!Object.isFrozen(globalThis.frozenTarget)) throw Error('freeze was not called');");
    }
  }
  require(failures == 1, "A reentrant getter must catch exactly one failed cache installation");
  evaluate(*runtime, R"JS(
    if (globalThis.lookupCalls !== 1 || globalThis.cacheInstallAttempts !== 2)
      throw Error('recovered lookup bypassed cached reuse or cache installation retry');
  )JS");
  finishReentrantRecovery(runtime);
}

void checkPropertyNameRecovery() {
  checkCounts(0);
  auto runtime = makeHermesRuntime();
  std::size_t failures = 0;
  prepareReentrantCacheFailure(*runtime, failures);
  bool failed = false;
  try {
    static_cast<void>(PropNameIDCache::get(*runtime, "retryProperty"));
  } catch (const std::exception&) {
    failed = true;
  }
  require(failed, "Property-name setup must propagate the first cache installation failure");
  checkCounts(0);
  {
    const auto& name = PropNameIDCache::get(*runtime, "retryProperty");
    const auto& reused = PropNameIDCache::get(*runtime, "retryProperty");
    require(&name == &reused, "Recovered property-name lookup did not reuse its cached reference");
    jsi::Object object(*runtime);
    object.setProperty(*runtime, name, 42);
    require(object.getProperty(*runtime, reused).getNumber() == 42,
            "Recovered property-name lookup returned an invalid JSI reference");
  }
  finishReentrantRecovery(runtime);
}

void checkFailedCreationGeneration() {
  auto runtime = makeHermesRuntime();
  runtime->global().setProperty(*runtime, "warmFailedCaches",
                                jsi::Function::createFromHostFunction(
                                    *runtime, jsi::PropNameID::forAscii(*runtime, "warmFailedCaches"), 0,
                                    [](jsi::Runtime& current, const jsi::Value&, const jsi::Value*, std::size_t) {
                                      initialize(current);
                                      return jsi::Value::undefined();
                                    }));
  evaluate(*runtime, R"JS(
    globalThis.failCache = true;
    Object.defineProperty(globalThis, '__nitroJsiCache', {
      configurable: true,
      set(value) {
        if (globalThis.failCache) {
          globalThis.savedOldCache = value;
          warmFailedCaches();
          throw Error('first install fails');
        }
        Object.defineProperty(globalThis, '__nitroJsiCache', {value, configurable:true, writable:true});
      }
    });
  )JS");
  bool failed = false;
  try {
    auto cache = JSICache::getOrCreateCache(*runtime);
  } catch (const std::exception&) {
    failed = true;
  }
  require(failed, "The fixture must retain a failed cache generation until GC");
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "Failed initialization did not invalidate its cached JSI payloads immediately");
  evaluate(*runtime, "globalThis.failCache = false;");
  initialize(*runtime);
  {
    BorrowingReference<jsi::Object> current;
    {
      auto cache = JSICache::getOrCreateCache(*runtime);
      current = cache.makeShared(jsi::Object(*runtime));
    }
    checkCounts(1);
    evaluate(*runtime, "globalThis.savedOldCache = undefined;");
    runtime->instrumentation().collectGarbage("failed-cache-generation");
    checkCounts(1);
    require(static_cast<bool>(current), "Collecting the failed generation invalidated a successful retry");
    operation(*runtime);
  }
  runtime.reset();
  checkCounts(0);
  require(cacheProbeLiveStates == 0, "The successful generation did not clean up at runtime teardown");
}

void checkWorkerOwnedInvalidation() {
  auto runtime = makeHermesRuntime();
  initialize(*runtime);
  auto function = jsi::Function::createFromHostFunction(
      *runtime, jsi::PropNameID::forAscii(*runtime, "held"), 0,
      [](jsi::Runtime&, const jsi::Value&, const jsi::Value*, std::size_t) { return jsi::Value::undefined(); });
  BorrowingReference<jsi::Function> owner;
  {
    auto cache = JSICache::getOrCreateCache(*runtime);
    owner = cache.makeShared(std::move(function));
  }
  std::barrier gate(2);
  bool invalidated = false;
  std::thread worker([value = std::move(owner), &gate, &invalidated]() mutable {
    gate.arrive_and_wait();
    gate.arrive_and_wait();
    invalidated = !value;
    value = {};
  });
  gate.arrive_and_wait();
  runtime.reset();
  const auto retainedStates = cacheProbeLiveStates.load();
  gate.arrive_and_wait();
  worker.join();
  checkCounts(0);
  require(retainedStates == 1, "Runtime teardown lost a worker-owned control state");
  require(invalidated && cacheProbeLiveStates == 0, "The worker released a live JSI value after runtime destruction");
}

void checkConcurrentRuntimes() {
  constexpr int count = 4;
  std::barrier gate(count);
  std::vector<std::thread> workers;
  workers.reserve(count);
  for (int id = 0; id < count; ++id) {
    workers.emplace_back([&, id] {
      for (int round = 0; round < 40; ++round) {
        auto runtime = makeHermesRuntime();
        gate.arrive_and_wait();
        initialize(*runtime);
        for (int index = 0; index < 20; ++index)
          operation(*runtime);
        gate.arrive_and_wait();
        if (id == 0)
          checkCounts(count);
        gate.arrive_and_wait();
        runtime.reset();
        gate.arrive_and_wait();
        if (id == 0)
          checkCounts(0);
        gate.arrive_and_wait();
      }
    });
  }
  for (auto& worker : workers)
    worker.join();
  require(cacheProbeLiveStates == 0, "Concurrent runtimes retained reference control states");
}
} // namespace

int main(int argc, char**) {
  try {
    if (argc > 1) {
      checkDispatcherInstallation();
      checkConcurrentRuntimes();
      std::cout << "Real Hermes runtime registries preserve live owners during cold concurrent initialization\n";
      return 0;
    }
    checkDispatcherInstallation();
    checkLifecycle();
    checkLookupFailureBeforeCacheCreation();
    checkReentrantLookupRecovery(false);
    checkReentrantLookupRecovery(true);
    checkPropertyNameRecovery();
    checkFailedCreationGeneration();
    checkWorkerOwnedInvalidation();
    checkConcurrentRuntimes();
    std::cout
        << "Real Hermes runtime registries preserve live owners, remove dead runtimes and serialize shared maps\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
