#include <atomic>
#include <cerrno>
#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <pthread.h>

namespace {
std::atomic<std::size_t> attempts{0};
std::atomic<std::size_t> failAt{0};

bool shouldFail() {
  const auto attempt = attempts.fetch_add(1, std::memory_order_relaxed) + 1;
  if (attempt != failAt.load(std::memory_order_relaxed)) {
    return false;
  }
  std::fprintf(stderr, "INJECTED pthread_create EAGAIN at %zu\n", attempt);
  return true;
}
} // namespace

// The executable resets the hook after runtime/sanitizer initialization. Only
// its own child process receives this library through the loader environment.
extern "C" void nitroTestResetThreadFailure(std::size_t ordinal) {
  attempts.store(0, std::memory_order_relaxed);
  failAt.store(ordinal, std::memory_order_relaxed);
}

extern "C" void nitroTestSetThreadFailure(std::size_t ordinal) { failAt.store(ordinal, std::memory_order_relaxed); }

extern "C" std::size_t nitroTestThreadAttempts() { return attempts.load(std::memory_order_relaxed); }

#if defined(__APPLE__)
extern "C" int nitroTestCreateThread(pthread_t* thread, const pthread_attr_t* attributes, void* (*entry)(void*),
                                     void* context) {
  if (shouldFail()) {
    return EAGAIN;
  }
  // Calls from the interposing image continue to the real libSystem symbol.
  return pthread_create(thread, attributes, entry, context);
}

__attribute__((used)) static const struct {
  const void* replacement;
  const void* original;
} interpose __attribute__((section("__DATA,__interpose"))) = {reinterpret_cast<const void*>(&nitroTestCreateThread),
                                                              reinterpret_cast<const void*>(&pthread_create)};
#elif defined(__linux__)
extern "C" int pthread_create(pthread_t* thread, const pthread_attr_t* attributes, void* (*entry)(void*),
                              void* context) noexcept {
  if (shouldFail()) {
    return EAGAIN;
  }
  using CreateThread = int (*)(pthread_t*, const pthread_attr_t*, void* (*)(void*), void*);
  static const auto createThread = reinterpret_cast<CreateThread>(dlsym(RTLD_NEXT, "pthread_create"));
  if (createThread == nullptr) {
    std::fputs("Cannot resolve the real pthread_create\n", stderr);
    std::_Exit(90);
  }
  return createThread(thread, attributes, entry, context);
}
#else
#error "Thread creation fault injection supports macOS and Linux"
#endif
