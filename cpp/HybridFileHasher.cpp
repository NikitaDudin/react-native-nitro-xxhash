#include "HybridFileHasher.hpp"
#include "ArrayBufferBytes.hpp"
#include "FileDigest.hpp"
#include "FileHashExecutor.hpp"
#include "HashAlgorithmConversions.hpp"
#include "HybridHashFileTask.hpp"
#include "HybridHashState.hpp"

#include <stdexcept>

namespace margelo::nitro::xxhash {
std::string HybridFileHasher::getSimdBackend() { return ::nitro_xxhash::simdBackend(); }

std::string HybridFileHasher::hashString(const std::string& input, HashAlgorithm algorithm, const std::string& seed) {
  const auto coreAlgorithm = toCoreAlgorithm(algorithm);
  return ::nitro_xxhash::digestString(input, coreAlgorithm, ::nitro_xxhash::parseSeed(seed, coreAlgorithm));
}

std::string HybridFileHasher::hashBuffer(const std::shared_ptr<ArrayBuffer>& input, double byteOffset,
                                         double byteLength, HashAlgorithm algorithm, const std::string& seed) {
  const auto coreAlgorithm = toCoreAlgorithm(algorithm);
  return ::nitro_xxhash::digestBytes(borrowBufferBytes(input, byteOffset, byteLength), coreAlgorithm,
                                     ::nitro_xxhash::parseSeed(seed, coreAlgorithm));
}

std::shared_ptr<Promise<std::string>> HybridFileHasher::hashFile(const std::string& fileUri, HashAlgorithm algorithm,
                                                                 const std::string& seed) {
  const auto coreAlgorithm = toCoreAlgorithm(algorithm);
  // Parse on the caller's runtime; only owned native values cross to the worker.
  const auto parsedSeed = ::nitro_xxhash::parseSeed(seed, coreAlgorithm);
  return runFileHash(fileUri, coreAlgorithm, parsedSeed);
}

std::shared_ptr<HybridHashStateSpec> HybridFileHasher::createHasher(HashAlgorithm algorithm, const std::string& seed) {
  const auto coreAlgorithm = toCoreAlgorithm(algorithm);
  return std::make_shared<HybridHashState>(coreAlgorithm, ::nitro_xxhash::parseSeed(seed, coreAlgorithm));
}

std::shared_ptr<HybridHashFileTaskSpec>
HybridFileHasher::startFileHash(const std::string& fileUri, HashAlgorithm algorithm, const std::string& seed) {
  const auto coreAlgorithm = toCoreAlgorithm(algorithm);
  return std::make_shared<HybridHashFileTask>(fileUri, coreAlgorithm, ::nitro_xxhash::parseSeed(seed, coreAlgorithm));
}
} // namespace margelo::nitro::xxhash
