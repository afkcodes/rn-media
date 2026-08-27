require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnMediaMediaSession"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # iOS only, matching `@timbre/player` and `@timbre/audio-session`.
  # MPNowPlayingInfoCenter/MPRemoteCommandCenter exist on tvOS/visionOS too; add
  # those platforms when there is a target that actually builds them.
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/afkcodes/timbre.git", :tag => "#{s.version}" }

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

  # CarPlay, weakly.
  #
  # The framework ships on every iOS device, so this is not about availability
  # — it is about *entitlement*. A CarPlay app is a managed capability
  # (com.apple.developer.carplay-audio, Apple-approved per app), and the vast
  # majority of apps installing this package will never have it. Weak linking
  # keeps `CarPlay.framework` out of those apps' hard load requirements: the
  # symbols resolve lazily, the scene delegates below are simply never
  # instantiated because nothing in their Info.plist names them, and the app
  # launches exactly as it did before. Every CarPlay symbol this pod touches is
  # iOS 14.0 or earlier, against a 15.1 deployment floor, so no availability
  # guards are needed inside the Swift.
  s.weak_frameworks = "CarPlay"

  load 'nitrogen/generated/ios/RnMediaMediaSession+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
