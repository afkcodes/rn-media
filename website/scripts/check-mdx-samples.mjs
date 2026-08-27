#!/usr/bin/env node
// @ts-check
/**
 * MDX sample typechecker — the site half of the "docs whose samples typecheck"
 * gate (CLAUDE.md), a sibling to the repo's scripts/check-readme-samples.mjs.
 *
 * It extracts every ```ts / ```tsx fenced block out of every `website/**\/*.mdx`
 * page, writes each as a standalone module, and runs `tsc --noEmit` over them
 * with `@rn-media/*` mapped to the workspace packages' `src` — the real export
 * surface, not a built `lib/`. A sample that drifts from the code becomes a
 * build error with an `.mdx:LINE` on it.
 *
 * It mirrors the README harness deliberately: same module-mapping, same tiny
 * typed AMBIENTS/MODULES allowance for identifiers the prose introduces, same
 * ```ts fragment opt-out, same one-project-per-file isolation. See that file's
 * header for the rationale behind each choice.
 *
 * Usage:
 *   node scripts/check-mdx-samples.mjs           # extract + typecheck
 *   node scripts/check-mdx-samples.mjs --list    # what would be checked
 *   node scripts/check-mdx-samples.mjs --keep    # keep .mdx-samples/ on success
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEBSITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(WEBSITE_ROOT)
const OUT_DIR = join(WEBSITE_ROOT, '.mdx-samples')

if (!resolve(OUT_DIR).startsWith(resolve(WEBSITE_ROOT))) {
  throw new Error('refusing to operate outside the website dir')
}

/** A package the docs document but the samples do not depend on. */
const ASYNC_STORAGE = `
declare module '@react-native-async-storage/async-storage' {
  const AsyncStorage: {
    getItem(key: string): Promise<string | null>
    setItem(key: string, value: string): Promise<void>
  }
  export default AsyncStorage
}
`

/**
 * The catalogue / back end the guide samples are written against — identical to
 * the README harness's, because the site's guides are the same programs.
 */
const RECIPE_BACKEND = `
declare const service: import('@rn-media/media-session').MediaServiceApi
declare const station: { id: string; name: string; url: string; logoUri: string }
declare const episode: { id: string; url: string }
declare const progress: {
  get(id: string): number | undefined
  set(id: string, position: number): void
  delete(id: string): void
}
declare const server: string
declare const token: string
declare const auth: { isSignedIn(): Promise<boolean> }
declare const catalogue: {
  albums(): Promise<{ id: string; title: string; artist: string; coverUrl: string }[]>
  tracks(albumId: string): Promise<CatalogueTrack[]>
  track(id: string): Promise<CatalogueTrack>
  recent(limit: number): Promise<CatalogueTrack[]>
  search(query: string, focus?: import('@rn-media/media-session').SearchFocus): Promise<CatalogueTrack[]>
}
interface CatalogueTrack {
  id: string
  title: string
  artist: string
  coverUrl: string
  streamUrl: string
  explicit?: boolean
}
declare const downloads: { on(event: 'complete', fn: () => void): void }
declare function banner(message: string): void
declare function badge(text: string | number): void
declare function clearBadge(): void
declare function showRetry(message: string): void
declare function setChapterUi(index: number | undefined): void
declare function setStationLine(
  name: string | undefined,
  genre: string | undefined,
  bitrate: string | undefined
): void
declare function Bar(): import('react').JSX.Element
`

/**
 * Identifiers a page's prose introduces. Typed — nothing is `any`, so a sample
 * cannot pass by accident. Keyed by page slug (see PAGES).
 *
 * @type {Record<string, string>}
 */
const AMBIENTS = {
  home: '',
  intro: '',
  'concept-position-anchor': '',
  'guide-music-player': RECIPE_BACKEND,
}

/** A `./library` module a guide's prose imports, written next to the sample. */
const LIBRARY_MODULE = `
export interface Track {
  id: string
  title: string
  artist: string
  album: string
  artworkUri: string
  durationMs: number
  url: string
}
export const storage = {
  getItem: (_key: string): Promise<string | null> => Promise.resolve(null),
  setItem: (_key: string, _value: string): Promise<void> => Promise.resolve(),
}
`

