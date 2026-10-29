#include "FileDigest.hpp"

#include <stdexcept>
#include <string_view>

namespace nitro_xxhash {
namespace {
unsigned int hexDigit(char c) {
  if (c >= '0' && c <= '9')
    return static_cast<unsigned int>(c - '0');
  if (c >= 'a' && c <= 'f')
    return static_cast<unsigned int>(c - 'a' + 10);
  if (c >= 'A' && c <= 'F')
    return static_cast<unsigned int>(c - 'A' + 10);
  throw std::invalid_argument("Invalid percent escape in file URI");
}
} // namespace

std::string filePath(const std::string& uri) {
  if (uri.empty() || uri.find('\0') != std::string::npos) {
    throw std::invalid_argument("Expected a nonempty local file path without NUL bytes");
  }
  if (uri.front() == '/')
    return uri;
  std::string_view path(uri);
  if (path.starts_with("file://localhost/")) {
    path.remove_prefix(16);
  } else if (path.starts_with("file:///")) {
    path.remove_prefix(7);
  } else {
    throw std::invalid_argument("Expected an absolute path or local file:// URI");
  }
  if (path.find_first_of("?#") != std::string_view::npos) {
    throw std::invalid_argument("File URI must percent-encode query and fragment characters");
  }
  std::string decoded;
  decoded.reserve(path.size());
  for (std::size_t i = 0; i < path.size(); ++i) {
    char c = path[i];
    if (c == '%') {
      if (i + 2 >= path.size())
        throw std::invalid_argument("Truncated percent escape in file URI");
      c = static_cast<char>((hexDigit(path[i + 1]) << 4U) | hexDigit(path[i + 2]));
      i += 2;
      if (c == '\0')
        throw std::invalid_argument("File URI must not contain NUL bytes");
    }
    decoded.push_back(c);
  }
  return decoded;
}
} // namespace nitro_xxhash
