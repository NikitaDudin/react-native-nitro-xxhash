#pragma once

#include "FileDigest.hpp"
#include "HybridHashFileTaskSpec.hpp"

#include <atomic>
#include <memory>

namespace margelo::nitro::xxhash {
class HybridHashFileTask final : public HybridHashFileTaskSpec {
public:
  HybridHashFileTask(std::string fileUri, ::nitro_xxhash::HashAlgorithm algorithm, std::uint64_t seed);
  std::shared_ptr<Promise<std::string>> result() override;
  void cancel() override;

private:
  std::shared_ptr<std::atomic_bool> cancelled_;
  std::shared_ptr<Promise<std::string>> result_;
};
} // namespace margelo::nitro::xxhash
