import { describe, expect, it } from 'vitest'
import type { ColumnRect } from '../fader-geometry'
import { bandAtX, gainAtY } from '../fader-geometry'

/** Ten 30 px columns with a 4 px gap, which is what the bank lays out. */
const COLUMNS: readonly ColumnRect[] = Array.from({ length: 10 }, (_, i) => ({
  x: i * 34,
  width: 30,
}))

const RANGE = { min: -12, max: 12 }

describe('bandAtX', () => {
  it('picks the column the touch is inside', () => {
    expect(bandAtX(COLUMNS, 0)).toBe(0)
    expect(bandAtX(COLUMNS, 29)).toBe(0)
    expect(bandAtX(COLUMNS, 34)).toBe(1)
    expect(bandAtX(COLUMNS, 8 * 34 + 15)).toBe(8)
    expect(bandAtX(COLUMNS, 9 * 34 + 29)).toBe(9)
  })

  it('picks the nearest column for a touch in a gap', () => {
    // 30…33 is the gap between band 0 and band 1.
    expect(bandAtX(COLUMNS, 30)).toBe(0)
    expect(bandAtX(COLUMNS, 33)).toBe(1)
  })

  it('clamps outside the row, so a drag off the edge stays on the end band', () => {
    expect(bandAtX(COLUMNS, -50)).toBe(0)
    expect(bandAtX(COLUMNS, 5000)).toBe(9)
  })

  it('answers 0 before anything has been measured', () => {
    expect(bandAtX([], 120)).toBe(0)
    expect(bandAtX([{ x: 0, width: 0 }], 120)).toBe(0)
  })
})

describe('gainAtY', () => {
  it('maps the top of the track to full boost and the bottom to full cut', () => {
    expect(gainAtY(0, 96, RANGE)).toBe(12)
    expect(gainAtY(96, 96, RANGE)).toBe(-12)
    expect(gainAtY(48, 96, RANGE)).toBe(0)
  })

  it('clamps beyond either end of the track', () => {
    expect(gainAtY(-40, 96, RANGE)).toBe(12)
    expect(gainAtY(400, 96, RANGE)).toBe(-12)
  })

  it('rounds to 0.1 dB', () => {
    expect(gainAtY(31, 96, RANGE)).toBe(4.3)
  })

  it('honours a narrower range', () => {
    expect(gainAtY(0, 96, { min: -6, max: 6 })).toBe(6)
    expect(gainAtY(96, 96, { min: -6, max: 6 })).toBe(-6)
  })

  it('does not divide by an unmeasured height', () => {
    expect(gainAtY(10, 0, RANGE)).toBe(12)
  })
})
