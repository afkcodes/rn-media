# Spec — documentation site (architect contract)

Owner mandate, verbatim: *"the docs-site should be well thought clean no-bs and
proper examples, API contracts everything well defined, not a single thing
should be missed"* and *"i also want the docs site to look cleaner"*.

Two gates, both hard: **completeness** (every public export documented, every
sample typechecks) and **design** (clean, minimal, not stock Docusaurus).

## 1. Stack (decided)

- **Docusaurus 3** (React + MDX). Versioning, Algolia DocSearch, dark mode,
  code tabs — the RN/TS-ecosystem standard.
- **TypeDoc → Markdown**, plugged into the sidebar, for the **API reference**.
  Hand-written API tables drift and miss exports (caught twice this week); a
  generated reference reading each package's real `index.ts` + TSDoc cannot.
  This is the mechanism that makes "not a single thing missed" provable rather
  than promised.
- **Name centralized** in `docusaurus.config.ts` (one `PROJECT` object:
  npm scope, title, repo URL, domain). No hardcoded `rn-media` in content —
  the npm name is still the `@afkcodes/timbre-*` placeholder and the rename must stay
  cheap (CLAUDE.md).
- **GitHub Pages** via a `docs-deploy.yml` Action on push to main.
- Lives in `website/`. Zero coupling to the packages' build.

## 2. Completeness — the acceptance checklist ("nothing missed")

A page is not done until all of these hold, and the first-pass section must
prove each is enforced, not asserted:

1. **Every export in every `packages/*/src/index.ts` appears in the API
   reference.** A CI check (`website/scripts/check-api-coverage.mjs`) diffs the
   generated API pages against the four `index.ts` export sets and FAILS on any
   symbol that is neither documented nor on an explicit `@internal` allowlist.
   Player 191, media-session 75, audio-session 27, cast 62 index entries are the
   target; internals carry `@internal` in TSDoc so the check is honest.
2. **Every code sample on the site typechecks.** The existing
   `scripts/check-readme-samples.mjs` harness is extended (or a sibling added)
   to extract every ```ts / ```tsx block from `website/**/*.mdx` and run `tsc`
   against the packages' `src`. A ```ts fragment fence opts a partial out, and
   the summary prints how many did.
3. **Every method page states its contract**: signature, each parameter, the
   return, throws/errors, platform differences, and a runnable example. TypeDoc
   carries the first four from TSDoc; the examples come from `@example` blocks
   in the source (which also means the harness typechecks them) — so a method
   with no example is a source gap, fixed in the TSDoc, not the site.
4. **Every option/config type lists every field** with its default. Generated.
5. **Every error code and union member is enumerated.** Generated.
6. **Every guide (recipe) is a complete, runnable program**, ported from
   `docs/recipes/` and kept under the sample harness.
7. **Every platform ceiling is stated** on the relevant page (not only in a
   central limitations list) — sourced from the package parity tables.
8. **Dead-link and dead-anchor check** across the built site is green.

## 3. Information architecture (the full sitemap — nothing omitted)

```
/                      Landing: what it is, the one-screen pitch, install, a
                       live-looking example, the feature matrix, links in.
/getting-started
  /installation        npm + pods; the one Info.plist key; Expo plugin
  /platform-setup       Android (zero-config), iOS (background mode, CarPlay
                        entitlement), Expo prebuild
  /quick-start          the music-player program, end to end
/guides                 (the recipes, each a whole app)
  /music-player  /radio  /podcast-audiobook  /self-hosted-library
  /in-the-car    /cast
/concepts               (the "why" — sourced/linked from ARCHITECTURE)
  /position-anchor      value+at+rate, zero-bridge projection
  /three-channels       playbackState / mediaItem / queue fan-out
  /source-resolver      signed URLs that stay gapless; content:// via fd://
  /session-agnostic     media-session works with any player
  /background-execution one JS runtime, FGS on Android, audio mode on iOS
  /performance          the non-negotiables (anchors, coalescing, no per-frame)
/api                    (GENERATED — TypeDoc, one section per package)
  /player  /media-session  /audio-session  /cast
/platforms
  /android  /ios  /expo
/compare                the matrix + sourcing (from docs/comparison.md)
/engine                 libmpv/FFmpeg forks, LGPL chain (from docs/engine.md)
/roadmap                from PLAN.md · /contributing · /license
```

Every current doc has a destination: recipes → /guides, ARCHITECTURE decisions
→ /concepts (linked, not duplicated — the site references ARCHITECTURE for the
full evidence), comparison → /compare, engine → /engine, specs stay in-repo for
contributors and are linked from /contributing.

## 4. Design direction ("cleaner" — not stock Docusaurus)

Clean, editorial, high-contrast, generous whitespace. The reference points are
Stripe / Linear / the Radix and Tailwind docs: calm, dense-where-it-counts,
never decorative.

- **Type**: one clean sans for UI/prose (Inter or the system stack), one mono
  for code (JetBrains Mono / ui-monospace). A real type scale; large readable
  body (16–17px), tight headings. No more than two families.
- **Palette**: a near-neutral base (not Docusaurus green), one restrained
  accent used only for links/active-nav/focus. True dark mode, not inverted
  grey. Code blocks with a calm, legible theme in both modes.
- **Layout**: three-column on wide (nav · content · page-toc), generous line
  length cap (~72ch), sticky minimal top bar. No hero gimmicks, no emoji
  bullets, no marketing fluff — "no-bs" is a design rule here.
- **Components**: platform tabs (iOS/Android) as a first-class code-tab; an
  API-signature block style (monospace, param table) shared by every generated
  page; a "constraint" callout (one line, muted) distinct from a "warning".
- **Home**: one screen — name, one sentence, install, a single real example,
  the matrix. Not a landing-page funnel.
- Swizzle only what the look needs; keep upgrades cheap. All design tokens in
  one `src/css/custom.css` (+ a small tokens file) so a rebrand is one file.

## 5. First pass (review-gated) — what to build before porting everything

Stand up the whole shell, prove both gates on ONE vertical slice, so the owner
approves the look and the machinery before the content port:

1. `website/` Docusaurus scaffold, TypeScript, the `PROJECT` config object.
2. The **custom theme** (§4) applied — this is what the owner reviews for
   "cleaner": home + nav + one content page + one API page must look finished.
3. **TypeDoc wired** and generating the `@afkcodes/timbre-player` API section in full
   (all 191 index entries visible), plus the coverage check (§2.1) passing.
4. **The MDX sample harness** wired and green on the pages that exist.
5. One **guide** ported end to end (music-player) and one **concept** page
   (position-anchor) — the templates every other page will follow.
6. **GitHub Pages deploy** Action, building on CI (not yet necessarily public).
7. A short `website/README.md`: run, build, add a page, the two gates.

The owner reviews the deployed/served first pass. On approval, the remaining
packages (generated — cheap), guides, concepts and platform pages are ported to
the approved templates.

## 6. Out of scope for pass 1 (named, not forgotten)

Algolia (needs a crawled public site first — local search until then),
versioned docs (turned on at the first npm release, not before), i18n,
runnable/embedded playgrounds, the final domain (name gate). Each is a config
switch on the approved shell, not a redesign.

## 7. Gates to report

Docusaurus `build` clean (no broken links); API-coverage check green with its
count; MDX sample harness green with block count; the four packages' generated
pages present; the design applied on home + one content + one API page (screens
attached); private-fixture grep clean; the name absent outside the one config
object (grep proof).
