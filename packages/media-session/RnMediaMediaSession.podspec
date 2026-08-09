require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnMediaMediaSession"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # iOS only, matching `@rn-media/player` and `@rn-media/audio-session`.
  # MPNowPlayingInfoCenter/MPRemoteCommandCenter exist on tvOS/visionOS too; add
  # those platforms when there is a target that actually builds them.
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/afkcodes/rn-media.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
  ]

  # MediaPlayer vends MPRemoteCommandCenter / MPNowPlayingInfoCenter /
  # MPMediaItemArtwork. UIKit is needed for `UIImage`, which
  # `MPMediaItemArtwork` is built from.
  s.frameworks = "MediaPlayer", "UIKit"

  load 'nitrogen/generated/ios/RnMediaMediaSession+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
