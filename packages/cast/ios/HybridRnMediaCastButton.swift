//
//  HybridRnMediaCastButton.swift
//  RnMediaCast
//
//  The iOS half of `<CastButton/>`: Google's own cast button, wrapped as a
//  Nitro HybridView.
//
//  Why the SDK's button and not a `Pressable` calling `showCastPicker()`:
//  `GCKUICastButton` is a `UIButton` subclass (GoogleCast/GCKUICastButton.h:22,
//  umbrella-exported at GoogleCast/GoogleCast.h:68) that owns the cast icon's
//  three states — inactive, connecting animation, connected — and, with its
//  default `triggersDefaultCastDialog == YES` (GCKUICastButton.h:33), presents
//  the framework's own device dialog on tap. That default is deliberately left
//  alone here: it is also the SDK's local-network-permission choreography.
//  Discovery starts on the FIRST TAP of a cast button, never before, so iOS
//  shows its local-network prompt exactly when the user asked for devices —
//  the ordering Google's own checklist requires and the one an app-drawn
//  button gets wrong.
//
//  Threading contract
//  ------------------
//  MAIN THREAD ONLY, guaranteed by the caller rather than defended here: the
//  generated `HybridRnMediaCastButtonComponent.mm` creates this object from
//  `-[RCTViewComponentView init]` and pushes props from `updateProps:oldProps:`,
//  both of which are UIKit-thread only. GoogleCast and UIKit both require it.
//

import Foundation
import GoogleCast
import NitroModules
import UIKit

final class HybridRnMediaCastButton: HybridRnMediaCastButtonSpec {
  /// The SDK's button, sized by React Native's layout like any other view.
  ///
  /// A Nitro view's shadow node is a plain `ConcreteViewShadowNode` — it has no
  /// measure function, so the button has no intrinsic size in the RN tree and
  /// takes exactly the frame `style` gives it. The icon itself is drawn at its
  /// own size, centred; the view's size is the touch target. The JS component
  /// therefore ships a default width/height (see `cast-button.tsx`).
  let view = GCKUICastButton(frame: .zero)

  /// Packed ARGB from `processColor`, or `nil` for "inherit".
  var tintColor: Double? {
    didSet {
      // `nil` restores the inherited tint rather than forcing a colour —
      // `UIView.tintColor = nil` is documented as "use the superview's".
      view.tintColor = tintColor.flatMap(HybridRnMediaCastButton.color(fromPackedARGB:))
    }
  }

  /// `processColor` packs a colour into 0xAARRGGBB (signed on Android, which
  /// is why the negative case is handled) and Nitro carries it as a `Double`.
  private static func color(fromPackedARGB packed: Double) -> UIColor? {
    guard packed.isFinite else { return nil }
    let argb = UInt32(truncatingIfNeeded: Int64(packed))
    return UIColor(
      red: CGFloat((argb >> 16) & 0xFF) / 255,
      green: CGFloat((argb >> 8) & 0xFF) / 255,
      blue: CGFloat(argb & 0xFF) / 255,
      alpha: CGFloat((argb >> 24) & 0xFF) / 255
    )
  }
}
