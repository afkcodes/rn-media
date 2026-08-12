/**
 * The example app's design tokens.
 *
 * Explicit on purpose. React Native gives an unstyled `<Text>` a near-black
 * colour and leaves the window background to the platform theme, so on a device
 * in dark mode every label in this app rendered dark-grey-on-dark-grey — legible
 * only if you already knew what it said. A demo that is also the on-device test
 * bed has to be readable in both system themes, and the cheapest way to
 * guarantee that is to own both ends of the contrast.
 *
 * The design language is deliberately **flat and card-less**: content is
 * grouped by whitespace and hairline rules, hierarchy is typography's job, and
 * there is exactly one accent. Nothing here describes a container — no shadow
 * tokens, and radii exist only for *controls* (chips, the play button) and
 * artwork, never for boxes around content.
 */
export const COLORS = {
  /** Window background — the only "surface" on the screen. */
  background: '#0d1117',
  /** Control fills that must read as an object: artwork fallback, thumbnails. */
  surface: '#1b222c',
  /** Primary copy. */
  text: '#e6edf3',
  /** Secondary copy: labels, counters, the "buffered …" line. */
  muted: '#9aa4b2',
  /** Hairline rules, control outlines, and the unfilled part of the seek bar. */
  border: '#333c48',
  /** Buffered-ahead fill: brighter than {@link border}, dimmer than the fill. */
  track: '#4a5563',
  /** The one accent. Also the notification colour (see `session.ts`). */
  accent: '#1f6feb',
  error: '#ff7b72',
  /** Hairline one step quieter than {@link border} — section rules. */
  borderSoft: '#242c38',
  /** Lighter accent, for text-on-dark accent copy and active labels. */
  accentBright: '#4c9aff',
  /** "On air" — the same red the level meter's top zone uses. */
  live: '#ff453a',
  /** Confirmations: prefetch landed, filters accepted. */
  success: '#32d74b',
  /** Caveats that are not failures (prefetch off, capability missing). */
  warning: '#ffcc00',
  /** Copy that sits on {@link accent}. */
  onAccent: '#ffffff',
} as const

/**
 * The notification accent, as Android wants it: a full **ARGB** integer.
 *
 * The same `#1f6feb` as {@link COLORS.accent}, with the alpha byte written out
 * — `0x1F6FEB` alone would be transparent black, which is the documented trap
 * on `MediaServiceConfig.android.notificationColor`.
 */
export const ACCENT_ARGB = 0xff1f6feb

/**
 * A 4-point spacing scale.
 *
 * One scale, used everywhere, is what makes a screen assembled from a dozen
 * independent components look like one screen — every gap in this app is one
 * of these numbers. In a card-less design the scale *is* the grouping
 * mechanism, so the top end is generous on purpose.
 */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  /** Between sections — whitespace is the container now. */
  section: 40,
} as const

/**
 * Corner radii — **controls and artwork only**.
 *
 * Containers are flat: no group on this screen gets a rounded box around it.
 * `pill` survives for the one circular control (play/pause); everything else
 * that keeps a radius is something a finger presses or a sleeve of artwork.
 */
export const RADIUS = {
  sm: 6,
  md: 12,
  pill: 999,
} as const

/** Type ramp. Sizes only — weight and colour are set at the call site. */
export const TYPE = {
  hero: 28,
  title: 19,
  body: 15,
  label: 13,
  caption: 12,
  micro: 11,
} as const
