#include "FileDigest.hpp"

#include <array>
#include <cerrno>
#include <fcntl.h>
#include <fstream>
#include <future>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <system_error>
#include <unistd.h>
#include <vector>

namespace {
enum class Fault { none, statError, readError, interruptedRead };
thread_local Fault fault = Fault::none;
thread_local std::size_t readCalls = 0;
thread_local std::size_t bytesRead = 0;

class ScopedFault final {
public:
  explicit ScopedFault(Fault value) {
    fault = value;
    readCalls = 0;
    bytesRead = 0;
  }
  ~ScopedFault() { fault = Fault::none; }
  ScopedFault(const ScopedFault&) = delete;
  ScopedFault& operator=(const ScopedFault&) = delete;
};
} // namespace

int testFstat(int descriptor, struct stat* metadata) {
  if (fault == Fault::statError) {
    errno = EIO;
    return -1;
  }
  return ::fstat(descriptor, metadata);
}

ssize_t testRead(int descriptor, void* bytes, std::size_t size) {
  const auto call = readCalls++;
  if (fault == Fault::readError && bytesRead > 0) {
    errno = EIO;
    return -1;
  }
  if (fault == Fault::interruptedRead && call == 0) {
    errno = EINTR;
    return -1;
  }
  const auto count = ::read(descriptor, bytes, size);
  if (count > 0)
    bytesRead += static_cast<std::size_t>(count);
  return count;
}

// Keep fault injection in this test translation unit. System headers are already
// included, so the production implementation calls these wrappers without
// changing the platform declarations (including Darwin's symbol aliases).
#define fstat testFstat
#define read testRead
// NOLINTNEXTLINE(bugprone-suspicious-include) -- Compile the real implementation with test-local syscall hooks.
#include "../cpp/FileDigest.cpp"
#undef read
#undef fstat

namespace {
using nitro_xxhash::HashAlgorithm;

struct Vector {
  std::string path;
  std::array<std::string, 2> expected;
  std::string bytes;
};

constexpr std::array algorithms{HashAlgorithm::xxh3_64, HashAlgorithm::xxh3_128};

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

std::size_t openDescriptorCount() {
  const auto limit = ::sysconf(_SC_OPEN_MAX);
  require(limit > 0 && limit <= std::numeric_limits<int>::max(), "Invalid descriptor limit");
  std::size_t count = 0;
  for (int descriptor = 0; descriptor < limit; ++descriptor) {
    errno = 0;
    const auto flags = ::fcntl(descriptor, F_GETFD);
    if (flags >= 0)
      ++count;
    else
      require(errno == EBADF, "Cannot inspect file descriptors");
  }
  return count;
}

std::size_t checkDigests(const Vector& vector) {
  for (std::size_t index = 0; index < algorithms.size(); ++index) {
    require(nitro_xxhash::digestFile(vector.path, algorithms[index]) == vector.expected[index],
            "Incorrect file digest during stress test");
    require(nitro_xxhash::digestString(vector.bytes, algorithms[index]) == vector.expected[index],
            "Incorrect in-memory digest during stress test");
  }
  return 4;
}

template <typename Exception, typename Callback> void expectError(Callback callback) {
  try {
    callback();
  } catch (const Exception&) {
    return;
  }
  throw std::runtime_error("Expected hashing failure");
}

void expectIoError(const Vector& vector, HashAlgorithm algorithm, Fault value) {
  const ScopedFault active(value);
  try {
    static_cast<void>(nitro_xxhash::digestFile(vector.path, algorithm));
  } catch (const std::system_error& error) {
    require(error.code().value() == EIO, "Unexpected injected failure");
    if (value == Fault::readError)
      require(bytesRead > 0, "Read failure must follow a successful read");
    return;
  }
  throw std::runtime_error("Expected injected I/O failure");
}

std::size_t checkFailures(const Vector& vector, const std::string& directory) {
  for (const auto algorithm : algorithms) {
    expectError<std::system_error>(
        [&] { static_cast<void>(nitro_xxhash::digestFile(directory + "/missing", algorithm)); });
    expectError<std::invalid_argument>([&] { static_cast<void>(nitro_xxhash::digestFile(directory, algorithm)); });
    expectIoError(vector, algorithm, Fault::statError);
    expectIoError(vector, algorithm, Fault::readError);
  }
  return 8;
}

std::size_t checkInterruptedReads(const Vector& vector) {
  for (std::size_t index = 0; index < algorithms.size(); ++index) {
    const ScopedFault active(Fault::interruptedRead);
    require(nitro_xxhash::digestFile(vector.path, algorithms[index]) == vector.expected[index],
            "Incorrect digest after an interrupted read");
    require(readCalls > 1, "Interrupted read was not retried");
    require(nitro_xxhash::digestString(vector.bytes, algorithms[index]) == vector.expected[index],
            "Incorrect in-memory digest after file I/O");
  }
  return 4;
}

std::vector<Vector> readVectors(int argc, char** argv) {
  require(argc >= 5 && (argc - 2) % 3 == 0, "Expected directory and path/digest64/digest128 triples");
  std::vector<Vector> vectors;
  for (int index = 2; index < argc; index += 3) {
    std::ifstream input(argv[index], std::ios::binary);
    require(static_cast<bool>(input), "Cannot open stress fixture");
    std::string bytes{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
    vectors.push_back({argv[index], {argv[index + 1], argv[index + 2]}, std::move(bytes)});
  }
  return vectors;
}
} // namespace

int main(int argc, char** argv) {
  try {
    const auto vectors = readVectors(argc, argv);
    const auto& streamed = vectors.back();
    require(streamed.bytes.size() > std::size_t{64} * 1024, "Expected a fixture spanning multiple read calls");

    // Warm up runtime facilities before comparing the process descriptor sets.
    static_cast<void>(checkDigests(streamed));
    const auto before = openDescriptorCount();
    std::size_t checks = 0;
    for (std::size_t iteration = 0; iteration < 256; ++iteration) {
      checks += checkDigests(vectors[iteration % vectors.size()]);
      checks += checkFailures(streamed, argv[1]);
      checks += checkInterruptedReads(streamed);
    }
    require(openDescriptorCount() == before, "File descriptor leak after success or error paths");

    constexpr std::size_t workers = 8;
    std::vector<std::future<std::size_t>> tasks;
    tasks.reserve(workers);
    for (std::size_t worker = 0; worker < workers; ++worker) {
      tasks.push_back(std::async(std::launch::async, [&, worker] {
        std::size_t completed = 0;
        for (std::size_t iteration = 0; iteration < 64; ++iteration) {
          completed += checkDigests(vectors[(worker + iteration) % vectors.size()]);
          completed += checkFailures(streamed, argv[1]);
        }
        return completed;
      }));
    }
    for (auto& task : tasks)
      checks += task.get();
    const auto after = openDescriptorCount();
    require(after == before, "File descriptor leak after concurrent hashing");
    std::cout << "{\"checks\":" << checks << ",\"workers\":" << workers << ",\"descriptorsBefore\":" << before
              << ",\"descriptorsAfter\":" << after << "}\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
