#include "FileDigest.hpp"

#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <fcntl.h>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <unistd.h>

namespace {
enum class CancelPoint { none, firstRead, endOfFile, blockedRead };
struct ReadGate {
  std::promise<void> entered;
  std::shared_future<void> release;
};
thread_local CancelPoint point = CancelPoint::none;
thread_local std::atomic_bool* activeFlag = nullptr;
thread_local ReadGate* gate = nullptr;
thread_local std::size_t openCalls = 0;
thread_local std::size_t readCalls = 0;
thread_local std::size_t bytesRead = 0;

class ScopedReadControl final {
public:
  ScopedReadControl(CancelPoint value, std::atomic_bool& flag, ReadGate* readGate = nullptr) {
    point = value;
    activeFlag = &flag;
    gate = readGate;
    openCalls = 0;
    readCalls = 0;
    bytesRead = 0;
  }
  ~ScopedReadControl() {
    point = CancelPoint::none;
    activeFlag = nullptr;
    gate = nullptr;
  }
  ScopedReadControl(const ScopedReadControl&) = delete;
  ScopedReadControl& operator=(const ScopedReadControl&) = delete;
};
} // namespace

int controlledOpen(const char* path, int flags) {
  ++openCalls;
  return ::open(path, flags);
}

ssize_t controlledRead(int descriptor, void* buffer, std::size_t size) {
  ++readCalls;
  const auto count = ::read(descriptor, buffer, size);
  if (count > 0)
    bytesRead += static_cast<std::size_t>(count);
  if (point == CancelPoint::firstRead && count > 0)
    activeFlag->store(true, std::memory_order_relaxed);
  if (point == CancelPoint::endOfFile && count == 0)
    activeFlag->store(true, std::memory_order_relaxed);
  if (point == CancelPoint::blockedRead && readCalls == 1) {
    gate->entered.set_value();
    gate->release.wait();
  }
  return count;
}

// Keep deterministic read-boundary controls outside production sources.
#define open controlledOpen
#define read controlledRead
// NOLINTNEXTLINE(bugprone-suspicious-include) -- Compile the real implementation with test-local syscall hooks.
#include "../cpp/FileDigest.cpp"
#undef read
#undef open

namespace {
using nitro_xxhash::FileHashCancelled;
using nitro_xxhash::HashAlgorithm;
constexpr std::array algorithms{HashAlgorithm::xxh32, HashAlgorithm::xxh64, HashAlgorithm::xxh3_64,
                                HashAlgorithm::xxh3_128};
std::size_t checks = 0;

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
  ++checks;
}

template <typename Callback> void expectCancelled(Callback callback) {
  try {
    callback();
  } catch (const FileHashCancelled& error) {
    require(std::string_view(error.what()) == "File hashing cancelled", "Cancellation message changed");
    return;
  }
  throw std::runtime_error("Expected typed file cancellation");
}

std::size_t descriptorCount() {
  const auto limit = ::sysconf(_SC_OPEN_MAX);
  require(limit > 0 && limit <= std::numeric_limits<int>::max(), "Invalid descriptor limit");
  std::size_t count = 0;
  for (int fd = 0; fd < limit; ++fd) {
    errno = 0;
    if (::fcntl(fd, F_GETFD) >= 0)
      ++count;
    else if (errno != EBADF)
      throw std::runtime_error("Cannot inspect descriptors");
  }
  return count;
}

void checkBoundaries(const std::string& path, std::string_view bytes, HashAlgorithm algorithm, std::uint64_t seed) {
  std::atomic_bool cancelled{true};
  {
    const ScopedReadControl control(CancelPoint::none, cancelled);
    expectCancelled([&] { static_cast<void>(nitro_xxhash::digestFile(path, algorithm, seed, &cancelled)); });
    expectCancelled(
        [&] { static_cast<void>(nitro_xxhash::digestFile(path + ".missing", algorithm, seed, &cancelled)); });
    require(openCalls == 0 && readCalls == 0, "Early cancellation reached file I/O");
  }
  for (const auto boundary : {CancelPoint::firstRead, CancelPoint::endOfFile}) {
    cancelled.store(false, std::memory_order_relaxed);
    const ScopedReadControl control(boundary, cancelled);
    expectCancelled([&] { static_cast<void>(nitro_xxhash::digestFile(path, algorithm, seed, &cancelled)); });
    require(openCalls == 1, "Expected one file open before boundary cancellation");
    if (boundary == CancelPoint::firstRead)
      require(readCalls == 1 && bytesRead == std::size_t{64} * 1024,
              "Cancellation did not stop after the first bounded read");
    else
      require(bytesRead == bytes.size() && readCalls > 1, "EOF cancellation did not follow all reads");
  }
  cancelled.store(false, std::memory_order_relaxed);
  const ScopedReadControl control(CancelPoint::none, cancelled);
  const auto expected = nitro_xxhash::digestString(bytes, algorithm, seed);
  require(nitro_xxhash::digestFile(path, algorithm, seed, &cancelled) == expected,
          "A separate uncancelled operation was affected");
}

void checkInflight(const std::string& path, HashAlgorithm algorithm) {
  std::atomic_bool cancelled{false};
  std::promise<void> release;
  ReadGate readGate{{}, release.get_future().share()};
  auto entered = readGate.entered.get_future();
  auto task = std::async(std::launch::async, [&] {
    const ScopedReadControl control(CancelPoint::blockedRead, cancelled, &readGate);
    try {
      static_cast<void>(nitro_xxhash::digestFile(path, algorithm, 42, &cancelled));
    } catch (const FileHashCancelled& error) {
      if (std::string_view(error.what()) != "File hashing cancelled")
        throw;
      return readCalls;
    }
    throw std::runtime_error("In-flight cancellation returned a digest");
  });
  const auto ready = entered.wait_for(std::chrono::seconds(5));
  // Always release the reader before propagating a failed assertion.
  cancelled.store(true, std::memory_order_relaxed);
  release.set_value();
  require(ready == std::future_status::ready, "Worker did not enter its first read");
  require(task.get() == 1, "In-flight cancellation consumed extra file chunks");
}
} // namespace

int main(int argc, char** argv) {
  try {
    require(argc == 2, "Expected a fixture spanning several read chunks");
    const std::string path(argv[1]);
    std::ifstream stream(path, std::ios::binary);
    const std::string bytes{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
    require(bytes.size() > std::size_t{2} * 64 * 1024, "Cancellation fixture must span three chunks");
    const auto before = descriptorCount();
    for (const auto algorithm : algorithms) {
      const auto seed =
          algorithm == HashAlgorithm::xxh32 ? std::uint64_t{0xffffffffU} : std::uint64_t{0xffffffffffffffffULL};
      for (std::size_t iteration = 0; iteration < 64; ++iteration)
        checkBoundaries(path, bytes, algorithm, seed);
      checkInflight(path, algorithm);
    }
    require(descriptorCount() == before, "File cancellation leaked a descriptor");
    std::cout << "Verified cancellation boundaries and in-flight cleanup: " << checks << " checks\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
