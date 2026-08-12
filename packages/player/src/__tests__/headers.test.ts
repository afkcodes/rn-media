import { describe, expect, it } from 'vitest'
import { PlayerErrorException } from '../errors'
import { compileHttpHeaderFields } from '../headers'

describe('compileHttpHeaderFields', () => {
  it('writes one `Name: value` list item per header', () => {
    expect(
      compileHttpHeaderFields({
        'Authorization': 'Bearer abc123',
        'X-Client': 'rn-media',
      })
    ).toBe('Authorization: Bearer abc123,X-Client: rn-media')
  })

  it('returns undefined for an empty map', () => {
    expect(compileHttpHeaderFields({})).toBeUndefined()
  })

  it('escapes commas inside a value for mpv’s string-list parser', () => {
    // The proving case, and the whole reason this function exists: the item
    // separator is `,` and `get_nextsep()` un-escapes exactly one backslash
    // before a comma, so a comma-bearing header must be written `\,` or it
    // becomes two bogus header lines.
    expect(
      compileHttpHeaderFields({ Accept: 'text/html, application/xml' })
    ).toBe('Accept: text/html\\, application/xml')
  })

  it('escapes every comma, in every header', () => {
    expect(
      compileHttpHeaderFields({
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Cookie': 'a=1, b=2',
      })
    ).toBe(
      'Cache-Control: no-cache\\, no-store\\, must-revalidate,Cookie: a=1\\, b=2'
    )
  })

  it('leaves a backslash already in the value alone', () => {
    // mpv only strips a backslash that immediately precedes the separator, so
    // an ordinary backslash survives and one before a comma round-trips.
    expect(compileHttpHeaderFields({ 'X-Path': 'a\\b' })).toBe('X-Path: a\\b')
    expect(compileHttpHeaderFields({ 'X-Path': 'a\\,b' })).toBe(
      'X-Path: a\\\\,b'
    )
  })

  it('rejects CR/LF in a value — that is request splitting', () => {
    // mpv joins these lines with `\r\n` and hands the result to FFmpeg's
    // `headers` AVOption verbatim, so a newline here injects a request line.
    expect(() =>
      compileHttpHeaderFields({ 'X-Evil': 'a\r\nX-Injected: 1' })
    ).toThrow(PlayerErrorException)
    expect(() => compileHttpHeaderFields({ 'X-Evil': 'a\nb' })).toThrow(
      /CR, LF or NUL/u
    )
  })

  it('rejects unusable header names', () => {
    for (const name of [
      '',
      ' Authorization',
      'Authorization ',
      'a:b',
      'a\nb',
    ]) {
      expect(() => compileHttpHeaderFields({ [name]: 'v' })).toThrow(
        PlayerErrorException
      )
    }
  })

  it('throws a typed invalid-state error, not a bare TypeError', () => {
    try {
      compileHttpHeaderFields({ 'X-Evil': 'a\r\nb' })
      expect.unreachable('should have thrown')
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(PlayerErrorException)
      expect((thrown as PlayerErrorException).playerError).toMatchObject({
        code: 'invalid-state',
        retryable: false,
      })
    }
  })
})
