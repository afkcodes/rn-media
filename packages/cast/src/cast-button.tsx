import React from 'react'
import {
  processColor,
  StyleSheet,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import {
  getHostComponent,
  type HybridViewMethods,
} from 'react-native-nitro-modules'

import { castButtonViewConfig } from './cast-button-config'
import type { RnMediaCastButtonProps } from './specs/cast-button.nitro'
import { useCastState } from './use-cast-state'

const NativeCastButton = getHostComponent<
  RnMediaCastButtonProps,
  HybridViewMethods
>('RnMediaCastButton', () => castButtonViewConfig)

/** Props of {@link CastButton}. */
export interface CastButtonProps {
  /**
   * Standard React Native view style.
   *
   * A Nitro view has no intrinsic size in the RN layout tree, so the button is
   * exactly as big as its style says; it defaults to 40×40 (a comfortable
   * touch target around the platform's own 24 pt/dp cast icon, which is drawn
   * centred at its own size and never scaled). Anything you pass is merged
   * over that default.
   */
  style?: StyleProp<ViewStyle>
  /**
   * Colour of the cast icon. Any React Native colour value; omit to inherit
   * the platform default.
   *
   * Honoured on **both** platforms, by different means: iOS sets the
   * `GCKUICastButton`'s `tintColor` (the SDK renders its single-colour icons
   * through it); Android recolours the drawn icon, because
   * `MediaRouteButton` reads its tint from the theme attribute
   * `mediaRouteButtonTint` once at construction and exposes no per-instance
   * setter. Both keep the framework's own icon, including the connecting
   * animation and the connected state.
   */
  tintColor?: ColorValue
}

/**
 * The platform's own Cast button.
 *
 * This is the affordance Google's [Cast Design
 * Checklist](https://developers.google.com/cast/docs/design_checklist)
 * expects, and using it is not cosmetic — each platform's button is wired to
 * something an app-drawn button cannot reach:
 *
 * - **Android** — a `MediaRouteButton` set up through
 *   `CastButtonFactory.setUpMediaRouteButton`. On Android 13+ (with the
 *   `MediaTransferReceiver` this package documents) a tap opens the **system
 *   output switcher**, the same sheet the volume rocker and the media
 *   notification open, so casting starts where users already look for it.
 *   Below 13 it opens the in-app `MediaRouteChooserDialog`.
 * - **iOS** — a `GCKUICastButton` presenting the framework's own device
 *   dialog. Discovery starts on the first tap by SDK design, which is what
 *   makes the iOS local-network permission prompt appear when the user asked
 *   for devices rather than at launch.
 *
 * Either way the session that starts is an ordinary cast session: a
 * `wireCastHandoff` machine already wired up picks it up and runs the handoff,
 * exactly as if you had called `handoff.castTo(id)`.
 *
 * **Renders nothing while cast is unavailable** — before `Cast.initialize()`
 * has resolved, and forever on a device without Google Play services. That is
 * the checklist's own rule ("hide the cast icon when there is nothing to cast
 * to"), applied for you; in dev builds a one-time warning explains the empty
 * space if `initialize()` was never called.
 *
 * Prefer this to a hand-drawn button. `Cast.requestSession()` and your own
 * device sheet built on `getCastDevices()` remain fully supported for apps
 * that want their own picker — they just do not get the system switcher.
 *
 * @example
 * ```tsx
 * <CastButton style={{ width: 32, height: 32 }} tintColor="#e7e7ea" />
 * ```
 */
export function CastButton({
  style,
  tintColor,
}: CastButtonProps): React.JSX.Element | null {
  const state = useCastState()
  if (state === 'unavailable') {
    warnOnceIfNeverInitialized()
    return null
  }
  return (
    <NativeCastButton
      style={[styles.button, style]}
      tintColor={packColor(tintColor)}
    />
  )
}

/**
 * `processColor` returns either a packed ARGB number or an opaque
 * `PlatformColor`/`DynamicColorIOS` object. Only the number can cross to a
 * `double` prop; a platform colour is dropped to the inherited tint rather
 * than being mangled into a wrong colour.
 */
function packColor(color: ColorValue | undefined): number | undefined {
  if (color === undefined) return undefined
  const processed = processColor(color)
  return typeof processed === 'number' ? processed : undefined
}

let warned = false

function warnOnceIfNeverInitialized(): void {
  if (warned || !__DEV__) return
  warned = true
  // Not an error: 'unavailable' is also the honest answer on a GMS-less
  // device, and it is the state before `initialize()` resolves. But a
  // <CastButton/> that never appears is confusing enough to earn one line.
  console.warn(
    '[@timbre/cast] <CastButton/> renders nothing while the cast state is ' +
      "'unavailable'. That is expected on a device without Google Play " +
      'services, and until `Cast.initialize()` resolves — call it once, early.'
  )
}

const styles = StyleSheet.create({
  button: { width: 40, height: 40 },
})
