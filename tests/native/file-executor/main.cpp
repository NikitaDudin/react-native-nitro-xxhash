#include "FileHashExecutor.hpp"
#include <NitroModules/ThreadUtils.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <future>
#include <iostream>
#include <mutex>
#include <stdexcept>

namespace {
std::mutex gateMutex;
std::condition_variable gateChanged;
std::size_t entered = 0;
bool released = false;

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

void releaseGate() {
  {
    const std::scoped_lock lock(gateMutex);
    released = true;
  }
  gateChanged.notify_all();
}
} // namespace

// Only platform naming and the blocking I/O boundary are test doubles. Both
// actual Nitro pools, its Promise implementation and our executor are linked.
namespace margelo::nitro {
void ThreadUtils::setThreadName(const std::string&) {}
} // namespace margelo::nitro

namespace nitro_xxhash {
std::string digestFile(const std::string& path, HashAlgorithm algorithm, std::uint64_t seed,
                       const std::atomic_bool* cancelled) {
  {
    std::unique_lock lock(gateMutex);
    ++entered;
    gateChanged.notify_all();
    gateChanged.wait(lock, [] { return released; });
  }
  if (cancelled != nullptr && cancelled->load())
    throw FileHashCancelled();
  require(algorithm == HashAlgorithm::xxh3_128 && seed == 42, "Executor changed owned input parameters");
  return path;
}
} // namespace nitro_xxhash

int main() {
  using namespace std::chrono_literals;
  using margelo::nitro::Promise;
  using margelo::nitro::xxhash::runFileHash;
  using nitro_xxhash::HashAlgorithm;
  try {
    auto cancelled = std::make_shared<std::atomic_bool>(false);
    std::string path = "owned-path";
    auto first = runFileHash(path, HashAlgorithm::xxh3_128, 42);
    auto second = runFileHash(path, HashAlgorithm::xxh3_128, 42, cancelled);
    path.clear();
    {
      std::unique_lock lock(gateMutex);
      require(gateChanged.wait_for(lock, 3s, [] { return entered == 2; }), "Both dedicated workers must start");
    }
    auto unrelated = Promise<int>::async([] { return 123; })->await();
    require(unrelated.wait_for(3s) == std::future_status::ready, "File reads occupied Nitro's shared workers");
    require(unrelated.get() == 123, "Unrelated Nitro task did not preserve its result");
    auto firstResult = first->await();
    auto secondResult = second->await();
    cancelled->store(true);
    second.reset();
    cancelled.reset();
    releaseGate();
    require(firstResult.get() == "owned-path", "Worker borrowed the caller's path");
    bool rejected = false;
    try {
      static_cast<void>(secondResult.get());
    } catch (const nitro_xxhash::FileHashCancelled&) {
      rejected = true;
    }
    require(rejected, "Cancellation lost its owned flag or rejection type");
    require(runFileHash("recovered", HashAlgorithm::xxh3_128, 42)->await().get() == "recovered",
            "Worker cannot be reused after cancellation");
    std::cout << "Dedicated file workers preserve ownership, cancellation, reuse and shared-pool availability\n";
    return 0;
  } catch (const std::exception& error) {
    releaseGate();
    std::cerr << error.what() << '\n';
    return 1;
  }
}
