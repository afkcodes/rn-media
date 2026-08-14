import type { HybridView, HybridViewProps } from 'react-native-nitro-modules'

/**
 * Props of the native cast button view.
 *
 * Deliberately tiny: the button's whole job is to be the *platform's* cast
 * affordance, and every extra prop is a way to diverge from it. Layout comes
 * from React Native's own `style` (a Nitro view's props class extends
 * `react::ViewProps`, so the standard view props are already there).
 */
export interface RnMediaCastButtonProps extends HybridViewProps {
  /**
   * Icon colour as a `processColor`-packed ARGB integer, or `undefined` for
   * the platform default.
   *
   * The JS `<CastButton tintColor="…" />` prop does the `processColor` call;
   * this is the wire form. `undefined` means "do not tint" on both platforms:
   * iOS keeps the inherited `tintColor`, Android keeps whatever the app
   * theme's `mediaRouteButtonTint` says.
   */
  tintColor?: number
}

/**
 * The native Google Cast button, as a React Native view.
 *
 * - **iOS** — a `GCKUICastButton` (`GoogleCast/GCKUICastButton.h:22`, a
 *   `UIButton` subclass). Left with its default
 *   `triggersDefaultCastDialog = YES`, so a tap presents the framework's own
 *   device dialog. That is also what drives the iOS local-network permission
 *   choreography: by SDK design discovery starts on the first tap, never
 *   before, so the OS prompt appears exactly when the user asked for devices.
 * - **Android** — an `androidx.mediarouter.app.MediaRouteButton` handed to
 *   `CastButtonFactory.setUpMediaRouteButton(Context, MediaRouteButton)`.
 *   That is the only wiring that honours
 *   `CastOptions.setShowSystemOutputSwitcherOnCastIconClick(true)` (which our
 *   `OptionsProvider` sets): on Android 13+ a tap opens the SYSTEM output
 *   switcher; below that, the in-app `MediaRouteChooserDialog`.
 *
 * @see `packages/cast/src/cast-button.tsx` for the JS-facing component.
 */
export type RnMediaCastButton = HybridView<RnMediaCastButtonProps>
