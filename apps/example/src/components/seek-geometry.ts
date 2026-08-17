/**
 * The arithmetic behind the seek bar, with no React in it.
 *
 * It lives in its own module for the same reason `fader-geometry.ts` does: the
 * bar resolved a touch through a coordinate space that was not its own, and
 * that mistake is invisible in a code review but trivial to assert against.
 *
 * The trap, once, for both files: React Native's `locationX`/`locationY` are
 * relative to the **touch target** — the deepest hit-testable view under the
 * finger (`TouchesHelper.kt:61-65`, "locationX,Y values are relative to the
 * target view") — not to the view whose `PanResponder` receives the event. So
 * `pageX - locationX` is the origin of whatever child was hit, and it is only
 * the *responder's* origin when the responder is the only thing hittable. The
 * components enforce that with `pointerEvents="none"` on their children;
 * {@link barOriginX} then re-adds the drawn track's own offset inside the
 * responder, so the two views no longer have to share an edge.
 */

/** Where the drawn track sits, and how wide it is, in page coordinates. */
export interface BarGeometry {
  /** Left edge of the **track** in page coordinates. */
  readonly originX: number
  /** Track width. Zero until `onLayout` has run. */
  readonly width: number
}

/**
 * The track's left edge in page coordinates, from one grant event.
 *
 * `pageX - locationX` is the origin of the touch target. With the responder's
 * children made transparent to touches the target is the responder itself, so
 * adding the track's `onLayout` offset within the responder lands on the
 * track's own left edge — which is the coordinate the fraction is measured
 * from, and the one a `View` will not report without an async `measure`.
 *
 * Keeping `trackX` in the sum is what lets the hit area carry horizontal
 * padding: the old code assumed the two views shared a left edge and silently
 * mis-mapped every touch by the padding if they ever did not.
 *
 * @param pageX - `nativeEvent.pageX` of the grant.
 * @param locationX - `nativeEvent.locationX` of the same event.
 * @param trackX - The track's `layout.x` within the responder view.
 */
export function barOriginX(
  pageX: number,
  locationX: number,
  trackX: number
): number {
  return pageX - locationX + trackX
}

/**
 * The fraction of the track a touch at `pageX` is over, clamped to `0…1`.
 *
 * Clamping rather than ignoring is deliberate: a drag that runs off either end
 * of the bar should pin to that end and keep scrubbing there, not freeze.
 *
 * @param pageX - Page-space x of the touch.
 * @param geometry - As measured; a zero width answers `0`.
 */
export function fractionAtX(pageX: number, geometry: BarGeometry): number {
  if (!(geometry.width > 0)) return 0
  return clamp01((pageX - geometry.originX) / geometry.width)
}

/** `value` forced into `0…1`; a non-finite input answers `0`. */
export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}
