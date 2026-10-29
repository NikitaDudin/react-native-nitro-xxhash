#include "FileDigest.hpp"

#if defined(FILE_HASH_FORCE_SCALAR) || (defined(__ANDROID__) && defined(__arm__))
#define XXH_VECTOR 0
#endif
#include "DigestFileImpl.hpp"

#include <charconv>
#include <utility>

#if defined(__ANDROID__) && defined(__arm__)
#include <asm/hwcap.h>
#include <sys/auxv.h>
#endif

namespace nitro_xxhash {
#if defined(__ANDROID__) && defined(__arm__)
std::string digestFileNeon(const std::string& path, HashAlgorithm algorithm, std::uint64_t seed,
                           const std::atomic_bool* cancelled);
std::string digestBytesNeon(std::span<const std::byte> bytes, HashAlgorithm algorithm, std::uint64_t seed);
std::unique_ptr<detail::HashStateBackend> createHashStateNeon(HashAlgorithm algorithm, std::uint64_t seed);
#endif

std::string simdBackend() {
#if defined(FILE_HASH_FORCE_SCALAR)
  return "scalar";
#elif defined(__ANDROID__) && defined(__arm__)
  return (::getauxval(AT_HWCAP) & HWCAP_NEON) != 0 ? "neon" : "scalar";
#elif XXH_VECTOR == XXH_NEON
  return "neon";
#elif XXH_VECTOR == XXH_SSE2
  return "sse2";
#else
  return "scalar";
#endif
}

HashState::HashState(HashAlgorithm algorithm, std::uint64_t seed) {
#if defined(__ANDROID__) && defined(__arm__) && !defined(FILE_HASH_FORCE_SCALAR)
  if (simdBackend() == "neon") {
    state_ = createHashStateNeon(algorithm, seed);
    return;
  }
#endif
  state_ = std::make_unique<BackendHashState>(algorithm, seed);
}

HashState::~HashState() = default;
HashState::HashState(std::unique_ptr<detail::HashStateBackend> state) : state_(std::move(state)) {}
HashState::HashState(HashState&&) noexcept = default;
HashState& HashState::operator=(HashState&&) noexcept = default;
void HashState::update(std::span<const std::byte> bytes) { state_->update(bytes); }
void HashState::update(std::string_view input) { update(std::as_bytes(std::span(input.data(), input.size()))); }
std::string HashState::digest() const { return state_->digest(); }
HashState HashState::clone() const { return HashState(state_->clone()); }
void HashState::reset(std::uint64_t seed) { state_->reset(seed); }
std::size_t HashState::memorySize() const noexcept { return sizeof(*this) + (state_ ? state_->memorySize() : 0); }

std::uint64_t parseSeed(std::string_view seed, HashAlgorithm algorithm) {
  if (seed.empty())
    throw std::invalid_argument("Seed must be an unsigned decimal integer");
  std::uint64_t result = 0;
  const auto parsed = std::from_chars(seed.data(), seed.data() + seed.size(), result, 10);
  if (parsed.ec != std::errc{} || parsed.ptr != seed.data() + seed.size()) {
    throw std::invalid_argument("Seed must be an unsigned decimal integer no greater than 18446744073709551615");
  }
  validateSeed(algorithm, result);
  return result;
}

std::string digestFile(const std::string& uri, HashAlgorithm algorithm, std::uint64_t seed,
                       const std::atomic_bool* cancelled) {
  checkFileHashCancellation(cancelled);
  validateSeed(algorithm, seed);
  const auto path = filePath(uri);
#if defined(__ANDROID__) && defined(__arm__) && !defined(FILE_HASH_FORCE_SCALAR)
  if (simdBackend() == "neon")
    return digestFileNeon(path, algorithm, seed, cancelled);
#endif
  return digestFileContents(path, algorithm, seed, cancelled);
}

std::string digestBytes(std::span<const std::byte> bytes, HashAlgorithm algorithm, std::uint64_t seed) {
#if defined(__ANDROID__) && defined(__arm__) && !defined(FILE_HASH_FORCE_SCALAR)
  if (simdBackend() == "neon")
    return digestBytesNeon(bytes, algorithm, seed);
#endif
  return digestByteContents(bytes, algorithm, seed);
}

std::string digestString(std::string_view input, HashAlgorithm algorithm, std::uint64_t seed) {
  return digestBytes(std::as_bytes(std::span(input.data(), input.size())), algorithm, seed);
}

} // namespace nitro_xxhash