const UI_MODULE = `
export declare function Slider(props: {
  value: number
  minimumValue: number
  maximumValue: number
  onSlidingComplete: (value: number) => void
}): import('react').JSX.Element
`

/** @type {Record<string, Record<string, string>>} */
const MODULES = {
  'guide-music-player': { 'library.ts': LIBRARY_MODULE, 'ui.ts': UI_MODULE },
}

/**
 * Every MDX page that carries samples, in report order. A page absent here is
 * still checked with an empty allowance — add an entry only when its prose
 * needs an ambient or a module.
 */
const PAGES = [
  { slug: 'home', file: 'src/home-example.mdx' },
  { slug: 'intro', file: 'docs/intro.mdx' },
  { slug: 'guide-music-player', file: 'docs/guides/music-player.mdx' },
  { slug: 'concept-position-anchor', file: 'docs/concepts/position-anchor.mdx' },
]

/** `@rn-media/*` resolves to the workspace source, three levels up from a slug. */
const PATHS = {
  '@rn-media/player': ['../../../packages/player/src'],
  '@rn-media/audio-session': ['../../../packages/audio-session/src'],
  '@rn-media/media-session': ['../../../packages/media-session/src'],
  '@rn-media/cast': ['../../../packages/cast/src'],
}

/**
 * @typedef {object} Block
 * @property {string} slug
 * @property {string} file       page path, website-relative
 * @property {number} startLine
 * @property {'ts'|'tsx'} lang
 * @property {boolean} fragment
 * @property {string} code
 * @property {string} out        generated file, website-relative
 */

/**
 * @param {string} slug
 * @param {string} file
 * @returns {Block[]}
 */
function extract(slug, file) {
  const lines = readFileSync(join(WEBSITE_ROOT, file), 'utf8').split('\n')
  /** @type {Block[]} */
  const blocks = []
  let index = 0

  for (let i = 0; i < lines.length; i++) {
    const open = /^```(\S+)(?:\s+(\S+))?\s*$/.exec(lines[i] ?? '')
    if (!open) continue

    let end = i + 1
    while (end < lines.length && lines[end] !== '```') end++

    const lang = open[1]
    if (lang === 'ts' || lang === 'tsx') {
      index++
      blocks.push({
        slug,
        file,
        startLine: i + 2,
        lang,
        fragment: open[2] === 'fragment',
        code: lines.slice(i + 1, end).join('\n'),
        out: join('.mdx-samples', slug, `${String(index).padStart(2, '0')}.${lang}`),
      })
    }

    i = end
  }

  return blocks
}

/**
 * @param {Block} block
 * @returns {string}
 */
function render(block) {
  const isModule = /^\s*(?:import|export)\b/m.test(block.code)
  const prelude = `// ${block.file}:${block.startLine} — generated by website/scripts/check-mdx-samples.mjs; do not edit`
  return `${prelude}\n${block.code}${isModule ? '' : '\nexport {}\n'}`
}

/** @param {Block[]} blocks */
function writeProjects(blocks) {
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(join(OUT_DIR, '.gitignore'), '*\n')

  const compilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    noFallthroughCasesInSwitch: true,
    noImplicitReturns: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
    allowUnreachableCode: false,
    allowUnusedLabels: false,
    noEmit: true,
    isolatedModules: false,
    jsx: 'react-jsx',
    module: 'esnext',
    moduleResolution: 'bundler',
    target: 'esnext',
    types: [],
    skipLibCheck: true,
    paths: PATHS,
  }

  for (const page of PAGES) {
    const dir = join(OUT_DIR, page.slug)
    mkdirSync(dir, { recursive: true })

    writeFileSync(
      join(dir, '__ambients.d.ts'),
      `// Identifiers ${page.file}'s prose introduces.\n` +
        `// See AMBIENTS in website/scripts/check-mdx-samples.mjs.\n` +
        `${(AMBIENTS[page.slug] ?? '').trimStart()}`
    )

    for (const [name, source] of Object.entries(MODULES[page.slug] ?? {})) {
      writeFileSync(join(dir, name), source.trimStart())
    }

    writeFileSync(
      join(dir, 'tsconfig.json'),
      `${JSON.stringify(
        {
          extends: '@react-native/typescript-config',
          compilerOptions,
          include: ['**/*.ts', '**/*.tsx'],
        },
        null,
        2
      )}\n`
    )
  }

  for (const block of blocks) {
    if (block.fragment) continue
    writeFileSync(join(WEBSITE_ROOT, block.out), render(block))
  }
}

