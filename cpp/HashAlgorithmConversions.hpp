#pragma once

#include "FileDigest.hpp"
#include "HashAlgorithm.hpp"

#include <stdexcept>

namespace margelo::nitro::xxhash {
inline ::nitro_xxhash::HashAlgorithm toCoreAlgorithm(HashAlgorithm algorithm) {
  using CoreAlgorithm = ::nitro_xxhash::HashAlgorithm;
  switch (algorithm) {
  case HashAlgorithm::XXH32:
    return CoreAlgorithm::xxh32;
  case HashAlgorithm::XXH64:
    return CoreAlgorithm::xxh64;
  case HashAlgorithm::XXH3_64:
    return CoreAlgorithm::xxh3_64;
  case HashAlgorithm::XXH3_128:
    return CoreAlgorithm::xxh3_128;
  }
  throw std::invalid_argument("Unsupported xxHash algorithm");
}
} // namespace margelo::nitro::xxhash
