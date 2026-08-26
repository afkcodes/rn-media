//
//  RnMediaCarPlaySceneDelegate.swift
//  RnMediaMediaSession
//
//  The head unit's scene delegate, named in the app's Info.plist.
//

import CarPlay
import UIKit

/**
 * The CarPlay scene delegate `@rn-media/media-session` ships so an app does not
 * have to write one.
 *
 * ## Why it is `@objc` with a bare name
 * iOS instantiates this class **by string**, from the app's
 * `UIApplicationSceneManifest` (F11). A Swift class is registered with the
 * Objective-C runtime as `<Module>.<Class>`, so without the explicit
 * `@objc(RnMediaCarPlaySceneDelegate)` the lookup finds nothing and CarPlay
 * connects a scene with no delegate — a head unit that shows the app's icon and
 * then a blank screen, with no error anywhere. The Expo plugin
 * (`withCarPlay`) and the README's bare-RN snippet both write exactly this
 * string.
 *
 * ## Why it survives the linker
 * Nothing in the app *references* this class — the plist does. In a statically
 * linked pod that is normally an invitation to dead-strip it, which is why
 * React Native's own `OTHER_LDFLAGS` carry `-ObjC`: it force-loads every object
 * file that defines an Objective-C class, and an `@objc` Swift class is one. An
 * app that removes `-ObjC` will find CarPlay silently inert.
 *
 * ## What it does not do
 * It does not start React Native, own any state, or know what a browse tree is.
 * The scene's lifetime and the session's are independent — the car can connect
 * before the app's JavaScript has run and stay connected after `stopService` —
 * so everything lives in ``CarPlayCoordinator`` and the two find each other
 * through ``CarPlayLink``.
 */
@objc(RnMediaCarPlaySceneDelegate)
public final class RnMediaCarPlaySceneDelegate: UIResponder,
  CPTemplateApplicationSceneDelegate
{
  /// The car connected and handed us its interface controller.
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didConnect interfaceController: CPInterfaceController
  ) {
    CarPlayCoordinator.shared.attach(interfaceController: interfaceController)
  }

  /**
   * The car went away.
   *
   * This is the **audio-app** disconnect callback. The `didDisconnect:from:`
   * variant that also carries a `CPWindow` belongs to *navigation* apps, which
   * draw a map into that window; an audio app is given templates only, so
   * implementing it would be implementing a callback that never fires here
   * (developer.apple.com/documentation/carplay/cptemplateapplicationscenedelegate,
   * read 2026-08-26).
   */
  public func templateApplicationScene(
    _ templateApplicationScene: CPTemplateApplicationScene,
    didDisconnectInterfaceController interfaceController: CPInterfaceController
  ) {
    CarPlayCoordinator.shared.detach()
  }
}
