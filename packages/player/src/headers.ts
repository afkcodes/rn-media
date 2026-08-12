/**
 * Per-source HTTP headers, compiled onto mpv's `http-header-fields`.
 *
 * @packageDocumentation
 */

import { PlayerErrorException } from './errors'

/**
 * HTTP request headers to send for one source, as a plain object.
 *
 * Keys are header names (`'Authorization'`), values are the header values
 * (`'Bearer …'`). Order is the object's own insertion order.
 */
export type HttpHeaders = Readonly<Record<string, string>>

/** The mpv option a {@link HttpHeaders} map compiles to. */
export const HTTP_HEADER_FIELDS_OPTION = 'http-header-fields'

function invalid(message: string): never {
  throw new PlayerErrorException({
    code: 'invalid-state',
    message,
    retryable: false,
  })
}

/**
 * Characters an HTTP header name may not contain.
 *
 * RFC 9110 §5.1 restricts a field name to a `token`, but the check that matters
 * here is narrower and is about *this* transport rather than about the RFC:
 * mpv joins each list item with `\r\n` and hands the result to FFmpeg's
 * `headers` AVOption verbatim (`stream/stream_lavf.c:218`,
 * `talloc_asprintf_append(cust_headers, "%s\r\n", …)`), so a name or value
 * carrying a CR or LF would inject additional request lines. `:` is rejected in
 * a name for the same reason it is the separator.
 */
const FORBIDDEN_IN_NAME = /[\r\n:\0]|^\s|\s$|^$/u
const FORBIDDEN_IN_VALUE = /[\r\n\0]/u

/**
 * Compile a header map into one `http-header-fields` **option value**.
 *
 * @param headers - The header map. An empty map compiles to `undefined`.
 * @returns The option value, or `undefined` when there is nothing to send.
 *
 * @throws {@link PlayerErrorException} with code `invalid-state` when a header
 * name is empty, is padded with whitespace, or contains `:`/CR/LF/NUL, or when
 * a value contains CR/LF/NUL — see {@link FORBIDDEN_IN_NAME}. This is a
 * *request-splitting* guard, not a style check: mpv concatenates these lines
 * into the raw request.
 *
 * @remarks
 * **This is the inner of two escaping layers, and both are real.**
 *
 * `--http-header-fields` is a mpv *string list* option, separated by `,` with
 * backslash escaping (mpv 0.41.0 `mpv.rst`, "String list and path list
 * options": `-set` takes "a list of items (using the list separator, escaped
 * with backslash)"). The parser is `get_nextsep()` in `options/m_option.c:1380`,
 * which treats a `,` preceded by `\` as literal and removes exactly that one
 * backslash. So a header value containing a comma — `Accept: text/html,
 * application/xml`, or a multi-valued `Cache-Control` — must be written `\,`
 * here or it splits
 * into two bogus header lines. That is the bug the audit found: the documented
 * `mpvOptions` workaround for headers was unsafe in precisely the case people
 * reach for it.
 *
 * The **outer** layer is `loadfile`'s own `opt1=value1,opt2=value2` list, which
 * is escaped separately with mpv's fixed-length form (see
 * `subparam.ts: escapeSubparam`) by whoever assembles the file-option string.
 * Keeping the two apart is deliberate: they are different parsers with
 * different rules, and one function doing both would have to know which layer
 * each backslash belonged to.
 */
export function compileHttpHeaderFields(
  headers: HttpHeaders
): string | undefined {
  const fields: string[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (FORBIDDEN_IN_NAME.test(name)) {
      invalid(
        `\`headers\` key '${name}' is not a usable HTTP header name: it must be ` +
          'non-empty, unpadded, and free of `:`, CR, LF and NUL (mpv writes ' +
          'these lines into the request verbatim).'
      )
    }
    if (FORBIDDEN_IN_VALUE.test(value)) {
      invalid(
        `\`headers['${name}']\` contains CR, LF or NUL, which would inject ` +
          'extra lines into the HTTP request.'
      )
    }
    // One list item per header, in mpv's `Name: value` wire form, with every
    // comma escaped for the string-list parser above us.
    // `split`/`join` rather than `replaceAll`, which is ES2021 and needs no
    // engine assumption to be made here for one comma.
    fields.push(`${name}: ${value}`.split(',').join('\\,'))
  }
  return fields.length > 0 ? fields.join(',') : undefined
}
