#include "HybridFileHasher.hpp"
#include <NitroModules/Dispatcher.hpp>
#include <NitroModules/HybridObjectRegistry.hpp>
#include <NitroModules/InstallNitro.hpp>
#include <hermes/hermes.h>
#include <jsi/jsi.h>

#include <algorithm>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <future>
#include <iostream>
#include <iterator>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>

// Link the competitor's original implementation in its own translation unit.
namespace xxhash {
void install(facebook::jsi::Runtime* runtime);
}

namespace {
class BenchmarkDispatcher final : public margelo::nitro::Dispatcher {
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
  void runNext(std::chrono::milliseconds wait) {
    std::function<void()> callback;
    {
      std::unique_lock lock(mutex_);
      if (!available_.wait_for(lock, wait, [this] { return !callbacks_.empty(); }))
        return;
      callback = std::move(callbacks_.front());
      callbacks_.pop_front();
    }
    callback();
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
    if (argc != 2 && argc != 3)
      throw std::runtime_error("Expected optimized Hermes bytecode and optional fixture path");
    runtime =
        facebook::hermes::makeHermesRuntime(::hermes::vm::RuntimeConfig::Builder().withMicrotaskQueue(true).build());
    auto dispatcher = std::make_shared<BenchmarkDispatcher>();
    margelo::nitro::HybridObjectRegistry::registerHybridObjectConstructor(
        "FileHasher", [] { return std::make_shared<margelo::nitro::xxhash::HybridFileHasher>(); });
    margelo::nitro::install(*runtime, dispatcher);
    xxhash::install(runtime.get());
    const auto fixture = std::make_shared<const std::string>(argc == 3 ? argv[2] : "");
    runtime->global().setProperty(*runtime, "benchmarkFilePath",
                                  facebook::jsi::String::createFromUtf8(*runtime, *fixture));
    runtime->global().setProperty(*runtime, "readBenchmarkString",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "readBenchmarkString"), 0,
                                      [fixture](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                                const facebook::jsi::Value*, std::size_t) {
                                        const auto size = std::filesystem::file_size(*fixture);
                                        std::string bytes(size, '\0');
                                        std::ifstream input(*fixture, std::ios::binary);
                                        if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
                                          throw std::runtime_error("Cannot read the complete ASCII benchmark fixture");
                                        return facebook::jsi::String::createFromAscii(rt, bytes.data(), bytes.size());
                                      }));
    runtime->global().setProperty(*runtime, "readBenchmarkChunks",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "readBenchmarkChunks"), 0,
                                      [fixture](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                                const facebook::jsi::Value*, std::size_t) {
                                        constexpr std::size_t chunkSize = 250'000'000;
                                        const auto size = std::filesystem::file_size(*fixture);
                                        const auto count = (size + chunkSize - 1) / chunkSize;
                                        auto chunks = facebook::jsi::Array(rt, count);
                                        std::ifstream input(*fixture, std::ios::binary);
                                        for (std::size_t index = 0; index < count; ++index) {
                                          const auto length = std::min(chunkSize, size - index * chunkSize);
                                          std::string bytes(length, '\0');
                                          if (!input.read(bytes.data(), static_cast<std::streamsize>(bytes.size())))
                                            throw std::runtime_error("Cannot read the complete ASCII benchmark chunk");
                                          chunks.setValueAtIndex(
                                              rt, index,
                                              facebook::jsi::String::createFromAscii(rt, bytes.data(), bytes.size()));
                                        }
                                        return chunks;
                                      }));
    runtime->global().setProperty(
        *runtime, "benchmarkNow",
        facebook::jsi::Function::createFromHostFunction(
            *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "benchmarkNow"), 0,
            [](facebook::jsi::Runtime&, const facebook::jsi::Value&, const facebook::jsi::Value*, std::size_t) {
              return facebook::jsi::Value(
                  std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch())
                      .count());
            }));
    runtime->global().setProperty(*runtime, "print",
                                  facebook::jsi::Function::createFromHostFunction(
                                      *runtime, facebook::jsi::PropNameID::forAscii(*runtime, "print"), 1,
                                      [](facebook::jsi::Runtime& rt, const facebook::jsi::Value&,
                                         const facebook::jsi::Value* args, std::size_t count) {
                                        if (count != 1 || !args[0].isString())
                                          throw std::runtime_error("Expected one benchmark output string");
                                        std::cout << args[0].asString(rt).utf8(rt) << '\n';
                                        return facebook::jsi::Value::undefined();
                                      }));
    std::ifstream stream(argv[1], std::ios::binary);
    if (!stream)
      throw std::runtime_error("Cannot open Hermes bytecode");
    const std::string bytecode{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
    runtime->evaluateJavaScript(std::make_shared<facebook::jsi::StringBuffer>(bytecode), argv[1]);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::minutes(9);
    for (;;) {
      runtime->drainMicrotasks();
      const auto pending = runtime->global().getProperty(*runtime, "__benchmarkAsyncPending");
      if (!pending.isBool() || !pending.getBool())
        break;
      if (std::chrono::steady_clock::now() >= deadline)
        throw std::runtime_error("Asynchronous benchmark timed out");
      dispatcher->runNext(std::chrono::milliseconds(1));
    }
    const auto error = runtime->global().getProperty(*runtime, "__benchmarkAsyncError");
    if (error.isString())
      throw std::runtime_error(error.getString(*runtime).utf8(*runtime));
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
