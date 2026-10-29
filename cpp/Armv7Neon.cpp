// This translation unit alone gets -mfpu=neon on ARMv7.
#if defined(__ANDROID__) && defined(__arm__)
#include "FileDigest.hpp"
#define XXH_VECTOR 4
#include "DigestFileImpl.hpp"

namespace nitro_xxhash {
std::string digestFileNeon(const std::string& path, HashAlgorithm algorithm, std::uint64_t seed,
                           const std::atomic_bool* cancelled) {
  return digestFileContents(path, algorithm, seed, cancelled);
}
std::string digestBytesNeon(std::span<const std::byte> bytes, HashAlgorithm algorithm, std::uint64_t seed) {
  return digestByteContents(bytes, algorithm, seed);
}
std::unique_ptr<detail::HashStateBackend> createHashStateNeon(HashAlgorithm algorithm, std::uint64_t seed) {
  return std::make_unique<BackendHashState>(algorithm, seed);
}
} // namespace nitro_xxhash
#endif
