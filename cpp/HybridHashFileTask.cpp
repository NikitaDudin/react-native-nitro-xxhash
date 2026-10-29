#include "HybridHashFileTask.hpp"
#include "FileHashExecutor.hpp"

#include <utility>

namespace margelo::nitro::xxhash {
HybridHashFileTask::HybridHashFileTask(std::string fileUri, ::nitro_xxhash::HashAlgorithm algorithm, std::uint64_t seed)
    : HybridObject(TAG), cancelled_(std::make_shared<std::atomic_bool>(false)),
      result_(runFileHash(std::move(fileUri), algorithm, seed, cancelled_)) {}

std::shared_ptr<Promise<std::string>> HybridHashFileTask::result() { return result_; }
void HybridHashFileTask::cancel() { cancelled_->store(true, std::memory_order_relaxed); }
} // namespace margelo::nitro::xxhash
