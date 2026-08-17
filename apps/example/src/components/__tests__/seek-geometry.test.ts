import { describe, expect, it } from 'vitest'
import { barOriginX, clamp01, fractionAtX } from '../seek-geometry'

/**
 * The bar as the app lays it out: 300 px wide, flush with the left edge of the
 * hit area, and the hit area itself 40 px into the page.
 */
const PAGE_LEFT = 40
const WIDTH = 300
const GEOMETRY = { originX: PAGE_LEFT, width: WIDTH }

describe('barOriginX', () => {
  it('recovers the track origin from a touch on the responder', () => {
    // Finger 90 px into the bar: pageX 130, locationX 90 (hit-area relative),
    // track flush with the hit area.
    expect(barOriginX(130, 90, 0)).toBe(40)
  })

  it('adds the track offset, so the hit area may be inset', () => {
    // Same touch, but the track starts 16 px inside a padded hit area: the
    // finger is now 74 px into the *track*, and the origin is 16 px further in.
    expect(barOriginX(130, 90, 16)).toBe(56)
  })

  /**
   * The regression. Before `pointerEvents="none"` the touch target of a press
   * on the thumb was the thumb, so `locationX` was thumb-relative — 7 for a
   * press on its centre, since the 14 px thumb is drawn with `marginLeft: -7`.
   * The origin then came out as the thumb's own left edge and the fraction
   * collapsed to ~0: grabbing the thumb seeked to the start of the track.
   */
  it('would report the thumb origin if the thumb were hit-testable', () => {
    const played = 0.5
    const thumbCentrePageX = PAGE_LEFT + played * WIDTH // 190
    const thumbLeftPageX = thumbCentrePageX - 7 // 183

    // Broken: locationX relative to the thumb (7 px in from its left edge).
    const broken = barOriginX(thumbCentrePageX, 7, 0)
    expect(broken).toBe(thumbLeftPageX)
    expect(fractionAtX(thumbCentrePageX, { originX: broken, width: WIDTH })).toBe(
      7 / WIDTH
    )

    // Fixed: the hit area is the target, so locationX is 150 and the drag
    // starts from where the thumb actually is.
    const fixed = barOriginX(thumbCentrePageX, played * WIDTH, 0)
    expect(fixed).toBe(PAGE_LEFT)
    expect(
      fractionAtX(thumbCentrePageX, { originX: fixed, width: WIDTH })
    ).toBe(played)
  })
})

describe('fractionAtX', () => {
  it('maps the ends and the middle of the track', () => {
    expect(fractionAtX(PAGE_LEFT, GEOMETRY)).toBe(0)
    expect(fractionAtX(PAGE_LEFT + WIDTH, GEOMETRY)).toBe(1)
    expect(fractionAtX(PAGE_LEFT + WIDTH / 2, GEOMETRY)).toBe(0.5)
  })

  it('clamps a drag that runs off either end', () => {
    expect(fractionAtX(PAGE_LEFT - 500, GEOMETRY)).toBe(0)
    expect(fractionAtX(PAGE_LEFT + WIDTH + 500, GEOMETRY)).toBe(1)
  })

  it('answers 0 before onLayout has measured anything', () => {
    expect(fractionAtX(200, { originX: 0, width: 0 })).toBe(0)
    expect(fractionAtX(200, { originX: 0, width: Number.NaN })).toBe(0)
  })
})

describe('clamp01', () => {
  it('forces a value into 0…1 and answers 0 for a non-number', () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.25)).toBe(0.25)
    expect(clamp01(2)).toBe(1)
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0)
  })
})
