import CodeBlock from '@theme/CodeBlock'
import React from 'react'

import { PROJECT, pkg } from '../project'

/**
 * The name components. Every reference to the project's name or npm scope in
 * prose goes through one of these, so nothing under `docs/` or `src/pages/`
 * hardcodes it — the rename stays a one-file edit (see src/project.ts).
 *
 * Code samples still import the literal `@timbre/*` specifier: that string is
 * executable and is what the MDX sample harness typechecks against the
 * packages' source. Those are the only literal occurrences, and they are meant
 * to be literal.
 */

export function ProjectName(): React.JSX.Element {
  return <>{PROJECT.name}</>
}

export function NpmScope(): React.JSX.Element {
  return <code>{PROJECT.scope}</code>
}

/** `<Pkg name="player" />` → `@timbre/player`. */
export function Pkg({ name }: { name: string }): React.JSX.Element {
  return <code>{pkg(name)}</code>
}

export function RepoLink({
  children,
}: {
  children?: React.ReactNode
}): React.JSX.Element {
  return <a href={PROJECT.repoUrl}>{children ?? PROJECT.repoUrl}</a>
}

/**
 * A link to a file in the repository, built from PROJECT so the concept pages
 * can cite ARCHITECTURE.md etc. without hardcoding the org/repo path.
 *
 * `<RepoFile path="ARCHITECTURE.md">ARCHITECTURE §7</RepoFile>`
 */
export function RepoFile({
  path,
  children,
}: {
  path: string
  children?: React.ReactNode
}): React.JSX.Element {
  const href = `${PROJECT.repoUrl}/blob/main/${path}`
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children ?? path}
    </a>
  )
}

/**
 * `<Install packages={['player', 'media-session']} />` renders the real install
 * line from PROJECT — no scope hardcoded in the page.
 */
export function Install({
  packages = [...PROJECT.packages],
  peer = 'react-native-nitro-modules',
}: {
  packages?: string[]
  peer?: string | false
}): React.JSX.Element {
  const specs = packages.map((name) => pkg(name))
  if (peer) specs.push(peer)
  return (
    <CodeBlock language="bash">{`npm install ${specs.join(' ')}`}</CodeBlock>
  )
}

/** One muted line — a platform constraint, distinct from a warning. */
export function Constraint({
  children,
}: {
  children: React.ReactNode
}): React.JSX.Element {
  return <div className="rn-constraint">{children}</div>
}
