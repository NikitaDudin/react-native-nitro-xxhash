#pragma once

#include <unistd.h>

namespace nitro_xxhash {
class FileDescriptor final {
public:
  explicit FileDescriptor(int fd) noexcept : fd_(fd) {}
  ~FileDescriptor() {
    if (fd_ >= 0)
      ::close(fd_);
  }
  FileDescriptor(const FileDescriptor&) = delete;
  FileDescriptor& operator=(const FileDescriptor&) = delete;
  int get() const noexcept { return fd_; }

private:
  int fd_;
};
} // namespace nitro_xxhash
