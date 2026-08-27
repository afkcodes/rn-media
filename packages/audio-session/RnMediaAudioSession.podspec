require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnMediaAudioSession"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # iOS only, matching `@afkcodes/timbre-player` and the example app. AVAudioSession
  # does exist on visionOS/tvOS/watchOS; add those platforms when there is a
  # target that actually builds them, not before.
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/afkcodes/timbre.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
  ]

  # `AVAudioSession` is vended by AVFAudio, which the AVFoundation umbrella
  # re-exports; linking AVFoundation is the portable way to get both.
  s.frameworks = "AVFoundation"

  load 'nitrogen/generated/ios/RnMediaAudioSession+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
