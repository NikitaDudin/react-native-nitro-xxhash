#include "JSICache.hpp"

#include <atomic>
#include <barrier>
#include <condition_variable>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <thread>
#include <vector>

namespace {
using margelo::nitro::BorrowingReference;
using margelo::nitro::JSICacheReference;
using margelo::nitro::WeakReference;

struct Gate {
  std::mutex mutex;
  std::condition_variable changed;
  bool entered = false;
  bool release = false;
};

struct Value {
  inline static std::atomic_size_t alive{0};
  inline static std::atomic_size_t destroyed{0};
  Gate* gate = nullptr;
  explicit Value(Gate* value = nullptr) : gate(value) { ++alive; }
  ~Value() {
    if (gate != nullptr) {
      std::unique_lock lock(gate->mutex);
      gate->entered = true;
      gate->changed.notify_all();
      gate->changed.wait(lock, [&] { return gate->release; });
    }
    --alive;
    ++destroyed;
  }
};

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

void checkNullAndInvalidation() {
  WeakReference<Value> empty;
  require(empty.expired() && !empty.lock(), "A default weak reference must be safe");
  BorrowingReference<Value> missing;
  auto missingWeak = missing.weak();
  require(missingWeak.expired() && !missingWeak.lock(), "An empty owner must weakify safely");
  auto owner = BorrowingReference<Value>(new Value());
  auto sibling = owner;
  auto weak = owner.weak();
  const auto destroyed = Value::destroyed.load();
  owner.destroy();
  require(!owner && !sibling && weak.expired() && !weak.lock(), "Explicit invalidation must reach live owners");
  require(Value::destroyed == destroyed + 1, "Explicit invalidation must destroy once");
  weak = {};
  owner = {};
  sibling = {};
  require(Value::alive == 0, "Invalidated payload survived its owners");
}

void checkPositiveOnlyLock() {
  Gate gate;
  auto owner = BorrowingReference<Value>(new Value(&gate));
  auto weak = owner.weak();
  std::thread worker([value = std::move(owner)]() mutable { value = {}; });
  {
    std::unique_lock lock(gate.mutex);
    gate.changed.wait(lock, [&] { return gate.entered; });
  }
  const bool expired = weak.expired();
  auto reserved = weak.lock();
  const bool resurrected = static_cast<bool>(reserved);
  // The final explicit weak release races a still-running last strong destructor.
  weak = {};
  {
    const std::scoped_lock lock(gate.mutex);
    gate.release = true;
  }
  gate.changed.notify_all();
  worker.join();
  reserved = {};
  require(expired && !resurrected, "Weak lock resurrected a value after its last destructor began");
  require(Value::alive == 0, "Worker-owned final release leaked a payload");
}

void checkInvalidatedWorkerOwner() {
  const auto controls = margelo::nitro::cacheProbeLiveStates.load();
  auto owner = BorrowingReference<Value>(new Value());
  auto weak = owner.weak();
  std::barrier entered(2);
  std::barrier release(2);
  std::thread worker([value = owner, &entered, &release]() mutable {
    entered.arrive_and_wait();
    release.arrive_and_wait();
    value = {};
  });
  entered.arrive_and_wait();
  owner.destroy();
  const bool invalidated = !owner && weak.expired() && !weak.lock();
  weak = {};
  owner = {};
  const bool controlRetained = margelo::nitro::cacheProbeLiveStates == controls + 1;
  release.arrive_and_wait();
  worker.join();
  require(invalidated && controlRetained, "Runtime invalidation lost a worker-owned control state");
  require(margelo::nitro::cacheProbeLiveStates == controls, "Worker did not release its invalidated state");
}

void checkConcurrentFinalReleases() {
  constexpr std::size_t count = 20000;
  std::vector<BorrowingReference<Value>> owners;
  std::vector<WeakReference<Value>> weak;
  owners.reserve(count);
  weak.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    owners.emplace_back(new Value());
    weak.push_back(owners.back().weak());
  }
  std::barrier start(2);
  std::thread strong([&] {
    for (auto& owner : owners) {
      start.arrive_and_wait();
      owner = {};
    }
  });
  std::thread lastWeak([&] {
    for (auto& reference : weak) {
      start.arrive_and_wait();
      reference = {};
    }
  });
  strong.join();
  lastWeak.join();
  require(Value::alive == 0, "Concurrent final releases retained a payload");
}

void checkLockReleaseRace() {
  constexpr std::size_t count = 10000;
  std::vector<BorrowingReference<Value>> owners;
  std::vector<WeakReference<Value>> weak;
  owners.reserve(count);
  weak.reserve(count);
  for (std::size_t index = 0; index < count; ++index) {
    owners.emplace_back(new Value());
    weak.push_back(owners.back().weak());
  }
  std::barrier start(2);
  std::thread strong([&] {
    for (auto& owner : owners) {
      start.arrive_and_wait();
      owner = {};
    }
  });
  std::thread locking([&] {
    for (auto& reference : weak) {
      start.arrive_and_wait();
      auto owner = reference.lock();
      if (owner)
        static_cast<void>(owner->gate);
    }
  });
  strong.join();
  locking.join();
  weak.clear();
  require(Value::alive == 0, "Weak-lock races retained a payload");
}

void checkAmortizedPruning() {
  constexpr std::size_t liveCount = 1023;
  constexpr std::size_t insertions = 20000;
  std::vector<BorrowingReference<Value>> owners;
  std::vector<WeakReference<Value>> entries;
  owners.reserve(liveCount);
  entries.reserve(liveCount + 1);
  for (std::size_t index = 0; index < liveCount; ++index) {
    owners.emplace_back(new Value());
    entries.push_back(owners.back().weak());
  }
  const auto before = margelo::nitro::cacheProbeExpiredChecks.load();
  for (std::size_t index = 0; index < insertions; ++index) {
    auto ephemeral = BorrowingReference<Value>(new Value());
    JSICacheReference::cacheProbeRetain(entries, ephemeral);
  }
  const auto scans = margelo::nitro::cacheProbeExpiredChecks.load() - before;
  require(scans < 8 * (liveCount + insertions), "Pruning became a full live-cache scan for every insertion");
  for (std::size_t index = 0; index < liveCount; ++index)
    require(entries[index].lock() != nullptr, "Pruning invalidated a live borrowing reference");
  owners.clear();
  for (std::size_t index = 0; index < insertions; ++index) {
    auto ephemeral = BorrowingReference<Value>(new Value());
    JSICacheReference::cacheProbeRetain(entries, ephemeral);
  }
  require(entries.size() <= 64 && entries.capacity() <= 64, "Expired cache metadata did not plateau");
  entries.clear();
  require(Value::alive == 0, "Cache pruning retained a payload");
  std::cout << "amortizedExpiryChecks=" << scans << " forInsertions=" << insertions << '\n';
}
} // namespace

int main() {
  try {
    checkNullAndInvalidation();
    checkPositiveOnlyLock();
    checkInvalidatedWorkerOwner();
    checkConcurrentFinalReleases();
    checkLockReleaseRace();
    checkAmortizedPruning();
    require(margelo::nitro::cacheProbeLiveStates == 0, "Reference control states were not released");
    std::cout << "Nitro cache/reference regression passed; payloads=" << Value::destroyed.load() << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
