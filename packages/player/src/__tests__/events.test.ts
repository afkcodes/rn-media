import { describe, expect, it } from 'vitest'
import { toPlayerEvent, toPlayerEvents } from '../events'
import type { MpvEvent, MpvEventKind } from '../specs/mpv-client.nitro'
import {
  endFileEvent,
  logEvent,
  playbackRestartEvent,
  propertyEvent,
  seekEvent,
  shutdownEvent,
  startFileEvent,
} from './fake-mpv-client'

/**
 * Every member of `MpvEventKind`. If nitrogen ever adds one, the
 * `satisfies never` guard in `toPlayerEvent` fails to compile *and* this list
 * fails the exhaustiveness test below.
 */
const ALL_KINDS: readonly MpvEventKind[] = [
  'property',
  'startFile',
  'endFile',
  'seek',
  'playbackRestart',
  'log',
  'shutdown',
]

describe('toPlayerEvent', () => {
  it('maps every MpvEventKind to a union member (exhaustiveness)', () => {
    const mapped = ALL_KINDS.map((kind) =>
      toPlayerEvent({ kind, name: 'pause', endFileReason: 'endOfFile' })
    )
    expect(mapped.map((event) => event?.kind)).toEqual(ALL_KINDS)
  })

  it('maps a property event with a value', () => {
    expect(toPlayerEvent(propertyEvent('pause', true))).toEqual({
      kind: 'property',
      name: 'pause',
      value: true,
    })
  })

  it('preserves an unavailable property as value: undefined', () => {
    const mapped = toPlayerEvent(propertyEvent('duration'))
    expect(mapped).toEqual({
      kind: 'property',
      name: 'duration',
      value: undefined,
    })
  })

  it('keeps string and number property values distinct', () => {
    expect(toPlayerEvent(propertyEvent('loop-file', 'inf'))).toMatchObject({
      value: 'inf',
    })
    expect(toPlayerEvent(propertyEvent('playlist-pos', 3))).toMatchObject({
      value: 3,
    })
  })

  it('drops a property event without a name', () => {
    expect(toPlayerEvent({ kind: 'property' })).toBeUndefined()
  })

  it('maps endFile with its reason and error text', () => {
    expect(toPlayerEvent(endFileEvent('error', 'loading failed'))).toEqual({
      kind: 'endFile',
      reason: 'error',
      error: 'loading failed',
    })
  })

  it('defaults a reason-less endFile to unknown', () => {
    expect(toPlayerEvent({ kind: 'endFile' })).toEqual({
      kind: 'endFile',
      reason: 'unknown',
      error: undefined,
    })
  })

  it('maps log events including mpv prefix and level', () => {
    expect(toPlayerEvent(logEvent('warn', 'ffmpeg', 'oops\n'))).toEqual({
      kind: 'log',
      level: 'warn',
      prefix: 'ffmpeg',
      text: 'oops\n',
    })
  })

  it('defaults missing log fields rather than dropping the event', () => {
    expect(toPlayerEvent({ kind: 'log' })).toEqual({
      kind: 'log',
      level: 'info',
      prefix: '',
      text: '',
    })
  })

  it.each([
    [startFileEvent(), 'startFile'],
    [seekEvent(), 'seek'],
    [playbackRestartEvent(), 'playbackRestart'],
    [shutdownEvent(), 'shutdown'],
  ] as const)('maps the discrete event %#', (event, kind) => {
    expect(toPlayerEvent(event)).toEqual({ kind })
  })

  it('returns undefined for an unknown kind rather than throwing', () => {
    const bogus = { kind: 'somethingNew' } as unknown as MpvEvent
    expect(toPlayerEvent(bogus)).toBeUndefined()
  })
})

describe('toPlayerEvents', () => {
  it('preserves batch order and drops malformed entries', () => {
    const batch: MpvEvent[] = [
      startFileEvent(),
      { kind: 'property' },
      propertyEvent('pause', false),
      playbackRestartEvent(),
    ]
    expect(toPlayerEvents(batch).map((event) => event.kind)).toEqual([
      'startFile',
      'property',
      'playbackRestart',
    ])
  })

  it('returns an empty array for an empty batch', () => {
    expect(toPlayerEvents([])).toEqual([])
  })
})
