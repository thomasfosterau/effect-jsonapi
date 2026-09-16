/**
 * JSON:API media type constants.
 *
 * Deliberately dependency-free: these are strings from the specification, and
 * every module that needs one — including `Schema`-only modules like `Atomic`
 * — must be able to reach them without resolving `effect/unstable/httpapi`.
 * The schema combinators that *do* need it live in `./body.js`.
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
export const MEDIA_TYPE = "application/vnd.api+json"

/**
 * The atomic operations extension URI, per https://jsonapi.org/ext/atomic/
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_EXTENSION_URI = "https://jsonapi.org/ext/atomic"

/**
 * The JSON:API media type carrying the atomic operations `ext` parameter.
 *
 * @since 0.1.0
 * @category constants
 * @internal
 */
export const ATOMIC_MEDIA_TYPE = `${MEDIA_TYPE};ext="${ATOMIC_EXTENSION_URI}"`
