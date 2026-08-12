import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Player } from '../player'
import { MpvProperty } from '../properties'
import { FakeMpvClient, propertyEvent } from './fake-mpv-client'

let client: FakeMpvClient

async function createPlayer(): Promise<Player> {
  return Player.create({ createClient: () => client, now: () => 1_000 })
}

const AUDIOBOOK = [
  { title: 'Chapter One', start: 0 },
  { title: 'Chapter Two', start: 1_820.5 },
  { start: 3_600 },
]

beforeEach(() => {
  client = new FakeMpvClient()
})

describe('Player.getChapters', () => {
  it('reads the whole list in one native call', async () => {
    const player = await createPlayer()
    client.chapters = [...AUDIOBOOK]

    expect(player.getChapters()).toEqual(AUDIOBOOK)
    // One node read, not `2N + 1` scalar reads. The count is the contract.
    expect(client.chapterReads).toBe(1)
  })

  it('reports a chapterless entry as an empty list, not an error', async () => {
    const player = await createPlayer()
    expect(player.getChapters()).toEqual([])
  })

  it('keeps a chapter with no title as a titleless entry', async () => {
    const player = await createPlayer()
    client.chapters = [{ start: 12 }]
    const [chapter] = player.getChapters()
    expect(chapter?.start).toBe(12)
    expect(chapter?.title).toBeUndefined()
  })

  it('hands back a frozen snapshot', async () => {
    const player = await createPlayer()
    client.chapters = [...AUDIOBOOK]
    expect(Object.isFrozen(player.getChapters())).toBe(true)
  })

  it('throws once the player is destroyed', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.getChapters()).toThrow(/destroyed/u)
  })
})

describe('Player — chapter cursor and navigation', () => {
  it('observes the chapter property', async () => {
    await createPlayer()
    expect(client.observations.get(MpvProperty.chapter)).toBe('number')
  })

  it('publishes the current chapter in state', async () => {
    const player = await createPlayer()
    expect(player.state.chapter).toBeUndefined()

    client.emit([propertyEvent(MpvProperty.chapter, 1)])
    expect(player.state.chapter).toBe(1)

    // mpv's own "before the first chapter" value survives as itself: it is a
    // different position from chapter 0, and smoothing it would hide that.
    client.emit([propertyEvent(MpvProperty.chapter, -1)])
    expect(player.state.chapter).toBe(-1)

    // An entry with no chapters reports the property unavailable.
    client.emit([propertyEvent(MpvProperty.chapter)])
    expect(player.state.chapter).toBeUndefined()
  })

  it('emits chapterChanged with both cursors', async () => {
    const player = await createPlayer()
    const changes = vi.fn()
    player.on('chapterChanged', changes)

    client.emit([propertyEvent(MpvProperty.chapter, 0)])
    client.emit([propertyEvent(MpvProperty.chapter, 1)])
    // A repeat of the same value is not a change.
    client.emit([propertyEvent(MpvProperty.chapter, 1)])
    client.emit([propertyEvent(MpvProperty.chapter)])

    expect(changes.mock.calls.map(([event]) => event)).toEqual([
      { index: 0, previousIndex: undefined },
      { index: 1, previousIndex: 0 },
      { index: undefined, previousIndex: 1 },
    ])
  })

  it('drops the chapter cursor when the queue moves on', async () => {
    const player = await createPlayer()
    client.emit([propertyEvent(MpvProperty.chapter, 2)])
    client.emit([propertyEvent(MpvProperty.playlistPos, 1)])
    // The next entry's chapters are its own; mpv republishes for it.
    expect(player.state.chapter).toBeUndefined()
  })

  it('setChapter writes the property — an absolute seek in mpv', async () => {
    const player = await createPlayer()
    player.setChapter(3)
    expect(client.written.get(MpvProperty.chapter)).toBe(3)
    expect(client.commands).toEqual([])
  })

  it('setChapter rejects a non-index', async () => {
    const player = await createPlayer()
    expect(() => player.setChapter(-1)).toThrow(/non-negative integer/u)
    expect(() => player.setChapter(1.5)).toThrow(/non-negative integer/u)
  })

  it('nextChapter and previousChapter use mpv’s add command', async () => {
    const player = await createPlayer()
    await player.nextChapter()
    await player.previousChapter()
    // `add chapter -1` is deliberately not `chapter = chapter - 1`: mpv's
    // `--chapter-seek-threshold` makes a backward chapter seek restart the
    // current chapter unless you are near its start.
    expect(client.commands).toEqual([
      ['add', 'chapter', '1'],
      ['add', 'chapter', '-1'],
    ])
  })

  it('throws on every chapter call once destroyed', async () => {
    const player = await createPlayer()
    player.destroy()
    expect(() => player.setChapter(0)).toThrow(/destroyed/u)
    await expect(player.nextChapter()).rejects.toThrow(/destroyed/u)
    await expect(player.previousChapter()).rejects.toThrow(/destroyed/u)
  })
})
