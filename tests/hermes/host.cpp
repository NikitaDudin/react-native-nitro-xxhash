#include "ArrayBufferBytes.hpp"
#include "HybridFileHasher.hpp"
#include <NitroModules/Dispatcher.hpp>
#include <NitroModules/HybridObjectRegistry.hpp>
#include <NitroModules/InstallNitro.hpp>
#include <NitroModules/JSIConverter.hpp>
#include <hermes/hermes.h>
#include <jsi/instrumentation.h>
#include <jsi/jsi.h>

#include <chrono>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <mutex>
#include <thread>
#include <unordered_map>

namespace {
// Workers enqueue native callbacks; only the owning thread ever touches JSI.
class HostDispatcher final : public margelo::nitro::Dispatcher {
public:
  void runSync(std::function<void()>&& function) override {
    if (std::this_thread::get_id() == owner_) {
      function();
      return;
    }
    auto task = std::make_shared<std::packaged_task<void()>>(std::move(function));
    auto result = task->get_future();
    runAsync([task] { (*task)(); });
    result.get();
  }

  void runAsync(std::function<void()>&& function) override {
    {
      const std::scoped_lock lock(mutex_);
      callbacks_.push_back(std::move(function));
    }
    available_.notify_one();
  }

  bool runNext(std::chrono::milliseconds wait) {
    std::function<void()> callback;
    {
      std::unique_lock lock(mutex_);
      if (!available_.wait_for(lock, wait, [this] { return !callbacks_.empty(); }))
        return false;
      callback = std::move(callbacks_.front());
      callbacks_.pop_front();
    }
    callback();
    return true;
  }

private:
  const std::thread::id owner_ = std::this_thread::get_id();
  std::mutex mutex_;
  std::condition_variable available_;
  std::deque<std::function<void()>> callbacks_;
};
} // namespace

int main(int argc, char** argv) {
  std::unique_ptr<facebook::hermes::HermesRuntime> runtime;
  try {
    if (argc != 3)
      throw std::runtime_error("Expected JavaScript source and fixture file paths");
    runtime =
        facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build());
    std::unordered_map<std::string, facebook::jsi::WeakObject> watchedObjects;
    auto dispatcher = std::make_shared<HostDispatcher>();
    margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
        "FileHasher", [] { return std::make_shared<margelo::nitro::xxhash::HybridFileHasher>(); });
    margelo::nitro::install(*runtime, dispatcher);
    runtime->global().setProperty(*runtime, "fileFixturePath",
                                  facebook::jsi::String::createFromUtf8(*runtime, argv[2]));
    runtime->global().setProperty(*runtime, "queueMicrotask",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "queueMicrotask"), 1,
                                      [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                         const facebook::jsi::Value* args, std::size_t count) {
                                        if (count != 1)
                                          throw std::runtime_error("Expected one microtask callback");
                                        rt.queueMicrotask(args[0].asObject(rt).asFunction(rt));
                                        return facebook::jsi::Value::undefined();
                                      }));
    runtime->global().setProperty(*runtime, "print",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "print"), 1,
                                      [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                         const facebook::jsi::Value* args, std::size_t count) {
                                        if (count > 0)
                                          std::cout << args[0].asString(rt).utf8(rt) << '\n';
                                        return facebook::jsi::Value::undefined();
                                      }));
    runtime->global().setProperty(
        *runtime, "watchObject",
        facebook::jsi::Function::createFromHostFunction(
            *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "watchObject"), 2,
            [&watchedObjects](facebook::jsi::Runtime& rt, const facebook::jsi::Value&, const facebook::jsi::Value* args,
                              std::size_t count) {
              if (count != 2 || watchedObjects.size() >= 128)
                throw std::runtime_error("Expected label/object and at most 128 watched objects");
              watchedObjects.insert_or_assign(args[0].getString(rt).utf8(rt),
                                              facebook::jsi::WeakObject(rt, args[1].getObject(rt)));
              return facebook::jsi::Value::undefined();
            }));
    runtime->global().setProperty(*runtime, "watchedObjectAlive",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "watchedObjectAlive"), 1,
                                      [&watchedObjects](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                                        const facebook::jsi::Value* args, std::size_t count) {
                                        if (count != 1)
                                          throw std::runtime_error("Expected one watched-object label");
                                        const auto found = watchedObjects.find(args[0].getString(rt).utf8(rt));
                                        if (found == watchedObjects.end())
                                          throw std::runtime_error("Unknown watched-object label");
                                        return facebook::jsi::Value(!found->second.lock(rt).isUndefined());
                                      }));
    runtime->global().setProperty(*runtime, "clearWatchedObjects",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "clearWatchedObjects"), 0,
                                      [&watchedObjects](facebook::jsi::Runtime&, const facebook::jsi::Value&,
                                                        const facebook::jsi::Value*, std::size_t) {
                                        watchedObjects.clear();
                                        return facebook::jsi::Value::undefined();
                                      }));
    runtime->global().setProperty(
        *runtime, "collectGarbage",
        facebook::jsi::Function::createFromHostFunction(
            *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "collectGarbage"), 0,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) {
              rt.instrumentation().collectGarbage("xxhash-stream-retention-test");
              return facebook::jsi::Value::undefined();
            }));
    runtime->global().setProperty(
        *runtime, "assertBorrowedRange",
        facebook::jsi::Function::createFromHostFunction(
            *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "assertBorrowedRange"), 3,
            [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&, const facebook::jsi::Value* args,
               std::size_t count) {
              if (count != 3)
                throw std::runtime_error("Expected buffer, offset and length");
              auto jsBuffer = args[0].getObject(rt).getArrayBuffer(rt);
              auto nativeBuffer =
                  margelo::nitro::JSIConverter<std::shared_ptr<margelo::nitro::ArrayBuffer>>::fromJSI(rt, args[0]);
              const auto offset = args[1].getNumber();
              const auto length = args[2].getNumber();
              auto bytes = margelo::nitro::xxhash::borrowBufferBytes(nativeBuffer, offset, length);
              auto source = jsBuffer.data(rt);
              auto expected = source == nullptr
                                  ? nullptr
                                  : reinterpret_cast<const std::byte*>(source) + static_cast<std::size_t>(offset);
              if (bytes.data() != expected || bytes.size() != static_cast<std::size_t>(length))
                throw std::runtime_error("Nitro conversion copied bytes or lost the requested range");
              return facebook::jsi::Value(true);
            }));
    std::ifstream stream(argv[1]);
    if (!stream)
      throw std::runtime_error("Cannot open JavaScript source");
    const std::string source{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
    runtime->evaluateJavaScript(std::make_shared<facebook::jsi::StringBuffer>(source), argv[1]);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(30);
    for (;;) {
      runtime->drainMicrotasks();
      if (runtime->global().getProperty(*runtime, "__xxhashAsyncDone").getBool())
        break;
      if (std::chrono::steady_clock::now() >= deadline)
        throw std::runtime_error("Hermes async checks timed out");
      dispatcher->runNext(std::chrono::milliseconds(10));
    }
    auto error = runtime->global().getProperty(*runtime, "__xxhashAsyncError");
    if (error.isString())
      throw std::runtime_error(error.getString(*runtime).utf8(*runtime));
    while (dispatcher->runNext(std::chrono::milliseconds(0)))
      runtime->drainMicrotasks();
    std::cout << "Hermes/Nitro host completed successfully\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
