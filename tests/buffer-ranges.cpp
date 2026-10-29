#include "ArrayBufferBytes.hpp"
#include "FileDigest.hpp"

#include <array>
#include <cstdint>
#include <iostream>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace {
using margelo::nitro::ArrayBuffer;
using margelo::nitro::xxhash::borrowBufferBytes;
using nitro_xxhash::HashAlgorithm;
using nitro_xxhash::HashState;

constexpr std::array algorithms{HashAlgorithm::xxh32, HashAlgorithm::xxh64, HashAlgorithm::xxh3_64,
                                HashAlgorithm::xxh3_128};
constexpr std::array<std::size_t, 4> hexLengths{8, 16, 16, 32};
constexpr std::array goldenHelloWorldSeed42{"fbd4e574", "69c2b68f9d9352a1", "972a5725e93d338e",
                                            "5a5ecb4a698378a282c1ce3b43a636ba"};
std::size_t checks = 0;

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
  ++checks;
}

template <typename Callback> void expectInvalidRange(Callback callback) {
  try {
    callback();
  } catch (const std::invalid_argument&) {
    ++checks;
    return;
  } catch (const std::out_of_range&) {
    ++checks;
    return;
  }
  throw std::runtime_error("Expected invalid byte range");
}

// Uses the real Nitro base class, including its real JSI MutableBuffer base.
// It models a JS-backed buffer whose memory is no longer available.
class UnavailableBuffer final : public ArrayBuffer {
public:
  explicit UnavailableBuffer(std::size_t size) : size_(size) {}
  std::uint8_t* data() override { return nullptr; }
  std::size_t size() const override { return size_; }
  bool isOwner() const noexcept override { return false; }

private:
  std::size_t size_;
};

// Invalid metadata must be rejected before touching or constructing a span over
// the backing memory. This also exercises 32-bit size bounds on a 64-bit host.
class MetadataOnlyBuffer final : public ArrayBuffer {
public:
  explicit MetadataOnlyBuffer(std::size_t size) : size_(size) {}
  std::uint8_t* data() override { throw std::runtime_error("Invalid range touched buffer data"); }
  std::size_t size() const override { return size_; }
  bool isOwner() const noexcept override { return false; }

private:
  std::size_t size_;
};

void checkExactNativeOwnedRanges() {
  // ArrayBuffer::allocate and NativeArrayBuffer are the actual Nitro implementation.
  const auto buffer = ArrayBuffer::allocate(4099);
  require(buffer->isOwner(), "Expected real Nitro-owned memory");
  for (std::size_t index = 0; index < buffer->size(); ++index)
    buffer->data()[index] = static_cast<std::uint8_t>((index * 131 + 17) % 256);
  constexpr std::array<std::size_t, 12> lengths{0, 1, 3, 4, 7, 16, 31, 64, 127, 240, 241, 4096};
  for (const auto offset : {0U, 1U, 2U, 3U}) {
    for (const auto length : lengths) {
      const auto owners = buffer.use_count();
      const auto bytes = borrowBufferBytes(buffer, offset, static_cast<double>(length));
      require(bytes.data() == reinterpret_cast<const std::byte*>(buffer->data()) + offset,
              "Borrowed range was copied or has the wrong offset");
      require(bytes.size() == length, "Borrowed range has the wrong length");
      require(buffer.use_count() == owners, "Borrowed span retained its buffer");
      const auto expected = std::as_bytes(std::span(buffer->data() + offset, length));
      for (std::size_t algorithm = 0; algorithm < algorithms.size(); ++algorithm) {
        const auto actual = nitro_xxhash::digestBytes(bytes, algorithms[algorithm], 42);
        require(actual == nitro_xxhash::digestBytes(expected, algorithms[algorithm], 42),
                "Range digest differs from exact source bytes");
        require(actual.size() == hexLengths[algorithm], "Unexpected digest hex length");
        HashState state(algorithms[algorithm], 42);
        state.update(bytes);
        require(state.digest() == actual, "Streaming update did not consume the exact range");
      }
    }
  }
  const auto end = borrowBufferBytes(buffer, static_cast<double>(buffer->size()), 0);
  require(end.empty(), "Zero length at end must be allowed");
  require(end.data() == reinterpret_cast<const std::byte*>(buffer->data()) + buffer->size(),
          "End range must retain the one-past-end pointer");

  const auto bytes = borrowBufferBytes(buffer, 1, 3);
  buffer->data()[1] = 255;
  require(bytes.front() == std::byte{255}, "Borrowed range was a hidden copy");

  const auto empty = ArrayBuffer::allocate(0);
  require(empty->isOwner(), "Expected a native-owned empty buffer");
  require(borrowBufferBytes(empty, 0, 0).empty(), "Native-owned empty range must be allowed");
}