/**
 * @param {Block[]} blocks
 * @param {string} output
 * @returns {string}
 */
function remap(blocks, output) {
  /** @type {Map<string, Block>} */
  const byOut = new Map(blocks.map((b) => [b.out.replace(/\\/g, '/'), b]))

  return output.replace(
    /(^|\s)([^\s(]*\.mdx-samples\/[^\s(]+?)\((\d+),(\d+)\)/gm,
    (match, lead, file, line, column) => {
      const key = file.replace(/\\/g, '/').replace(/^.*?\.mdx-samples\//, '.mdx-samples/')
      const block = byOut.get(key)
      if (!block) return match
      return `${lead}${block.file}(${block.startLine + Number(line) - 2},${column})`
    }
  )
}

/** The packages are written in TypeScript 7; resolve their `tsc`, not the root 6.x. */
function resolveTsc() {
  const candidates = [
    'packages/player/node_modules/typescript/bin/tsc',
    'apps/example/node_modules/typescript/bin/tsc',
    'node_modules/typescript/bin/tsc',
  ].map((c) => join(REPO_ROOT, c))
  const found = candidates.find((c) => existsSync(c))
  if (!found) throw new Error('no typescript found — run `npm install` at the repo root first')
  return found
}

function main() {
  const args = new Set(process.argv.slice(2))
  const blocks = PAGES.flatMap((p) => extract(p.slug, p.file))

  if (args.has('--list')) {
    for (const b of blocks) {
      console.log(
        `${b.file}:${b.startLine}\t${b.lang}${b.fragment ? ' fragment (skipped)' : ''}\t→ ${b.out}`
      )
    }
    return
  }

  writeProjects(blocks)

  const tsc = resolveTsc()
  let failed = false
  for (const page of PAGES) {
    try {
      execFileSync(process.execPath, [tsc, '--noEmit', '-p', `.mdx-samples/${page.slug}`], {
        cwd: WEBSITE_ROOT,
        stdio: 'pipe',
        encoding: 'utf8',
      })
    } catch (error) {
      failed = true
      const e = /** @type {{stdout?: string, stderr?: string}} */ (error)
      console.error(remap(blocks, `${e.stdout ?? ''}${e.stderr ?? ''}`).trimEnd())
    }
  }

  console.log('')
  for (const page of PAGES) {
    const mine = blocks.filter((b) => b.slug === page.slug)
    const skipped = mine.filter((b) => b.fragment).length
    console.log(
      `  ${page.file.padEnd(38)} ${String(mine.length - skipped).padStart(2)} blocks` +
        (skipped > 0 ? `  (+${skipped} fragment, skipped)` : '')
    )
  }
  const checked = blocks.filter((b) => !b.fragment).length
  console.log(`\ncheck-mdx-samples: ${checked} blocks, ${failed ? 'FAILED' : '0 errors'}\n`)

  if (failed) {
    console.error(`generated sources kept in ${relative(WEBSITE_ROOT, OUT_DIR)}/ for inspection`)
    process.exitCode = 1
  } else if (!args.has('--keep')) {
    rmSync(OUT_DIR, { recursive: true, force: true })
  }
}

try {
  main()
} catch (e) {
  console.error(`check-mdx-samples: ${e instanceof Error ? e.message : String(e)}`)
  process.exit(1)
}
