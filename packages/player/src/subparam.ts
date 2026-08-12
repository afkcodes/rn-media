/**
 * mpv's sub-option quoting, in one place.
 *
 * Two different mpv surfaces in this library write `key=value` pairs into a
 * single flat string and hand it to mpv's own parser: the audio filter chain
 * (`af`, see `filters.ts`) and `loadfile`'s per-file option list (see
 * `player.ts`). **Both are read back by the same C function** —
 * `read_subparam()` in mpv's `options/m_option.c` — so both need exactly the
 * same escaping, and getting it wrong is the same bug in two places.
 *
 * `read_subparam` accepts four forms (mpv 0.41.0, `options/m_option.c:1984`):
 * `"…"`, `[…]` (balanced), `%<bytes>%…` (fixed length), and otherwise a bare
 * run of characters ending at the caller's terminator set. Only the third is
 * total — a value containing the terminator, a quote, or a leading `%` breaks
 * the other three — and it is the form mpv's *own* serialiser emits
 * (`append_param`), so using it makes what this library writes byte-identical
 * to what mpv writes.
 *
 * The manual documents the same thing for humans (mpv 0.41.0 `mpv.rst`,
 * "The fixed-length quoting syntax is intended for use with external scripts
 * and programs. It is started with `%` and has the following format:
 * `%n%string_of_length_n`"), and notes the length is counted in **UTF-8 bytes**.
 *
 * @packageDocumentation
 */

/**
 * The character set mpv treats as "needs no escaping" in a sub-option.
 *
 * Verbatim from `options/m_option.c`:
 * `#define NAMECH "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"`.
 * Note it excludes `.`, so every decimal number gets escaped — that is mpv's
 * own behaviour, not ours.
 */
const NAMECH = /^[a-zA-Z0-9_-]*$/

/**
 * UTF-8 byte length. mpv's `%N%` prefix counts *bytes*, not UTF-16 code units.
 *
 * Written out rather than taken from `TextEncoder`, which this package cannot
 * assume: it compiles against `lib: ["esnext"]` with no DOM/Node globals, and
 * Hermes has shipped it only recently.
 */
export function utf8Length(value: string): number {
  let bytes = 0
  for (const codePoint of value) {
    const code = codePoint.codePointAt(0) as number
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * Escape one sub-option key or value the way mpv itself does.
 *
 * @param value - Raw key or value.
 * @returns `value` unchanged when every character is in {@link NAMECH},
 * otherwise mpv's fixed-length form `%<utf8 bytes>%<value>`.
 *
 * @remarks
 * The fixed-length form is chosen over `"…"`/`[…]` because it is the only one
 * with no forbidden characters at all: the parser reads exactly the number of
 * bytes it is told and stops, so a value containing `,`, `:`, `"`, `[`, `]`,
 * `\` or a leading `%` survives verbatim. `read_subparam` parses the count with
 * `bstrtoll(p, &p, 0)` — base *zero*, i.e. a leading `0` would be read as octal
 * — which is safe here because a length is only ever written without leading
 * zeros.
 */
export function escapeSubparam(value: string): string {
  return NAMECH.test(value) ? value : `%${utf8Length(value)}%${value}`
}
