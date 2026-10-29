#include <NitroModules/ThreadPool.hpp>
#include <NitroModules/ThreadUtils.hpp>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <exception>
#include <future>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <system_error>

namespace margelo::nitro {
// Thread naming is the only platform facility outside the real pool under test.
void ThreadUtils::setThreadName(const std::string&) {}
} // namespace margelo::nitro

namespace {
constexpr auto waitLimit = std::chrono::seconds(2);
constexpr int terminateStatus = 86;
constexpr int expansionFailureStatus = 41;

void require(bool condition, const char* message) {
  if (!condition) {
    throw std::runtime_error(message);
  }
}

template <typename Function> Function loadHook(const char* name) {
  auto* symbol = dlsym(RTLD_DEFAULT, name);
  require(symbol != nullptr, "pthread fault-injection hook is not loaded");
  return reinterpret_cast<Function>(symbol);
}

struct Hook {
  using Configure = void (*)(std::size_t);
  using Attempts = std::size_t (*)();
  const Configure reset = loadHook<Configure>("nitroTestResetThreadFailure");
  const Configure failAt = loadHook<Configure>("nitroTestSetThreadFailure");
  const Attempts attempts = loadHook<Attempts>("nitroTestThreadAttempts");
};

class Gate final {
public:
  void enterAndWait() {
    std::unique_lock lock(mutex);
    ++entered;
    changed.notify_all();
    changed.wait(lock, [this] { return released; });
  }

  bool waitFor(std::size_t count) {
    std::unique_lock lock(mutex);
    return changed.wait_for(lock, waitLimit, [this, count] { return entered >= count; });
  }

  void release() {
    {
      const std::scoped_lock lock(mutex);
      released = true;
    }
    changed.notify_all();
  }

private:
  std::mutex mutex;
  std::condition_variable changed;
  std::size_t entered = 0;
  bool released = false;
};

class ReleaseOnExit final {
public:
  explicit ReleaseOnExit(Gate& gate) : gate(gate) {}
  ~ReleaseOnExit() { gate.release(); }
  ReleaseOnExit(const ReleaseOnExit&) = delete;
  ReleaseOnExit& operator=(const ReleaseOnExit&) = delete;
  ReleaseOnExit(ReleaseOnExit&&) = delete;
  ReleaseOnExit& operator=(ReleaseOnExit&&) = delete;

private:
  Gate& gate;
};

void exerciseTwoWorkers(const Hook& hook, std::size_t expectedAttempts) {
  Gate gate;
  margelo::nitro::ThreadPool pool("startup-test", 2, 2);
  // Release blocked callbacks before the pool joins; the gate outlives both.
  const ReleaseOnExit release(gate);
  require(hook.attempts() == expectedAttempts, "retry did not create exactly two real workers");
  pool.run([&gate] { gate.enterAndWait(); });
  pool.run([&gate] { gate.enterAndWait(); });
  require(gate.waitFor(2), "two real workers did not execute concurrently");
}

void startupFailure(const Hook& hook, std::size_t failAt) {
  hook.reset(failAt);
  bool caught = false;
  try {
    const margelo::nitro::ThreadPool pool("failed-startup", 2, 2);
  } catch (const std::system_error& error) {
    require(error.code() == std::errc::resource_unavailable_try_again, "unexpected thread creation error");
    caught = true;
  }
  require(caught, "injected thread creation failure did not propagate");
  require(hook.attempts() == failAt, "constructor did not stop at the failed worker");
  hook.failAt(0);
  exerciseTwoWorkers(hook, failAt + 2);
}

int expansionFailure(const Hook& hook) {
  hook.reset(0);
  Gate gate;
  std::promise<void> queued;
  std::promise<void> retried;
  auto queuedDone = queued.get_future();
  auto retryDone = retried.get_future();
  std::atomic<bool> rejectedRan{false};
  margelo::nitro::ThreadPool pool("expansion-test", 1, 2);
  const ReleaseOnExit release(gate);
  pool.run([&gate] { gate.enterAndWait(); });
  require(gate.waitFor(1), "initial worker did not start");
  // An empty queue does not trigger growth. Keep this callback queued while the
  // sole worker is blocked, so the next run() must try to expand the real pool.
  pool.run([&queued] { queued.set_value(); });
  require(hook.attempts() == 1, "pool expanded before its queue became busy");
  hook.failAt(2);
  bool caught = false;
  try {
    pool.run([&rejectedRan] { rejectedRan.store(true); });
  } catch (const std::system_error& error) {
    require(error.code() == std::errc::resource_unavailable_try_again, "unexpected expansion error");
    caught = true;
  }
  require(caught && hook.attempts() == 2, "busy pool did not attempt the injected expansion");
  hook.failAt(0);
  pool.run([&retried] { retried.set_value(); });
  if (hook.attempts() != 3) {
    std::fputs("EXPANSION_RETRY_MISSING: failed creation consumed the worker limit\n", stderr);
    return expansionFailureStatus;
  }
  require(queuedDone.wait_for(waitLimit) == std::future_status::ready, "pending task did not run on the retry worker");
  require(retryDone.wait_for(waitLimit) == std::future_status::ready, "new task did not run on the retry worker");
  require(!rejectedRan.load(), "run() queued the callback whose expansion failed");
  return 0;
}
} // namespace

int main(int argc, char** argv) {
  std::set_terminate([] {
    std::fputs("TERMINATE: partially started pool could not unwind\n", stderr);
    std::_Exit(terminateStatus);
  });
  try {
    require(argc == 2, "expected one test scenario");
    const Hook hook;
    const std::string_view scenario(argv[1]);
    if (scenario == "normal") {
      hook.reset(0);
      exerciseTwoWorkers(hook, 2);
    } else if (scenario == "failure-first") {
      startupFailure(hook, 1);
    } else if (scenario == "failure-second") {
      startupFailure(hook, 2);
    } else if (scenario == "expansion") {
      const int status = expansionFailure(hook);
      if (status != 0) {
        return status;
      }
    } else {
      throw std::runtime_error("unknown test scenario");
    }
    std::printf("PASS %s\n", argv[1]);
    return 0;
  } catch (const std::exception& error) {
    std::fprintf(stderr, "FAIL: %s\n", error.what());
    return 1;
  }
}
