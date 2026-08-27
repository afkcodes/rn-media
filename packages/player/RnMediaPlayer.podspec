require "json"

package = JSON.parse(File.read(File.join(__dir__, "package.json")))

# --- Prebuilt libmpv --------------------------------------------------------
#
# Download + checksum-verify + extract the pinned libmpv xcframeworks *before*
# the spec below is evaluated, because `vendored_frameworks` is a glob that
# CocoaPods resolves eagerly.
#
# Why `system` at spec-eval time and not `prepare_command`: `prepare_command`
# only runs for pods CocoaPods downloads itself; React Native autolinking wires
# this package in as a `:path` development pod, for which it never runs. Calling
# out to a script here is exactly what media-kit does in
# `libs/ios/media_kit_libs_ios_audio/ios/media_kit_libs_ios_audio.podspec`
# (`system("make")`). Unlike media-kit we hard-fail instead of silently
# continuing with an empty `Frameworks/` dir.
#
# The script is idempotent and caches the download, so repeated `pod install`s
# are cheap. Versions + checksums live in `ios/libmpv.pin` (single source of
# truth). CI runs the same script ahead of `pod install` with a warm cache.
fetch_libmpv = File.join(__dir__, "ios", "fetch-libmpv.sh")
unless system("sh", fetch_libmpv)
  raise "[RnMediaPlayer] #{fetch_libmpv} failed — prebuilt libmpv is unavailable. " \
        "Re-run it manually to see the error, or check ios/libmpv.pin."
end

Pod::Spec.new do |s|
  s.name         = "RnMediaPlayer"
  s.version      = package["version"]
  s.summary      = package["description"]
  s.homepage     = package["homepage"]
  s.license      = package["license"]
  s.authors      = package["author"]

  # iOS only. The pinned libmpv bundle ships `ios-arm64` +
  # `ios-arm64_x86_64-simulator` slices and nothing else — declaring visionOS
  # would produce a pod that cannot link (media-kit/libmpv-darwin-build has no
  # visionOS target). Re-add it when/if upstream builds one.
  #
  # Deployment target: the frameworks' `MinimumOSVersion` is 9.0 (device slice)
  # and 14.0 (simulator slice), both below React Native's
  # `min_ios_version_supported` (15.1 for RN 0.86), so no reconciliation is
  # needed — the binaries never raise our floor.
  s.platforms    = { :ios => min_ios_version_supported }
  s.source       = { :git => "https://github.com/afkcodes/timbre.git", :tag => "#{s.version}" }

  s.source_files = [
    # Implementation (Swift)
    "ios/**/*.{swift}",
    # Autolinking/Registration (Objective-C++)
    "ios/**/*.{m,mm}",
    # Implementation (C++ objects)
    "cpp/**/*.{hpp,cpp}",
  ]
  # `ios/Frameworks` is script-generated; never compile anything found in it.
  # `cpp/tests` is host-only (Linux/CI unit tests) and must never reach an
  # iOS target.
  #
  # The `ios/Frameworks` pattern is deliberately narrowed to compilable
  # extensions instead of a bare `ios/Frameworks/**/*`. CocoaPods applies
  # `exclude_files` to *every* file attribute, `vendored_frameworks` included
  # (`Sandbox::FileAccessor#paths_for_attribute` passes
  # `spec_consumer.exclude_files` for all of them), and `**/*` matches the
  # `.xcframework` bundle directories themselves. That silently emptied
  # `vendored_frameworks`: the app target got no `-framework Mpv` and no
  # `${PODS_XCFRAMEWORKS_BUILD_DIR}/RnMediaPlayer` search path, so every
  # `mpv_*` symbol was undefined at link time (CI run 31320994997).
  # Nothing under `ios/Frameworks` is matched by `source_files` anyway — this
  # pattern is only a guard.
  s.exclude_files = [
    "ios/Frameworks/**/*.{swift,m,mm}",
    "ios/.cache/**/*",
    "cpp/tests/**/*",
  ]

  # Prebuilt libmpv (audio flavour, LGPL `default` build) — see ios/libmpv.pin.
  #
  # These are DYNAMIC frameworks. CocoaPods embeds and re-signs them into the
  # app bundle, which is both the App-Store-accepted way to ship third-party
  # dylibs and what LGPL requires of us: the user must be able to relink against
  # a modified libmpv (PLAN.md §6). Do not convert these to static archives.
  s.vendored_frameworks = "ios/Frameworks/*.xcframework"

  # No `s.libraries` / `s.frameworks` here, deliberately. The vendored dylibs
  # carry their own load commands (AudioToolbox, CoreMedia, CoreVideo,
  # CoreFoundation, libz, libiconv, libSystem) and resolve them at runtime; our
  # own sources call none of those APIs directly. media_kit_libs_ios_audio
  # declares none either. AVFoundation/AVAudioSession belongs to
  # `@timbre/audio-session`, not here.

  s.pod_target_xcconfig = {
    # mpv client API headers. We use the vendored copy in
    # `cpp/third_party/mpv/include` rather than the ones inside
    # `Mpv.framework/Headers` on purpose:
    #   1. `cpp/` is shared with Android, so both platforms must compile against
    #      one header set. As of the 0.41 engine bump that is no longer a
    #      lowest-common-denominator compromise: BOTH platforms ship mpv 0.41.0
    #      (MPV_CLIENT_API_VERSION 2.5) from our two forks, so the vendored copy
    #      is simply *the* header of *the* binary. (It used to be the older of
    #      two: Android 0.35.1/API 2.0 against iOS 0.36.0/API 2.1.)
    #   2. `Mpv.framework/Headers` is flat (`client.h`, not `mpv/client.h`) and
    #      also ships `render.h`/`render_gl.h`; the core must never see those
    #      (CLAUDE.md "Modular"). The vendored dir excludes them by design.
    # `Mpv.framework` still exposes a modulemap, so Swift can `import Mpv` if
    # ever needed.
    "HEADER_SEARCH_PATHS" => '"$(inherited)" "$(PODS_TARGET_SRCROOT)/cpp/third_party/mpv/include"',
  }

  load 'nitrogen/generated/ios/RnMediaPlayer+autolinking.rb'
  add_nitrogen_files(s)

  s.dependency 'React-jsi'
  s.dependency 'React-callinvoker'
  install_modules_dependencies(s)
end
