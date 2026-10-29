#pragma once

#include "HybridFileHasherSpec.hpp"

namespace margelo::nitro::xxhash {
class HybridFileHasher final : public HybridFileHasherSpec {
public:
  HybridFileHasher() : HybridObject(TAG) {}
  std::string getSimdBackend() override;
  std::string hashString(const std::string& input, HashAlgorithm algorithm, const std::string& seed) override;
  std::string hashBuffer(const std::shared_ptr<ArrayBuffer>& input, double byteOffset, double byteLength,
                         HashAlgorithm algorithm, const std::string& seed) override;
  std::shared_ptr<Promise<std::string>> hashFile(const std::string& fileUri, HashAlgorithm algorithm,
                                                 const std::string& seed) override;
  std::shared_ptr<HybridHashStateSpec> createHasher(HashAlgorithm algorithm, const std::string& seed) override;
  std::shared_ptr<HybridHashFileTaskSpec> startFileHash(const std::string& fileUri, HashAlgorithm algorithm,
                                                        const std::string& seed) override;
};
} // namespace margelo::nitro::xxhash
