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
} as const;
