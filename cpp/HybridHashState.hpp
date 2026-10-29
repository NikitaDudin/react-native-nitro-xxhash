#pragma once

#include "FileDigest.hpp"
#include "HybridHashStateSpec.hpp"

#include <cstdint>
#include <memory>

namespace margelo::nitro::xxhash {
class HybridHashState final : public HybridHashStateSpec {
public:
  HybridHashState(::nitro_xxhash::HashAlgorithm algorithm, std::uint64_t seed);
  HybridHashState(::nitro_xxhash::HashAlgorithm algorithm, ::nitro_xxhash::HashState state);
  void updateString(const std::string& input) override;
  void updateBuffer(const std::shared_ptr<ArrayBuffer>& input, double byteOffset, double byteLength) override;
  std::string digest() override;
  std::shared_ptr<HybridHashStateSpec> clone() override;
  void reset(const std::string& seed) override;
  void dispose() override;

protected:
  std::size_t getExternalMemorySize() noexcept override;

private:
  ::nitro_xxhash::HashState& activeState();
  ::nitro_xxhash::HashAlgorithm algorithm_;
  std::unique_ptr<::nitro_xxhash::HashState> state_;
};
} // namespace margelo::nitro::xxhash
