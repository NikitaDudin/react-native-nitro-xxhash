#pragma once

#include "FileDigest.hpp"
#include "HashStateBackend.hpp"

// Included privately in each backend; XXH_INLINE_ALL keeps symbols local.
#define XXH_INLINE_ALL
#include "FileDescriptor.hpp"
#include "vendor/xxhash.h"

#include <array>
#include <cerrno>
#include <fcntl.h>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <sys/stat.h>
#include <system_error>

namespace {
using nitro_xxhash::HashAlgorithm;

void checkFileHashCancellation(const std::atomic_bool* cancelled) {
  if (cancelled != nullptr && cancelled->load(std::memory_order_relaxed))
    throw nitro_xxhash::FileHashCancelled();
}

void validateSeed(HashAlgorithm algorithm, std::uint64_t seed) {
  switch (algorithm) {
  case HashAlgorithm::xxh32:
    if (seed > std::numeric_limits<std::uint32_t>::max()) {
      throw std::invalid_argument("XXH32 seed must fit in an unsigned 32-bit integer");
    }
    return;
  case HashAlgorithm::xxh64:
  case HashAlgorithm::xxh3_64:
  case HashAlgorithm::xxh3_128:
    return;
  }
  throw std::invalid_argument("Unsupported xxHash algorithm");
}

std::string hexBytes(std::span<const unsigned char> bytes) {
  constexpr char hex[] = "0123456789abcdef";
  std::string result(bytes.size() * 2, '0');
  for (std::size_t i = 0; i < bytes.size(); ++i) {
    result[i * 2] = hex[bytes[i] >> 4U];
    result[i * 2 + 1] = hex[bytes[i] & 15U];
  }
  return result;
}

std::string hexDigest(XXH32_hash_t hash) {
  XXH32_canonical_t canonical{};
  XXH32_canonicalFromHash(&canonical, hash);
  return hexBytes(canonical.digest);
}

std::string hexDigest(XXH64_hash_t hash) {
  XXH64_canonical_t canonical{};
  XXH64_canonicalFromHash(&canonical, hash);
  return hexBytes(canonical.digest);
}

std::string hexDigest(XXH128_hash_t hash) {
  XXH128_canonical_t canonical{};
  XXH128_canonicalFromHash(&canonical, hash);
  return hexBytes(canonical.digest);
}

class BackendHashState final : public nitro_xxhash::detail::HashStateBackend {
public:
  BackendHashState(HashAlgorithm algorithm, std::uint64_t seed) : algorithm_(algorithm) {
    validateSeed(algorithm, seed);
    switch (algorithm) {
    case HashAlgorithm::xxh32:
      state32_.reset(XXH32_createState());
      if (!state32_)
        throw std::bad_alloc();
      break;
    case HashAlgorithm::xxh64:
      state64_.reset(XXH64_createState());
      if (!state64_)
        throw std::bad_alloc();
      break;
    case HashAlgorithm::xxh3_64:
    case HashAlgorithm::xxh3_128:
      state3_.reset(XXH3_createState());
      if (!state3_)
        throw std::bad_alloc();
      break;
    }
    reset(seed);
  }

  void update(std::span<const std::byte> bytes) override {
    XXH_errorcode result = XXH_ERROR;
    switch (algorithm_) {
    case HashAlgorithm::xxh32:
      result = XXH32_update(state32_.get(), bytes.data(), bytes.size());
      break;
    case HashAlgorithm::xxh64:
      result = XXH64_update(state64_.get(), bytes.data(), bytes.size());
      break;
    case HashAlgorithm::xxh3_64:
      result = XXH3_64bits_update(state3_.get(), bytes.data(), bytes.size());
      break;
    case HashAlgorithm::xxh3_128:
      result = XXH3_128bits_update(state3_.get(), bytes.data(), bytes.size());
      break;
    }
    if (result != XXH_OK)
      throw std::runtime_error("xxHash update failed");
  }

  std::string digest() const override {
    switch (algorithm_) {
    case HashAlgorithm::xxh32:
      return hexDigest(XXH32_digest(state32_.get()));
    case HashAlgorithm::xxh64:
      return hexDigest(XXH64_digest(state64_.get()));
    case HashAlgorithm::xxh3_64:
      return hexDigest(XXH3_64bits_digest(state3_.get()));
    case HashAlgorithm::xxh3_128:
      return hexDigest(XXH3_128bits_digest(state3_.get()));
    }
    throw std::invalid_argument("Unsupported xxHash algorithm");
  }

