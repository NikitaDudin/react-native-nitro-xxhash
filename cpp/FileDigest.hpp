#pragma once

#include <atomic>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>

namespace nitro_xxhash {
enum class HashAlgorithm { xxh32, xxh64, xxh3_64, xxh3_128 };

class FileHashCancelled final : public std::runtime_error {
public:
  FileHashCancelled() : std::runtime_error("File hashing cancelled") {}
};

namespace detail {
class HashStateBackend;
}

// Owns one independent native streaming state. digest() does not consume it.
class HashState final {
public:
  explicit HashState(HashAlgorithm algorithm, std::uint64_t seed = 0);
  ~HashState();
  HashState(const HashState&) = delete;
  HashState& operator=(const HashState&) = delete;
  HashState(HashState&&) noexcept;
  HashState& operator=(HashState&&) noexcept;

  void update(std::span<const std::byte> bytes);
  void update(std::string_view input);
  std::string digest() const;
  HashState clone() const;
  void reset(std::uint64_t seed = 0);
  std::size_t memorySize() const noexcept;

private:
  explicit HashState(std::unique_ptr<detail::HashStateBackend> state);
  std::unique_ptr<detail::HashStateBackend> state_;
};

std::uint64_t parseSeed(std::string_view seed, HashAlgorithm algorithm);
std::string filePath(const std::string& uri);
std::string digestFile(const std::string& uri, HashAlgorithm algorithm, std::uint64_t seed = 0,
                       const std::atomic_bool* cancelled = nullptr);
std::string digestBytes(std::span<const std::byte> bytes, HashAlgorithm algorithm, std::uint64_t seed = 0);
std::string digestString(std::string_view input, HashAlgorithm algorithm, std::uint64_t seed = 0);
std::string simdBackend();
} // namespace nitro_xxhash
