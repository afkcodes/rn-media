# Recipe: a self-hosted library client

Plex / Jellyfin / Subsonic shape. Your queue is a list of *your* ids; what mpv
has to open is a URL your server mints on demand, sometimes signed and expiring
in minutes. The source resolver is the seam, and it fires at prefetch time too,
so a queue of signed URLs is still gapless.

```ts
import { Player, type SourceResolver } from '@timbre/player'

/**
 * `myapp://track/<id>` → whatever the server says is playable right now.
 *
 * The queue holds ids, the server mints a session URL per track, and neither
 * the queue nor persistence ever contains a URL that can expire.
 */
const resolveSource: SourceResolver = async ({ uri, entryId }) => {
  if (!uri.startsWith('myapp://track/')) return uri      // pass anything else through
  const id = uri.slice('myapp://track/'.length)

  const response = await fetch(`${server}/api/playback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ trackId: id, maxBitrate: 320 }),
  })
  if (!response.ok) throw new Error(`playback ${id}: HTTP ${response.status}`)
  const { url } = (await response.json()) as { url: string }

  // `entryId` is present only on the prefetch path. Its absence means this call
  // is holding mpv's core — the line to watch when a transition felt slow.
  console.log(`[resolve] ${id} ${entryId === undefined ? '(play-time)' : '(prefetch)'}`)
  return url
}

const player = await Player.create({
  prefetchPlaylist: true,
  sourceResolver: resolveSource,
  resolverTimeoutMs: 8_000,     // how long a play-time miss may hold mpv. 0 = never hold
  resolverTtlMs: 5 * 60_000,    // how long one answer is replayed. Keep it inside the
                                // URL's real expiry, and long enough to cover a track
})

// The queue is logical: your ids, not URLs. Nothing here expires, so it
// persists and restores cleanly.
const tracks = await catalogue.tracks('album:1')
await player.loadPlaylist(
  tracks.map((t) => `myapp://track/${t.id}`),
  {
    // Per-source auth, typed and escaped through both of mpv's list layers.
    // It belongs to the entry, so a resolver rewriting the URL does not lose it.
    headers: { Authorization: `Bearer ${token}`, 'X-Emby-Token': token },
  },
)

// A resolver that throws surfaces as a typed `load-failed`, caches nothing, and
// is retried on the next queue movement. It is never silent.
player.on('error', (e) => { if (e.code === 'load-failed') showRetry(e.message) })

// Swap it at runtime — a token refresh, or switching servers. `null` removes it.
player.setSourceResolver(resolveSource)
```

## Constraints this shape runs into

| Constraint | What to do |
|---|---|
| A resolver must be deterministic while an entry is queued | mpv opens each entry twice and reuses the prefetched stream only when the two URLs are byte-identical. Mint once per track, not once per call, and size `resolverTtlMs` to cover a track |
| A fresh nonce per call defeats prefetching | The boundary then opens cold — hundreds of milliseconds and an audible underrun instead of a seamless handover |
| Only a miss at play time holds mpv | Resolution runs ahead for the current and next entries, from mpv's own playlist, so it follows `next()`, repeat and shuffle. A resolved entry costs a map lookup and one property write |
| A signature shorter than a track is fine | Sign per track anyway and let the stream outlive the URL; mpv has already opened it |
| Header auth and casting do not mix | The Default Media Receiver cannot attach headers, so `canCastMedia` returns `{ castable: false, reason: 'headers' }`. Signed-query URLs cast; Bearer tokens do not |
| The prefetch half of the resolver needs our binaries | On stock libmpv only the play-time half exists; prefetched entries open unresolved. [Engine](../engine.md) |

[Full contract](../../packages/player/README.md#dynamic-source-resolution-signed-urls-transcode-sessions).
