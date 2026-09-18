/**
 * JSON:API media type constants.
 *
 * Deliberately import-free: these constants are reachable from the
 * schema-only entry point, so binding them to `effect/unstable/httpapi` here
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
