/**
 * The arithmetic behind the equaliser fader bank, with no React in it.
 *
 * It lives in its own module for one reason: the first version of the bank got
 * this wrong in two ways at once — it picked the band from a coordinate space
 * that was not the bank's, and mapped the gain over a height that included the
 * labels under the tracks — and neither is visible in a code review. Both are
 * three lines of arithmetic, and arithmetic can be tested without a device.
 */

/** One fader column, as `onLayout` reports it: x and width within the row. */
export interface ColumnRect {
  /** Left edge, in the row's own coordinates. */
  readonly x: number
  /** Column width. */
  readonly width: number
}

/** Inclusive gain bounds, in dB — `Equalizer.gainRangeDb`. */
export interface GainRange {
  readonly min: number
  readonly max: number
}

/**
 * Which band a touch at `x` belongs to.
 *
 * The columns are laid out with a gap between them, so a touch can legitimately
 * land in no column at all; rather than ignore it (a fader that sometimes does
 * nothing) the nearest column wins. Coordinates are the row's own — see
 * `BandBank` for why the row is the only touchable view in the bank.
 *
 * @param columns - Column rectangles in band order, as measured.
 * @param x - Touch offset within the row.
 * @returns The band index, or `0` when nothing has been measured yet.
 */
export function bandAtX(columns: readonly ColumnRect[], x: number): number {
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [index, column] of columns.entries()) {
    if (column.width <= 0) continue
    if (x >= column.x && x < column.x + column.width) return index
    const centre = column.x + column.width / 2
    const distance = Math.abs(x - centre)
    if (distance < bestDistance) {
      bestDistance = distance
      best = index
    }
  }
  return best
}

/**
 * The gain a touch at `y` means, in dB.
 *
 * The top of the track is maximum boost and the bottom is maximum cut, which is
 * what every hardware fader does. `height` must be the height of the **track**,
 * not of the bank around it: mapping over the bank's height is what made the
 * bottom of a bar read −6.9 dB instead of −12.
 *
 * Beyond either end the value clamps, so a drag that leaves the bank keeps the
 * fader pinned at its stop instead of losing it.
 *
 * @param y - Touch offset from the top of the track.
 * @param height - Track height in the same units.
 * @param range - The bounds to map onto.
 * @returns The gain, rounded to 0.1 dB — finer than that is neither audible nor
 * readable in the chain string.
 */
export function gainAtY(y: number, height: number, range: GainRange): number {
  if (!(height > 0)) return range.max
  const fraction = Math.min(1, Math.max(0, y / height))
  const gain = range.max - fraction * (range.max - range.min)
  return Number(gain.toFixed(1))
}
