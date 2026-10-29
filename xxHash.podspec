require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))
optimize_debug = ENV.fetch('XXHASH_OPTIMIZE_DEBUG', 'YES').strip.upcase
unless ['YES', 'NO'].include?(optimize_debug)
  raise ArgumentError, 'XXHASH_OPTIMIZE_DEBUG must be YES or NO'
end
optimize_release = ENV.fetch('XXHASH_OPTIMIZE_RELEASE', 'YES').strip.upcase
unless ['YES', 'NO'].include?(optimize_release)
  raise ArgumentError, 'XXHASH_OPTIMIZE_RELEASE must be YES or NO'
end

Pod::Spec.new do |s|
  s.name             = 'xxHash'
  s.version          = package['version']
  s.summary          = package['description']
  s.description      = package['description']
  s.license          = { type: package['license'], file: 'LICENSE' }
  s.author           = package['author']
  s.homepage         = package['homepage']
  s.platforms        = { :ios => '15.1' }
  s.source           = { git: 'https://github.com/NikitaDudin/react-native-nitro-xxhash.git', tag: "v#{s.version}" }
  s.static_framework = true

  s.private_header_files = 'cpp/**/*.{h,hpp}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
    # ThreadPool.hpp is private in the required Nitro 0.37.1 dependency.
    'HEADER_SEARCH_PATHS' => '$(inherited) "$(PODS_ROOT)/Headers/Private"',
    'XXHASH_OPTIMIZE_DEBUG' => optimize_debug,
    'XXHASH_DEBUG_KERNEL_FLAGS' => '$(XXHASH_DEBUG_KERNEL_FLAGS_$(CONFIGURATION)_$(XXHASH_OPTIMIZE_DEBUG))',
    'XXHASH_DEBUG_KERNEL_FLAGS_Debug_YES' => '-O2',
    'XXHASH_DEBUG_KERNEL_FLAGS_Debug_NO' => '',
    'XXHASH_DEBUG_KERNEL_FLAGS_Release_YES' => '',
    'XXHASH_DEBUG_KERNEL_FLAGS_Release_NO' => '',
    'XXHASH_OPTIMIZE_RELEASE' => optimize_release,
    'XXHASH_RELEASE_KERNEL_FLAGS' => '$(XXHASH_RELEASE_KERNEL_FLAGS_$(CONFIGURATION)_$(XXHASH_OPTIMIZE_RELEASE))',
    'XXHASH_RELEASE_KERNEL_FLAGS_Debug_YES' => '',
    'XXHASH_RELEASE_KERNEL_FLAGS_Debug_NO' => '',
    'XXHASH_RELEASE_KERNEL_FLAGS_Release_YES' => '-O2',
    'XXHASH_RELEASE_KERNEL_FLAGS_Release_NO' => '',
  }

  load File.join(__dir__, 'nitrogen/generated/ios/xxHash+autolinking.rb')
  s.default_subspecs = 'Core'
  s.subspec 'Core' do |core|
    core.source_files = [
      'cpp/**/*.{h,hpp,cpp}',
      'ios/**/*.{h,m,mm,swift,cpp}',
    ]
    # Exclusions stay local: parent exclusions would also remove Kernels' sources.
    core.exclude_files = ['cpp/FileDigest.cpp', 'cpp/Armv7Neon.cpp']
    core.dependency 'xxHash/Kernels'
    add_nitrogen_files(core)
    # These singleton settings already come from the parent; duplicating them
    # in a subspec makes CocoaPods concatenate their values before merging.
    core.pod_target_xcconfig = core.attributes_hash['pod_target_xcconfig'].reject do |key, _|
      ['CLANG_CXX_LANGUAGE_STANDARD', 'DEFINES_MODULE'].include?(key)
    end
  end
  s.subspec 'Kernels' do |kernels|
    kernels.source_files = ['cpp/FileDigest.cpp', 'cpp/Armv7Neon.cpp']
    kernels.compiler_flags = '$(XXHASH_DEBUG_KERNEL_FLAGS) $(XXHASH_RELEASE_KERNEL_FLAGS)'
  end
end
