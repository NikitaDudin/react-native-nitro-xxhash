#pragma once

#include "FileDigest.hpp"

#include <NitroModules/Promise.hpp>
#include <atomic>
#include <memory>
#include <string>

namespace margelo::nitro::xxhash {
// File I/O has dedicated workers so slow reads do not occupy Nitro's shared pool.
std::shared_ptr<Promise<std::string>> runFileHash(std::string fileUri, ::nitro_xxhash::HashAlgorithm algorithm,
                                                  std::uint64_t seed,
                                                  std::shared_ptr<std::atomic_bool> cancelled = nullptr);
} // namespace margelo::nitro::xxhash
