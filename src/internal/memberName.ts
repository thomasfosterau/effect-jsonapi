/**
 * JSON:API 1.1 §Member Names, shared by the schema tier (resource
 * declarations) and the HTTP tier (query parameter names).
 *
 * @internal
 */

// JSON:API 1.1 §Member Names: a legal member name starts and ends with a
// globally allowed character (a-z, A-Z, 0-9, U+0080 and above), and may
// also carry `-`, `_` and a space in between.
const GLOBALLY_ALLOWED = String.raw`a-zA-Z0-9\u{80}-\u{10FFFF}`;
export const MEMBER_NAME = String.raw`[${GLOBALLY_ALLOWED}](?:[${GLOBALLY_ALLOWED}\- _]*[${GLOBALLY_ALLOWED}])?`;
const LEGAL_MEMBER_NAME = new RegExp(String.raw`^${MEMBER_NAME}$`, "u");

/**
 * Whether a name is a legal member name under JSON:API 1.1 §Member Names:
 * at least one character, starting and ending with a globally allowed one
 * (a-z, A-Z, 0-9, U+0080 and above), with `-`, `_` and a space allowed in
 * between. `fooBar`, `x-trace` and `foo_bar` are; `_`, `foo!`, `page.limit`,
 * `ext:param` and `""` are not.
 *
 * @internal
 */
export const isMemberName = (name: string): boolean => LEGAL_MEMBER_NAME.test(name);
