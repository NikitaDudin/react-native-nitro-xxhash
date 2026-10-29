#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <span>
#include <string>

namespace nitro_xxhash::detail {
// A state stays with the CPU backend that allocated and initialized it.
class HashStateBackend {
public:
  virtual ~HashStateBackend() = default;
  virtual void update(std::span<const std::byte> bytes) = 0;
  virtual std::string digest() const = 0;
  virtual std::unique_ptr<HashStateBackend> clone() const = 0;
  virtual void reset(std::uint64_t seed) = 0;
  virtual std::size_t memorySize() const noexcept = 0;
};
} // namespace nitro_xxhash::detail
