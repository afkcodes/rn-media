//
//  RnMediaWindowSceneDelegate.swift
//  RnMediaMediaSession
//
//  The phone half of adopting UIScene, for as long as React Native needs one.
//

import UIKit

/**
 * Puts a stock React Native app's UI back on the phone's screen once the app
 * has adopted `UIScene`.
 *
 * ## Why this exists at all
 * CarPlay only connects to a scene-based app (F11), and adopting scenes is
 * all-or-nothing: the moment `UIApplicationSceneManifest` appears in
 * `Info.plist`, the window an app made in
 * `application(_:didFinishLaunchingWithOptions:)` is a window attached to no
 * scene, and iOS never displays it. A stock React Native app — which is exactly
 * what `RCTReactNativeFactory.startReactNative(withModuleName:in:)` produces —
 * therefore launches to black on the phone the day CarPlay is switched on, with
 * the car half working perfectly.
 *
 * The fix is the one react-native-carplay has shipped for years: let the app
 * delegate build React Native into its window as before, then **re-parent that
 * window's root view controller** into a window this scene owns. React Native
 * itself never learns that anything happened; a `UIViewController` does not
 * care which window it hangs from.
 *
 * ## This class is temporary, and here is its expiry condition
 * React Native `main` (→ **0.88**) adds
 * `startReactNativeWithModuleName:inWindow:connectionOptions:` to
 * `RCTReactNativeFactory` — the scene-aware entry point, taking the
 * `UIScene.ConnectionOptions` this method already receives. It is **absent from
 * 0.87.1** (F12; verified against the `RCTReactNativeFactory.h` in this repo's
 * `node_modules`, which declares only the `inWindow:` /
 * `inWindow:launchOptions:` / `inWindow:initialProperties:launchOptions:`
 * forms). When the tested React Native version reaches 0.88, this whole class
 * is deleted: apps call that method from their own scene delegate, the
 * re-parenting stops being necessary, and `withCarPlay` writes the app's own
 * delegate name into the window role instead of this one.
 *
 * ## What it deliberately does not do
 * - It does not create a root view controller. If the app delegate did not make
 *   one, there is nothing here to show and inventing a placeholder would hide
 *   the app's own bug behind a blank screen from this package.
 * - It does not touch the app delegate's `window` property. Some apps read it;
 *   re-pointing it at a scene-owned window from a library is a bigger promise
 *   than re-parenting a view controller, and the RN 0.88 path removes the need.
 * - It is only installed when the app has **no** window-scene delegate of its
 *   own. `withCarPlay` leaves an existing one alone, precisely because an app
 *   that wrote one already owns its startup.
 */
@objc(RnMediaWindowSceneDelegate)
public final class RnMediaWindowSceneDelegate: UIResponder, UIWindowSceneDelegate {
  /// `UIWindowSceneDelegate`'s window. iOS reads it; nothing else needs to.
  public var window: UIWindow?

  public func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene else { return }

    // `UIApplicationDelegate.window` is an *optional protocol requirement*, so
    // reading it through the optional delegate yields `UIWindow??` — the outer
    // level is "is there a delegate that implements it", the inner is "is there
    // a window". Both are legitimately absent, hence the double unwrap.
    let existing = UIApplication.shared.delegate?.window ?? nil
    guard let root = existing?.rootViewController else { return }

    let window = UIWindow(windowScene: windowScene)
    // Order matters: the controller has to leave the old window before it can
    // join the new one, or UIKit logs a hierarchy complaint and one of the two
    // windows ends up owning a controller that is not in it.
    existing?.rootViewController = nil
    window.rootViewController = root
    self.window = window
    window.makeKeyAndVisible()
  }
}
