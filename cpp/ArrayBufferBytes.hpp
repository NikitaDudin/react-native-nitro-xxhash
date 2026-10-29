#pragma once

#include <NitroModules/ArrayBuffer.hpp>

#include <cmath>
#include <cstddef>
#include <memory>
#include <span>
#include <stdexcept>

namespace margelo::nitro::xxhash {
// JS-backed bytes are borrowed only for the duration of a synchronous call.
inline std::span<const std::byte> borrowBufferBytes(const std::shared_ptr<ArrayBuffer>& input, double byteOffset,
                                                    double byteLength) {
  if (!input)
    throw std::invalid_argument("Expected an ArrayBuffer");
  constexpr double maxSafeInteger = 9007199254740991.0;
  for (const double value : {byteOffset, byteLength}) {
    if (!std::isfinite(value) || value < 0 || std::trunc(value) != value || value > maxSafeInteger)
      throw std::invalid_argument("ArrayBuffer byte offset and length must be nonnegative safe integers");
  }
  const auto size = input->size();
  // Compare before either double-to-size_t cast. On 32-bit targets, the
  // backing size is itself the representable bound. Subtraction avoids overflow.
  if (byteOffset > static_cast<double>(size))
    throw std::out_of_range("ArrayBuffer byte offset exceeds its size");
  const auto offset = static_cast<std::size_t>(byteOffset);
  if (byteLength > static_cast<double>(size - offset))
    throw std::out_of_range("ArrayBuffer byte range exceeds its size");
  const auto length = static_cast<std::size_t>(byteLength);
  const auto data = input->data();
  if (size != 0 && data == nullptr)
    throw std::invalid_argument("ArrayBuffer data is unavailable");
  // A deleted/empty JS-backed buffer may have no pointer at all. Avoid even
  // adding zero to nullptr, including inside span::subspan's implementation.
  if (data == nullptr)
    return {};
  return std::as_bytes(std::span(data, size).subspan(offset, length));
}
} // namespace margelo::nitro::xxhash
