/**
 * JSON:API media type constants.
 *
 * Deliberately import-free: these constants are reachable from the
 * schema-only entry point, so binding them to `effect/http-api` here
 * would put the HTTP surface back into that entry point's graph. The
 * annotation helpers that *do* need `HttpApiSchema` live in the public
 * {@link MediaType} module, re-exported for internal use from `./httpMedia.js`.
 *
 * @since 0.1.0
 * @internal
 */

/**
 * The JSON:API media type, per
 * {@link https://jsonapi.org/format/1.1/#content-negotiation-all the spec}.
 *
 * Re-exported from the package root as `MEDIA_TYPE`.
 *
 * @example
 * ```ts
 * import { MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi"
 *
 * MEDIA_TYPE // "application/vnd.api+json"
 * ```
 *
 * @since 0.1.0
 * @category constants
 */
export const MEDIA_TYPE = "application/vnd.api+json";

/**
 * The atomic operations extension URI, per https://jsonapi.org/ext/atomic/
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_EXTENSION_URI = "https://jsonapi.org/ext/atomic";

/**
 * The base media type of one `Content-Type` / `Accept` entry: everything
 * before the first `;`, trimmed and lowercased.
 *
 * The single definition of "which media type is this?", shared by the server's
 * §5 negotiation (which then inspects the parameters and the `q` weight) and
 * the client's header stamping (which only needs the base type).
 *
 * @since 0.15.0
 * @category utils
 * @internal
 */
export const baseMediaType = (entry: string): string =>
  (entry.split(";", 1)[0] ?? "").trim().toLowerCase();

/**
 * The JSON:API media type carrying an `ext` parameter for the given extension
 * URIs — the exact string the spec calls for, and the one the package's own
 * §5 parser accepts: a single space-separated, double-quoted URI list.
 *
 * The single definition of "the media type this api speaks", shared by the
 * server (response body annotations) and the client (`Accept` /
 * `Content-Type` stamping), so the two cannot drift.
 *
 * @since 0.15.0
 * @category constructors
 * @internal
 */
export const mediaTypeWith = (extensions?: ReadonlyArray<string> | undefined): string =>
  extensions === undefined || extensions.length === 0
    ? MEDIA_TYPE
    : `${MEDIA_TYPE};ext="${extensions.join(" ")}"`;

/**
 * The JSON:API media type carrying the atomic operations `ext` parameter.
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_MEDIA_TYPE = mediaTypeWith([ATOMIC_EXTENSION_URI]);

/** One `;`-separated part of a media type entry, split at its first `=`. */
const parseParameter = (part: string): readonly [name: string, value: string] => {
  const eq = part.indexOf("=");
  const name = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
  const value = eq === -1 ? "" : part.slice(eq + 1).trim();
  return [name, value];
};

/** A parameter value with its surrounding double quotes removed (ext / profile URI lists are quoted). */
const unquote = (value: string): string =>
  value.startsWith('"') && value.endsWith('"') && value.length >= 2 ? value.slice(1, -1) : value;

/**
 * RFC 9110 §12.4.2: `qvalue = ( "0" [ "." 0*3DIGIT ] ) / ( "1" [ "." 0*3("0") ] )`.
 * The `weight` rule is `OWS ";" OWS "q=" qvalue`, so a quoted value is not a
 * `qvalue` either. `Number()` alone would read `""` and `"0x0"` as `0` (a
 * refusal), `"-1"` and `"1e-9"` as weights at or below zero, and `"2"` as a
 * weight above the `1` ceiling.
 */
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;

/**
 * Splits one media type entry into its (lowercased) base type, its media type
 * parameters, and its weight.
 *
 * Per RFC 9110 §12.4.2, `q` is not a media type parameter: it is the weight
 * of an `Accept` entry, and it terminates the media type's parameter list.
 * Everything before `q` is a media type parameter (subject to the ext/profile
 * whitelist); `q` itself and everything after it are accept-extension
 * parameters that belong to the header field, not the media type, and are
 * never checked against that whitelist. Splitting is therefore positional,
 * not a name-based filter: `;profile="…";q=0.8` has one media type parameter;
 * `;q=0.8;foo=bar` has none.
 *
 * `weight` defaults to `1` (RFC 9110 §12.4.2) when the entry carries no `q`,
 * and is `undefined` when the entry carries a malformed `q` — one outside the
 * `qvalue` grammar (`0` to `1`, at most three decimals). The two callers disagree on what a malformed weight
 * means (the §5 middleware treats it as a refusal, a host's representation
 * negotiation as the default weight), so the parser reports it rather than
 * deciding.
 *
 * @internal
 */
export const parseMediaType = (
  entry: string,
): {
  readonly base: string;
  readonly parameters: ReadonlyArray<readonly [name: string, value: string]>;
  readonly weight: number | undefined;
} => {
  const [first, ...rest] = entry.split(";");
  const parameters: Array<readonly [name: string, value: string]> = [];
  let weight: number | undefined = 1;
  for (const part of rest) {
    const [name, value] = parseParameter(part);
    // `q` terminates the media type's parameter list; it and everything after
    // it are accept-extension parameters of the header field.
    if (name === "q") {
      weight = QVALUE.test(value) ? Number(value) : undefined;
      break;
    }
    parameters.push([name, unquote(value)] as const);
  }
  return { base: baseMediaType(first ?? ""), parameters, weight };
};
