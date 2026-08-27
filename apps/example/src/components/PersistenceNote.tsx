/**
 * What the last process left behind, and what this one made of it.
 *
 * The line is the outcome of `restorePersisted` — every branch of its typed
 * result is handled in `src/playback/persistence.ts` and none of them throws, so
 * a first launch, an app downgrade and a truncated write all end up here as
 * prose rather than as a crash.
 *
 * Writing is the easy half: `withPersistence(api, storage)` tees every broadcast
 * to disk, and — since this app broadcasts only on discontinuities — checkpoints
 * the projected position every 30 s of playback on top of that. Android freezes
 * JS timers once the Activity is gone, so this app also checkpoints on the way
 * out of the foreground, which is the last moment JavaScript is guaranteed to
 * run.
 */
import React from 'react'
import { Detail, Section } from './ui'

export const PersistenceNote = React.memo(function PersistenceNote({
  note,
}: {
  note: string
}): React.JSX.Element {
  return (
    <Section title="Persistence & resumption">
      <Detail>{note}</Detail>
      <Detail>
        Force-stop the app while it is paused, then press play on the System UI
        media card: the media service revives this JS runtime, replays the
        command, and `onPlaybackResumption` shows up in logcat. That needs three
        things together — `playbackResumption: true`, the `MediaButtonReceiver`
        in the manifest, and `withPersistence` — and the library reports which
        one is missing on the session-error channel, in the strip above.
      </Detail>
    </Section>
  )
})
