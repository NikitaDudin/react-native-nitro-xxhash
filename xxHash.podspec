require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

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

  s.source_files = [
    'cpp/**/*.{h,hpp,cpp}',
    'ios/**/*.{h,m,mm,swift,cpp}',
  ]

  s.private_header_files = 'cpp/**/*.{h,hpp}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule',
    'CLANG_CXX_LANGUAGE_STANDARD' => 'c++20',
  }

  load File.join(__dir__, 'nitrogen/generated/ios/xxHash+autolinking.rb')
  add_nitrogen_files(s)
end