  std::unique_ptr<nitro_xxhash::detail::HashStateBackend> clone() const override {
    auto copy = std::make_unique<BackendHashState>(algorithm_, 0);
    switch (algorithm_) {
    case HashAlgorithm::xxh32:
      XXH32_copyState(copy->state32_.get(), state32_.get());
      break;
    case HashAlgorithm::xxh64:
      XXH64_copyState(copy->state64_.get(), state64_.get());
      break;
    case HashAlgorithm::xxh3_64:
    case HashAlgorithm::xxh3_128:
      XXH3_copyState(copy->state3_.get(), state3_.get());
      break;
    }
    return copy;
  }

  void reset(std::uint64_t seed) override {
    // Validate before mutating an existing state so a failed reset is recoverable.
    validateSeed(algorithm_, seed);
    XXH_errorcode result = XXH_ERROR;
    switch (algorithm_) {
    case HashAlgorithm::xxh32:
      result = XXH32_reset(state32_.get(), static_cast<XXH32_hash_t>(seed));
      break;
    case HashAlgorithm::xxh64:
      result = XXH64_reset(state64_.get(), seed);
      break;
    case HashAlgorithm::xxh3_64:
      result = XXH3_64bits_reset_withSeed(state3_.get(), seed);
      break;
    case HashAlgorithm::xxh3_128:
      result = XXH3_128bits_reset_withSeed(state3_.get(), seed);
      break;
    }
    if (result != XXH_OK)
      throw std::runtime_error("xxHash initialization failed");
  }

  std::size_t memorySize() const noexcept override {
    return sizeof(*this) + (state32_ ? sizeof(XXH32_state_t) : 0) + (state64_ ? sizeof(XXH64_state_t) : 0) +
           (state3_ ? sizeof(XXH3_state_t) : 0);
  }

private:
  HashAlgorithm algorithm_;
  std::unique_ptr<XXH32_state_t, decltype(&XXH32_freeState)> state32_{nullptr, XXH32_freeState};
  std::unique_ptr<XXH64_state_t, decltype(&XXH64_freeState)> state64_{nullptr, XXH64_freeState};
  std::unique_ptr<XXH3_state_t, decltype(&XXH3_freeState)> state3_{nullptr, XXH3_freeState};
};

std::string digestByteContents(std::span<const std::byte> bytes, HashAlgorithm algorithm, std::uint64_t seed) {
  validateSeed(algorithm, seed);
  switch (algorithm) {
  case HashAlgorithm::xxh32:
    return hexDigest(XXH32(bytes.data(), bytes.size(), static_cast<XXH32_hash_t>(seed)));
  case HashAlgorithm::xxh64:
    return hexDigest(XXH64(bytes.data(), bytes.size(), seed));
  case HashAlgorithm::xxh3_64:
    return hexDigest(XXH3_64bits_withSeed(bytes.data(), bytes.size(), seed));
  case HashAlgorithm::xxh3_128:
    return hexDigest(XXH3_128bits_withSeed(bytes.data(), bytes.size(), seed));
  }
  throw std::invalid_argument("Unsupported xxHash algorithm");
}

std::string digestFileContents(const std::string& path, HashAlgorithm algorithm, std::uint64_t seed,
                               const std::atomic_bool* cancelled) {
  using nitro_xxhash::FileDescriptor;
  checkFileHashCancellation(cancelled);
  const FileDescriptor fd(::open(path.c_str(), O_RDONLY | O_CLOEXEC | O_NONBLOCK));
  if (fd.get() < 0)
    throw std::system_error(errno, std::generic_category(), "Cannot open file for xxHash");
  struct stat metadata{};
  if (::fstat(fd.get(), &metadata) < 0)
    throw std::system_error(errno, std::generic_category(), "Cannot stat file for xxHash");
  if (!S_ISREG(metadata.st_mode))
    throw std::invalid_argument("xxHash requires a regular file");

  BackendHashState state(algorithm, seed);
  alignas(64) std::array<std::byte, std::size_t{64} * 1024> buffer;
  for (;;) {
    checkFileHashCancellation(cancelled);
    const auto count = ::read(fd.get(), buffer.data(), buffer.size());
    checkFileHashCancellation(cancelled);
    if (count == 0)
      break;
    if (count < 0) {
      if (errno == EINTR)
        continue;
      throw std::system_error(errno, std::generic_category(), "Cannot read file for xxHash");
    }
    state.update(std::span(buffer.data(), static_cast<std::size_t>(count)));
  }
  checkFileHashCancellation(cancelled);
  auto result = state.digest();
  checkFileHashCancellation(cancelled);
  return result;
}
} // namespace
