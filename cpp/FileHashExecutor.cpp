#include "FileHashExecutor.hpp"

#include <NitroModules/ThreadPool.hpp>
#include <exception>
#include <utility>

namespace margelo::nitro::xxhash {
std::shared_ptr<Promise<std::string>> runFileHash(std::string fileUri, ::nitro_xxhash::HashAlgorithm algorithm,
                                                  std::uint64_t seed, std::shared_ptr<std::atomic_bool> cancelled) {
  static ThreadPool workers("xxhash-file", 2, 2);
  auto result = Promise<std::string>::create();
  // The helper is the async adapter for our owned pool. Every worker path settles
  // once, and only owned native values cross the boundary.
  workers.run([fileUri = std::move(fileUri), algorithm, seed, cancelled = std::move(cancelled), result] {
    try {
      result->resolve(::nitro_xxhash::digestFile(fileUri, algorithm, seed, cancelled.get()));
    } catch (...) {
      result->reject(std::current_exception());
    }
  });
  return result;
}
} // namespace margelo::nitro::xxhash
