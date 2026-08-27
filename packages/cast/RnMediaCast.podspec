require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

Pod::Spec.new do |s|
  s.name         = "RnMediaCast"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # NOT the repo-wide 15.1 floor: the google-cast-sdk pod requires iOS 16.0
  # (its own podspec floor since 4.8.x). This is a consumer-visible bump that
  # only apps installing @timbre/cast pay — documented loudly in the README
  # and warned about by the Expo plugin. CocoaPods enforces it at install
  # time, which is the honest failure mode (an app on 15.1 gets a clear
  # resolver error, not a runtime crash).
  s.platforms    = { :ios => "16.0" }
  s.source       = { :git => "https://github.com/afkcodes/timbre.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
  ]

  # Official Google Cast sender SDK, resolved from CocoaPods trunk.
  # 4.8.6 verified latest stable on 2026-08-13 (trunk API:
  # https://trunk.cocoapods.org/api/v1/pods/google-cast-sdk). Pinned to the
  # exact patch because Google's own 4.8.0/4.8.1 broke discovery — the
  # upstream-currency watcher (scripts/check-upstream.mjs) tracks this row, so
  # a lag is surfaced rather than silent.
  #
  # The `google-cast-sdk` flavor bundles the Cast dialog UI (GCKUICastButton,
  # presentCastDialog) that showCastPicker() uses; the `-no-bluetooth` variant
  # exists for apps that must avoid the CoreBluetooth permission prompt and
  # would need a source-level fork of this package to adopt.
  s.dependency 'google-cast-sdk', '4.8.6'

  load 'nitrogen/generated/ios/RnMediaCast+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
