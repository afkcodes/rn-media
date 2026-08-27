/**
 * The scripted §5 cast verification, as one button — the on-device test bed
 * earning its name. Logs under `[cast-test]` for logcat evidence and shows the
 * verdict summary in place. Lives in the "More" sheet, next to the other
 * engine- and platform-level checks rather than on the main screen.
 */
import React from 'react'
import type { CastSelfTestResult } from '../advanced/cast-selftest'
import { Chip, ChipRow, Detail, Section } from './ui'

export function CastSelfTest({
  ready,
  disabled,
  onSelfTest,
}: {
  ready: boolean
  /** True while a cast session is engaged — the self-test wants the local player. */
  disabled: boolean
  onSelfTest: () => Promise<CastSelfTestResult>
}): React.JSX.Element {
  const [testing, setTesting] = React.useState(false)
  const [summary, setSummary] = React.useState<string | undefined>(undefined)

  return (
    <Section title="Cast self-test">
      <ChipRow>
        <Chip
          label={testing ? 'Verifying…' : 'Run cast self-test'}
          disabled={!ready || testing || disabled}
          onPress={() => {
            setTesting(true)
            setSummary(undefined)
            void onSelfTest()
              .then((result) => setSummary(result.summary))
              .finally(() => setTesting(false))
          }}
        />
      </ChipRow>
      {summary === undefined ? null : <Detail selectable>{summary}</Detail>}
    </Section>
  )
}
