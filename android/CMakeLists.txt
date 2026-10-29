cmake_minimum_required(VERSION 3.22)
project(xxHash)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(XXHASH_OPTIMIZE_DEBUG "Optimize hashing kernels in Android Debug builds" ON)

add_library(xxHash SHARED
  src/main/cpp/JNIOnLoad.cpp
  ../cpp/HybridFileHasher.cpp
  ../cpp/HybridHashState.cpp
  ../cpp/HybridHashFileTask.cpp
  ../cpp/FileDigest.cpp
  ../cpp/FileHashExecutor.cpp
  ../cpp/FilePath.cpp
  ../cpp/Armv7Neon.cpp
)
target_include_directories(xxHash PRIVATE ../cpp)
if(ANDROID_ABI STREQUAL "armeabi-v7a")
  # Never leak NEON instructions into the CPU-detection/scalar path.
  target_compile_options(xxHash PRIVATE -mfpu=vfpv3-d16)
  set_property(SOURCE ../cpp/Armv7Neon.cpp APPEND PROPERTY COMPILE_OPTIONS -mfpu=neon)
endif()
if(XXHASH_OPTIMIZE_DEBUG)
  # Keep the hashing loops fast without optimizing the JSI wrappers or defining NDEBUG.
  set_property(SOURCE ../cpp/FileDigest.cpp ../cpp/Armv7Neon.cpp
    APPEND PROPERTY COMPILE_OPTIONS "$<$<CONFIG:Debug>:-O2>")
endif()
include(${CMAKE_SOURCE_DIR}/../nitrogen/generated/android/xxHash+autolinking.cmake)