void checkSentinelGoldenVectors() {
  constexpr std::string_view payload = "hello world";
  std::vector<std::uint8_t> storage{0xff};
  storage.insert(storage.end(), payload.begin(), payload.end());
  storage.push_back(0xfe);
  const auto buffer = ArrayBuffer::move(std::move(storage));
  const auto bytes = borrowBufferBytes(buffer, 1, static_cast<double>(payload.size()));
  for (std::size_t index = 0; index < algorithms.size(); ++index) {
    require(nitro_xxhash::digestBytes(bytes, algorithms[index], 42) == goldenHelloWorldSeed42[index],
            "Sentinel bytes leaked into the seeded golden digest");
    require(nitro_xxhash::digestBytes(borrowBufferBytes(buffer, 0, static_cast<double>(buffer->size())),
                                      algorithms[index], 42) != goldenHelloWorldSeed42[index],
            "Sentinel fixture must distinguish full backing allocation");
    HashState state(algorithms[index], 42);
    state.update(borrowBufferBytes(buffer, 1, 5));
    state.update(borrowBufferBytes(buffer, 6, 6));
    require(state.digest() == goldenHelloWorldSeed42[index], "Chunked sentinel range digest mismatch");
  }
  require(nitro_xxhash::digestBytes(bytes, HashAlgorithm::xxh3_64) ==
              nitro_xxhash::digestString(payload, HashAlgorithm::xxh3_64),
          "Seed-zero XXH3-64 must consume the exact range");
  require(nitro_xxhash::digestBytes(bytes, HashAlgorithm::xxh3_128) ==
              nitro_xxhash::digestString(payload, HashAlgorithm::xxh3_128),
          "Seed-zero XXH3-128 must consume the exact range");
}

void checkInvalidRangesAndStateRecovery() {
  const auto buffer = ArrayBuffer::allocate(16);
  const auto infinity = std::numeric_limits<double>::infinity();
  const auto nan = std::numeric_limits<double>::quiet_NaN();
  constexpr double maxSafeInteger = 9007199254740991.0;
  const std::array invalid{
      std::pair{-1.0, 0.0},
      std::pair{0.0, -1.0},
      std::pair{0.5, 1.0},
      std::pair{0.0, 1.5},
      std::pair{nan, 0.0},
      std::pair{0.0, nan},
      std::pair{infinity, 0.0},
      std::pair{0.0, infinity},
      std::pair{-infinity, 0.0},
      std::pair{0.0, -infinity},
      std::pair{17.0, 0.0},
      std::pair{0.0, 17.0},
      std::pair{16.0, 1.0},
      std::pair{15.0, 2.0},
      std::pair{maxSafeInteger, 1.0},
      std::pair{1.0, maxSafeInteger},
      std::pair{maxSafeInteger + 1.0, 0.0},
      std::pair{0.0, maxSafeInteger + 1.0},
      std::pair{18446744073709551616.0, 0.0},
  };
  for (const auto algorithm : algorithms) {
    HashState state(algorithm, 42);
    state.update("prefix");
    const auto before = state.digest();
    for (const auto [offset, length] : invalid) {
      expectInvalidRange([&] { state.update(borrowBufferBytes(buffer, offset, length)); });
      require(state.digest() == before, "Invalid update changed existing stream state");
    }
    state.update("suffix");
    require(state.digest() == nitro_xxhash::digestString("prefixsuffix", algorithm, 42),
            "State did not recover after rejected ranges");
  }
  const std::shared_ptr<ArrayBuffer> null;
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(null, 0, 0)); });
  const auto unavailable = std::make_shared<UnavailableBuffer>(16);
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(unavailable, 0, 1)); });
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(unavailable, 16, 0)); });
  const auto empty = std::make_shared<UnavailableBuffer>(0);
  const auto bytes = borrowBufferBytes(empty, 0, 0);
  require(bytes.empty() && bytes.data() == nullptr, "Null empty data must yield a safe empty span");
  for (const auto algorithm : algorithms)
    require(nitro_xxhash::digestBytes(bytes, algorithm, 42) == nitro_xxhash::digestString("", algorithm, 42),
            "Null empty span hashing mismatch");
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(empty, 1, 0)); });
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(empty, 0, 1)); });

  const auto bounded32 = std::make_shared<MetadataOnlyBuffer>(std::numeric_limits<std::uint32_t>::max());
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(bounded32, 4294967296.0, 0)); });
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(bounded32, 0, 4294967296.0)); });
  expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(bounded32, 4294967295.0, 1)); });
  if constexpr (sizeof(std::size_t) > sizeof(std::uint32_t)) {
    const auto boundedSafe = std::make_shared<MetadataOnlyBuffer>(static_cast<std::size_t>(maxSafeInteger));
    expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(boundedSafe, maxSafeInteger, 1)); });
    expectInvalidRange([&] { static_cast<void>(borrowBufferBytes(boundedSafe, 1, maxSafeInteger)); });
  }
}
} // namespace

int main() {
  try {
    checkExactNativeOwnedRanges();
    checkSentinelGoldenVectors();
    checkInvalidRangesAndStateRecovery();
    std::cout << "Verified " << checks << " native buffer range checks\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
