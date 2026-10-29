#include "FileDigest.hpp"

#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>

int main(int argc, char** argv) {
  try {
    using namespace nitro_xxhash;
    if (argc == 1) {
      std::cout << simdBackend() << '\n';
      return 0;
    }
    if (argc != 4)
      throw std::invalid_argument("Expected mode, width and file path");
    const std::string_view mode(argv[1]);
    const std::string_view bits(argv[2]);
    if (bits != "64" && bits != "128")
      throw std::invalid_argument("Expected 64 or 128 bits");
    const auto algorithm = bits == "64" ? HashAlgorithm::xxh3_64 : HashAlgorithm::xxh3_128;
    if (mode == "file") {
      std::cout << digestFile(argv[3], algorithm) << '\n';
    } else {
      std::ifstream stream(argv[3], std::ios::binary);
      if (!stream)
        throw std::runtime_error("Cannot open test input");
      const std::string data{std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>()};
      if (mode == "string") {
        std::cout << digestString(data, algorithm) << '\n';
      } else if (mode == "unaligned") {
        const auto padded = std::string("_") + data;
        std::cout << digestBytes(std::as_bytes(std::span(padded.data() + 1, data.size())), algorithm) << '\n';
      } else if (mode == "bytes") {
        std::cout << digestBytes(std::as_bytes(std::span(data.data(), data.size())), algorithm) << '\n';
      } else {
        throw std::invalid_argument("Unknown mode");
      }
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
