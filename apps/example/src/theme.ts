/**
 * The example app's palette.
 *
 * Explicit on purpose. React Native gives an unstyled `<Text>` a near-black
 * colour and leaves the window background to the platform theme, so on a device
 * in dark mode every label in this app rendered dark-grey-on-dark-grey — legible
 * only if you already knew what it said. A demo that is also the on-device test
 * bed has to be readable in both system themes, and the cheapest way to
 * guarantee that is to own both ends of the contrast.
 */
export const COLORS = {
  /** Window background. */
  background: '#0d1117',
  /** Cards and list rows sitting on {@link background}. */
  surface: '#1b222c',
  /** The current queue row. */
  surfaceActive: '#16304f',
  /** Primary copy. */
  text: '#e6edf3',
  /** Secondary copy: labels, counters, the "buffered …" line. */
  muted: '#9aa4b2',
  /** Hairlines and the unfilled part of the seek bar. */
  border: '#333c48',
  /** Buffered-ahead fill: brighter than {@link border}, dimmer than the fill. */
  track: '#4a5563',
  /** Transport accent. */
  accent: '#1f6feb',
  error: '#ff7b72',

  /* --- added with the modular restructure ------------------------------- */

  /** One step below {@link surface}: section wells inside a card. */
  surfaceSunken: '#131a23',
  /** Hairline that reads as a border on {@link surface} rather than on the bg. */
  borderSoft: '#242c38',
  /** Lighter accent, for gradients-by-hand and pressed states. */
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
 * A 4-point spacing scale.
 *
 * One scale, used everywhere, is what makes a screen assembled from a dozen
 * independent components look like one screen — every gap in this app is one of
 * these six numbers.
 */
export const SPACE = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const

/** Corner radii. `pill` is the "clamp to a capsule" idiom. */
export const RADIUS = {
  sm: 8,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
} as const

/**
 * Elevation, spelled for both platforms.
 *
 * iOS reads the `shadow*` group and ignores `elevation`; Android does the
 * reverse. Writing both in one object is the only way a card looks the same on
 * a Pixel and an iPhone, and it is the single most-forgotten thing in RN
 * styling.
 */
export const SHADOW = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  /** For the one control that should look like it is floating: play/pause. */
  accent: {
    shadowColor: COLORS.accent,
    shadowOpacity: 0.55,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
} as const

/** Type ramp. Sizes only — weight and colour are set at the call site. */
export const TYPE = {
  hero: 26,
  title: 19,
  body: 15,
  label: 13,
  caption: 12,
  micro: 11,
} as const
