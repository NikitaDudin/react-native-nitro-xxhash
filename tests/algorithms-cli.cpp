#include "FileDigest.hpp"

#include <algorithm>
#include <array>
#include <fstream>
#include <iostream>
#include <iterator>
#include <limits>
#include <stdexcept>
#include <utility>

namespace {
using nitro_xxhash::HashAlgorithm;
using nitro_xxhash::HashState;

void require(bool condition, const char* message) {
  if (!condition)
    throw std::runtime_error(message);
}

template <typename Callback> void expectInvalid(Callback callback) {
  try {
    callback();
  } catch (const std::invalid_argument&) {
    return;
  }
  throw std::runtime_error("Expected invalid argument");
}

HashAlgorithm algorithmFromName(std::string_view name) {
  if (name == "xxh32")
    return HashAlgorithm::xxh32;
  if (name == "xxh64")
    return HashAlgorithm::xxh64;
  if (name == "xxh3-64")
    return HashAlgorithm::xxh3_64;
  if (name == "xxh3-128")
    return HashAlgorithm::xxh3_128;
  throw std::invalid_argument("Unsupported test algorithm");
}

void checkSeeds() {
  using nitro_xxhash::parseSeed;
  constexpr auto max64 = std::numeric_limits<std::uint64_t>::max();
  constexpr auto max32 = std::numeric_limits<std::uint32_t>::max();
  require(parseSeed("0", HashAlgorithm::xxh32) == 0, "Zero seed mismatch");
  require(parseSeed("4294967295", HashAlgorithm::xxh32) == max32, "Max 32-bit seed mismatch");
  require(parseSeed("9007199254740993", HashAlgorithm::xxh64) == 9007199254740993ULL, "Seed lost precision");
  require(parseSeed("18446744073709551615", HashAlgorithm::xxh3_128) == max64, "Max 64-bit seed mismatch");
  for (const auto value : {"", "-1", "+1", " 1", "1 ", "1.0", "1e2", "0x10", "18446744073709551616"}) {
    expectInvalid([&] { static_cast<void>(parseSeed(value, HashAlgorithm::xxh64)); });
  }
  expectInvalid([&] { static_cast<void>(parseSeed(std::string_view("1\0x", 3), HashAlgorithm::xxh64)); });
  expectInvalid([&] { static_cast<void>(parseSeed("4294967296", HashAlgorithm::xxh32)); });
  expectInvalid([&] { static_cast<void>(nitro_xxhash::digestString("abc", HashAlgorithm::xxh32, max64)); });
  expectInvalid([&] { HashState invalid(HashAlgorithm::xxh32, max64); });
  // Deliberately exercise the native invalid-enum rejection contract.
  // NOLINTNEXTLINE(clang-analyzer-optin.core.EnumCastOutOfRange)
  expectInvalid([&] { HashState invalid(static_cast<HashAlgorithm>(-1)); });
  HashState state(HashAlgorithm::xxh32, 1);
  state.update("abc");
  const auto before = state.digest();
  expectInvalid([&] { state.reset(max64); });
  require(state.digest() == before, "Failed reset changed the state");
}

void checkVector(HashAlgorithm algorithm, std::uint64_t seed, const std::string& path, const std::string& expected) {
  using namespace nitro_xxhash;
  std::ifstream input(path, std::ios::binary);
  require(static_cast<bool>(input), "Cannot open test input");
  const std::string data{std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  const auto bytes = std::as_bytes(std::span(data.data(), data.size()));
  const auto padded = std::string("_") + data;
  require(digestBytes(bytes, algorithm, seed) == expected, "Seeded buffer vector mismatch");
  require(digestBytes(std::as_bytes(std::span(padded.data() + 1, data.size())), algorithm, seed) == expected,
          "Unaligned seeded buffer mismatch");
  require(digestString(data, algorithm, seed) == expected, "Seeded string vector mismatch");
  require(digestFile(path, algorithm, seed) == expected, "Seeded file vector mismatch");

  constexpr std::array<std::size_t, 15> chunks{1,   3,    7,    16,    31,    64,    127,   240,
                                               241, 1024, 4096, 65535, 65536, 65537, 131073};
  HashState state(algorithm, seed);
  HashState independent(algorithm, seed);
  const auto empty = digestString("", algorithm, seed);
  require(state.digest() == empty, "Initial digest mismatch");
  state.update(std::span<const std::byte>{});
  state.update(std::string_view{});
  require(state.digest() == empty, "Empty update changed digest");
  for (const auto chunkSize : chunks) {
    state.reset(seed);
    for (std::size_t offset = 0; offset < data.size(); offset += chunkSize) {
      const auto count = std::min(chunkSize, data.size() - offset);
      if ((offset / chunkSize) % 2 == 0)
        state.update(bytes.subspan(offset, count));
      else
        state.update(std::string_view(data).substr(offset, count));
      // Digest during a partial update must never finalize the streaming state.
      if (offset == 0)
        require(state.digest() == digestBytes(bytes.first(count), algorithm, seed), "Partial digest mismatch");
    }
    require(state.digest() == expected, "Chunked digest mismatch");
    require(state.digest() == expected, "Repeated digest consumed state");
    require(independent.digest() == empty, "Independent state was mutated");
  }
  const auto split = data.size() / 2;
  state.reset(seed);
  state.update(bytes.first(split));
  static_cast<void>(state.digest());
  state.update(bytes.subspan(split));
  require(state.digest() == expected, "Update after digest mismatch");
  state.reset(0);
  state.update(data);
  require(state.digest() == digestString(data, algorithm), "Reset with changed seed mismatch");
  state.reset(seed);
  state.update(data);
  require(state.digest() == expected, "Reset did not restore seed");
  constexpr std::array<std::size_t, 13> cloneOffsets{0, 1, 15, 16, 31, 32, 63, 64, 239, 240, 241, 1024, 65536};
  for (const auto offset : cloneOffsets) {
    if (offset > data.size())
      break;
    HashState prefix(algorithm, seed);
    prefix.update(bytes.first(offset));
    auto first = prefix.clone();
    auto second = first.clone();
    const auto partial = prefix.digest();
    require(first.digest() == partial && second.digest() == partial, "Clone did not preserve partial state");
    prefix.update(bytes.subspan(offset));
    require(prefix.digest() == expected, "Cloning changed the original digest");
    first.update("suffix");
    const auto changed = data.substr(0, offset) + "suffix";
    require(first.digest() == digestString(changed, algorithm, seed), "Clone update lost its original seed or prefix");
    require(second.digest() == partial, "Updating a clone mutated its sibling");
    first.reset(0);
    first.update(data);
    require(first.digest() == digestString(data, algorithm), "Clone reset did not change its seed");
    require(second.digest() == partial && prefix.digest() == expected, "Resetting a clone mutated another state");
  }
  auto surviving = [&] {
    HashState owner(algorithm, seed);
    owner.update(data);
    return owner.clone();
  }();
  require(surviving.digest() == expected, "Clone depends on destroyed original state");
  surviving.update("after-disposal");
  require(surviving.digest() == digestString(data + "after-disposal", algorithm, seed),
          "Clone cannot update after the original has been destroyed");
  HashState moved(std::move(state));
  require(moved.digest() == expected, "Moving state changed digest");
}
} // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 1) {
      checkSeeds();
      std::cout << "seed-validation-ok\n";
    } else {
      require(argc == 5, "Expected algorithm, seed, fixture path and expected digest");
      const auto algorithm = algorithmFromName(argv[1]);
      const auto seed = nitro_xxhash::parseSeed(argv[2], algorithm);
      checkVector(algorithm, seed, argv[3], argv[4]);
      std::cout << "ok\n";
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
