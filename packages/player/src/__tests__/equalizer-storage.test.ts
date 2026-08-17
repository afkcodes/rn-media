import { describe, expect, it } from 'vitest'
import { EQUALIZER_PRESETS } from '../equalizer-presets'
import type { EqualizerSettings } from '../equalizer-storage'
import {
  EQUALIZER_SCHEMA_VERSION,
  parseEqualizerSettings,
  serializeEqualizerSettings,
} from '../equalizer-storage'

const SETTINGS: EqualizerSettings = {
  enabled: true,
  gainsDb: EQUALIZER_PRESETS.rock.gainsDb,
  presets: [
    {
      id: 'custom:Mine',
      name: 'Mine',
      gainsDb: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    },
  ],
}

describe('serializeEqualizerSettings / parseEqualizerSettings', () => {
  it('round-trips settings through a string', () => {
    const result = parseEqualizerSettings(serializeEqualizerSettings(SETTINGS))
    expect(result).toEqual({ status: 'restored', settings: SETTINGS })
  })

  it('stamps the schema version', () => {
    expect(JSON.parse(serializeEqualizerSettings(SETTINGS))).toMatchObject({
      v: EQUALIZER_SCHEMA_VERSION,
    })
  })

  it('does not persist the built-in presets', () => {
    const record = JSON.parse(
      serializeEqualizerSettings({ ...SETTINGS, presets: [] })
    ) as { presets: unknown[] }
    // They ship with the library, so a retuned built-in takes effect on the
    // next launch instead of being pinned forever by an old record.
    expect(record.presets).toEqual([])
  })

  it('reports nothing stored as empty', () => {
    expect(parseEqualizerSettings(null)).toEqual({ status: 'empty' })
    expect(parseEqualizerSettings(undefined)).toEqual({ status: 'empty' })
    expect(parseEqualizerSettings('')).toEqual({ status: 'empty' })
  })

  it('reports unparseable JSON as corrupt rather than throwing', () => {
    const result = parseEqualizerSettings('{not json')
    expect(result.status).toBe('corrupt')
  })

  it('reports a non-object record as corrupt', () => {
    expect(parseEqualizerSettings('[1,2,3]').status).toBe('corrupt')
    expect(parseEqualizerSettings('"a string"').status).toBe('corrupt')
  })

  it('refuses a record written by another schema version', () => {
    const raw = JSON.stringify({
      v: 99,
      enabled: true,
      gainsDb: [],
      presets: [],
    })
    expect(parseEqualizerSettings(raw)).toEqual({
      status: 'unsupportedVersion',
      found: 99,
      expected: EQUALIZER_SCHEMA_VERSION,
    })
  })

  it('reports a missing version as unsupported with no found value', () => {
    const raw = JSON.stringify({ enabled: true, gainsDb: [], presets: [] })
    expect(parseEqualizerSettings(raw)).toEqual({
      status: 'unsupportedVersion',
      found: undefined,
      expected: EQUALIZER_SCHEMA_VERSION,
    })
  })

  it('refuses a curve that is not exactly one finite gain per band', () => {
    const short = JSON.stringify({
      v: EQUALIZER_SCHEMA_VERSION,
      enabled: true,
      gainsDb: [0, 0, 0],
      presets: [],
    })
    expect(parseEqualizerSettings(short).status).toBe('corrupt')

    const infinite = JSON.stringify({
      v: EQUALIZER_SCHEMA_VERSION,
      enabled: true,
      gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, null],
      presets: [],
    })
    expect(parseEqualizerSettings(infinite).status).toBe('corrupt')
  })

  it('refuses a non-boolean enabled', () => {
    const raw = JSON.stringify({
      v: EQUALIZER_SCHEMA_VERSION,
      enabled: 'yes',
      gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      presets: [],
    })
    expect(parseEqualizerSettings(raw).status).toBe('corrupt')
  })

  it('drops one unusable preset rather than losing the whole equaliser', () => {
    const raw = JSON.stringify({
      v: EQUALIZER_SCHEMA_VERSION,
      enabled: false,
      gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      presets: [
        { id: '', name: 'no id', gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        {
          id: 'custom:Good',
          name: 'Good',
          gainsDb: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
        { id: 'custom:Short', name: 'Short', gainsDb: [1, 2] },
        'not an object',
      ],
    })
    const result = parseEqualizerSettings(raw)
    expect(result.status).toBe('restored')
    if (result.status !== 'restored') return
    expect(result.settings.presets).toEqual([
      {
        id: 'custom:Good',
        name: 'Good',
        gainsDb: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      },
    ])
    expect(result.settings.enabled).toBe(false)
  })

  it('tolerates a missing preset bank', () => {
    const raw = JSON.stringify({
      v: EQUALIZER_SCHEMA_VERSION,
      enabled: true,
      gainsDb: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    })
    const result = parseEqualizerSettings(raw)
    expect(result.status).toBe('restored')
    if (result.status !== 'restored') return
    expect(result.settings.presets).toEqual([])
  })
})
