#include "HybridHashState.hpp"
#include "ArrayBufferBytes.hpp"

#include <stdexcept>
#include <utility>

namespace margelo::nitro::xxhash {
HybridHashState::HybridHashState(::nitro_xxhash::HashAlgorithm algorithm, std::uint64_t seed)
    : HybridHashState(algorithm, ::nitro_xxhash::HashState(algorithm, seed)) {}

HybridHashState::HybridHashState(::nitro_xxhash::HashAlgorithm algorithm, ::nitro_xxhash::HashState state)
    : HybridObject(TAG), algorithm_(algorithm), state_(std::make_unique<::nitro_xxhash::HashState>(std::move(state))) {}

::nitro_xxhash::HashState& HybridHashState::activeState() {
  if (!state_)
    throw std::runtime_error("HashState has been disposed");
  return *state_;
}

void HybridHashState::updateString(const std::string& input) { activeState().update(input); }
void HybridHashState::updateBuffer(const std::shared_ptr<ArrayBuffer>& input, double byteOffset, double byteLength) {
  activeState().update(borrowBufferBytes(input, byteOffset, byteLength));
}
std::string HybridHashState::digest() { return activeState().digest(); }
std::shared_ptr<HybridHashStateSpec> HybridHashState::clone() {
  return std::make_shared<HybridHashState>(algorithm_, activeState().clone());
}
void HybridHashState::reset(const std::string& seed) {
  auto& state = activeState();
  state.reset(::nitro_xxhash::parseSeed(seed, algorithm_));
}
void HybridHashState::dispose() { state_.reset(); }
std::size_t HybridHashState::getExternalMemorySize() noexcept { return state_ ? state_->memorySize() : 0; }
} // namespace margelo::nitro::xxhash
