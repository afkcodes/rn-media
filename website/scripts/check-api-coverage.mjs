#!/usr/bin/env node
// @ts-check
/**
 * API-coverage gate — the machinery that makes "not a single thing missed"
 * provable rather than promised (spec §2.1).
 *
 * It reads every export name out of `packages/player/src/index.ts`, then diffs
 * that set against the API pages `docusaurus-plugin-typedoc` generated under
 * `docs/api/player/`. A symbol that is neither documented nor carrying
 * `@internal` in its source TSDoc FAILS the build. Internals are honest: they
 * must say `@internal` in the code, which is also what makes TypeDoc drop them.
 *
 * Zero dependencies, plain Node — it runs in CI exactly as it runs locally. It
 * needs the API pages to exist, so run it after `npm run build` (which
 * regenerates them) or after `npm start` has generated them once.
 *
 * Usage:
 *   node scripts/check-api-coverage.mjs
 *   node scripts/check-api-coverage.mjs --list   # print every symbol + status
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const WEBSITE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const REPO_ROOT = dirname(WEBSITE_ROOT)

/**
 * Every published package is under coverage. The list mirrors PROJECT.packages
 * in src/project.ts (kept in sync by hand — this script has zero deps and does
 * not import TS). Each entry's generated pages are diffed against its index.ts.
 */
const PACKAGE_NAMES = ['player', 'audio-session', 'media-session', 'cast']
const PACKAGES = PACKAGE_NAMES.map((name) => ({
  name: `@timbre/${name}`,
  indexFile: join(REPO_ROOT, `packages/${name}/src/index.ts`),
  srcDir: join(REPO_ROOT, `packages/${name}/src`),
  apiDir: join(WEBSITE_ROOT, `docs/api/${name}`),
}))

/** Strip comments so `export { … }` inside a doc block is never miscounted. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

/**
 * Every name a package's index.ts re-exports — values and types alike.
 * Handles `export { … }`, `export type { … }`, and `… from './x'`, with `as`
 * aliases resolved to the exported name.
 *
 * @param {string} indexFile
 * @returns {string[]}
 */
function readExports(indexFile) {
  const source = stripComments(readFileSync(indexFile, 'utf8'))
  /** @type {Set<string>} */
  const names = new Set()

  const blockRe = /export\s+(?:type\s+)?\{([\s\S]*?)\}/g
  let m
  while ((m = blockRe.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const item = raw.trim()
      if (!item) continue
      const asMatch = /(?:\btype\s+)?(\S+)\s+as\s+(\S+)/.exec(item)
      const name = asMatch ? asMatch[2] : item.replace(/^type\s+/, '')
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return [...names].sort()
}

/**
 * Symbols the source marks `@internal` — allowed to be absent from the docs
 * (TypeDoc drops them too). Found by the identifier that follows any doc block
 * containing the tag.
 *
 * @param {string} srcDir
 * @returns {Set<string>}
 */
function readInternalAllowlist(srcDir) {
  /** @type {Set<string>} */
  const internal = new Set()
  const declRe =
    /\/\*\*(?:(?!\*\/)[\s\S])*?@internal[\s\S]*?\*\/\s*(?:export\s+)?(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g

  for (const file of walk(srcDir)) {
    if (!/\.tsx?$/.test(file)) continue
    const source = readFileSync(file, 'utf8')
    let m
    while ((m = declRe.exec(source)) !== null) internal.add(m[1])
  }
  return internal
}

/**
 * The set of symbols that have a generated API page. TypeDoc's `members`
 * strategy writes one file per symbol, named after it.
 *
 * @param {string} apiDir
 * @returns {Set<string>}
 */
function readDocumented(apiDir) {
  /** @type {Set<string>} */
  const documented = new Set()
  const ignore = new Set(['index', 'README', 'globals', 'modules'])
  for (const file of walk(apiDir)) {
    if (!file.endsWith('.md')) continue
    const name = basename(file, '.md')
    if (ignore.has(name)) continue
    documented.add(name)
  }
  return documented
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  if (!existsSync(dir)) return []
  /** @type {string[]} */
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

function main() {
  const list = process.argv.includes('--list')
  let failed = false

  for (const pkg of PACKAGES) {
    if (!existsSync(pkg.apiDir)) {
      console.error(
        `check-api-coverage: no API pages at ${pkg.apiDir}\n` +
          '  Generate them first: `npm run build` (or `npm start`).'
      )
      process.exit(1)
    }

    const exports = readExports(pkg.indexFile)
    const documented = readDocumented(pkg.apiDir)
    const internal = readInternalAllowlist(pkg.srcDir)

    const missing = []
    let internalCount = 0
    for (const name of exports) {
      if (documented.has(name)) {
        if (list) console.log(`  ok        ${name}`)
      } else if (internal.has(name)) {
        internalCount++
        if (list) console.log(`  internal  ${name}`)
      } else {
        missing.push(name)
        if (list) console.log(`  MISSING   ${name}`)
      }
    }

    const documentedCount = exports.length - internalCount - missing.length
    console.log(
      `\n${pkg.name}: ${documentedCount} documented / ${internalCount} internal / ${exports.length} exports`
    )

    if (missing.length > 0) {
      failed = true
      console.error(
        `\n  ${missing.length} export(s) neither documented nor @internal:\n` +
          missing.map((n) => `    - ${n}`).join('\n') +
          '\n\n  Fix: ensure the export renders in the API reference, or mark it' +
          ' `@internal` in its TSDoc if it is not public.'
      )
    }
  }

  console.log('')
  if (failed) process.exit(1)
  console.log('check-api-coverage: OK')
}

main()
