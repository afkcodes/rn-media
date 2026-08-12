import { describe, expect, it } from 'vitest'
import { escapeAfParam } from '../filters'
import { escapeSubparam, utf8Length } from '../subparam'

describe('utf8Length', () => {
  it('counts bytes, not UTF-16 code units', () => {
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length('é')).toBe(2)
    expect(utf8Length('日本')).toBe(6)
    // One astral code point is a surrogate PAIR in JS (`.length === 2`) and
    // four bytes in UTF-8. mpv counts the four.
    expect('🎵'.length).toBe(2)
    expect(utf8Length('🎵')).toBe(4)
  })
})

describe('escapeSubparam', () => {
  it('leaves mpv’s NAMECH alphabet alone', () => {
    expect(escapeSubparam('lavf')).toBe('lavf')
    expect(escapeSubparam('30')).toBe('30')
    expect(escapeSubparam('no')).toBe('no')
    expect(escapeSubparam('cache-pause_2')).toBe('cache-pause_2')
  })

  it('escapes anything else in mpv’s fixed-length form', () => {
    // `.` is outside NAMECH — mpv escapes decimals too, and so do we.
    expect(escapeSubparam('30.5')).toBe('%4%30.5')
    expect(escapeSubparam('a,b')).toBe('%3%a,b')
    expect(escapeSubparam('a:b')).toBe('%3%a:b')
    expect(escapeSubparam('"quoted"')).toBe('%8%"quoted"')
    expect(escapeSubparam('[bracket]')).toBe('%9%[bracket]')
    expect(escapeSubparam('back\\slash')).toBe('%10%back\\slash')
    expect(escapeSubparam('%50%')).toBe('%4%%50%')
    expect(escapeSubparam('')).toBe('')
  })

  it('counts the prefix in bytes for non-ASCII values', () => {
    expect(escapeSubparam('café')).toBe('%5%café')
  })

  it('is the same rule the af chain already used', () => {
    // `escapeAfParam` is the filter-facing name for this; both are read back by
    // mpv's one `read_subparam`, so a divergence would be a bug in one of them.
    for (const value of ['lavf', '30.5', 'a,b', 'café', '']) {
      expect(escapeAfParam(value)).toBe(escapeSubparam(value))
    }
  })
})
