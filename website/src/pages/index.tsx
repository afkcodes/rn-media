import Link from '@docusaurus/Link'
import Layout from '@theme/Layout'
import React from 'react'

import { Install } from '../components/Project'
import HomeExample from '../home-example.mdx'
import { PROJECT } from '../project'
import styles from './index.module.css'

/** The comparison scoreboard — the compact set. Full sourcing lives on /compare. */
const MATRIX: { feature: string; rntp: string; expo: string; video: string; ours: string }[] = [
  { feature: 'Engine', rntp: 'ExoPlayer / AVPlayer', expo: 'ExoPlayer / AVPlayer', video: 'ExoPlayer / AVPlayer', ours: 'libmpv + FFmpeg — our own build' },
  { feature: 'One identical engine, both platforms', rntp: 'no', expo: 'no', video: 'no', ours: 'yes' },
  { feature: 'Multiple players', rntp: 'no', expo: 'yes', video: 'yes', ours: 'yes — one core each' },
  { feature: 'Session layer works with any player', rntp: 'no', expo: 'no', video: 'no', ours: 'yes' },
  { feature: 'Gapless queue', rntp: 'partial', expo: 'yes', video: 'no', ours: 'yes — 25 ms handover' },
  { feature: 'Signed / expiring URLs stay gapless', rntp: 'no', expo: 'no', video: 'no', ours: 'yes' },
  { feature: 'EQ / DSP', rntp: 'no', expo: 'no', video: 'no', ours: '16 filters, 22 presets' },
  { feature: 'Casting (Chromecast)', rntp: 'no', expo: 'no', video: 'app-side', ours: 'yes — both platforms' },
]

function Cell({ value }: { value: string }): React.JSX.Element {
  const yes = value.startsWith('yes')
  const no = value === 'no'
  const cls = yes ? styles.cellYes : no ? styles.cellNo : styles.cellMuted
  return <td className={cls}>{value}</td>
}

export default function Home(): React.JSX.Element {
  return (
    <Layout title={PROJECT.name} description={PROJECT.tagline}>
      <main className={styles.main}>
        <section className={styles.hero}>
          <div className={styles.heroCopy}>
            <h1 className={styles.title}>{PROJECT.name}</h1>
            <p className={styles.tagline}>{PROJECT.tagline}</p>
            <p className={styles.sub}>
              A React Native audio player on libmpv, and a player-agnostic media
              session that keeps the lock screen, notification and background
              playback alive after the UI is gone. Four packages, no
              cross-dependencies.
            </p>
            <div className={styles.installBox}>
              <Install packages={['player', 'audio-session', 'media-session']} />
            </div>
            <div className={styles.cta}>
              <Link className={styles.primaryBtn} to="/docs/intro">
                Get started
              </Link>
              <Link className={styles.secondaryBtn} to="/docs/api/player/">
                API reference
              </Link>
            </div>
          </div>
          <div className={styles.heroExample}>
            <HomeExample />
          </div>
        </section>

        <section className={styles.matrixSection}>
          <h2 className={styles.matrixHeading}>How it compares</h2>
          <div className="table-wrapper">
            <table className={styles.matrix}>
              <thead>
                <tr>
                  <th>Feature</th>
                  <th>track-player</th>
                  <th>expo-audio</th>
                  <th>rn-video</th>
                  <th className={styles.oursHead}>{PROJECT.name}</th>
                </tr>
              </thead>
              <tbody>
                {MATRIX.map((row) => (
                  <tr key={row.feature}>
                    <th scope="row">{row.feature}</th>
                    <Cell value={row.rntp} />
                    <Cell value={row.expo} />
                    <Cell value={row.video} />
                    <Cell value={row.ours} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.matrixNote}>
            Every cell is sourced from each project&rsquo;s own docs. The full
            table, and where each competitor cell came from, is on{' '}
            <Link to="/docs/intro">the docs</Link>.
          </p>
        </section>
      </main>
    </Layout>
  )
}
