/**
 * Api-wide JSON:API policy: one place that says how an api answers the
 * choices the specification leaves to the server, with today's behaviour as
 * the default.
 *
 * {@link JsonApiConfig} is a `Context.Reference`: an app that never provides
 * it gets {@link defaults}. Provide {@link layer} beneath `Middleware.layer`
 * (or `Middleware.layerWith`) to change a policy for every endpoint the
 * middleware serves, and pass the same option to `Middleware.layerWith` to
 * override it there. Resolution order: middleware option, then
 * `JsonApiConfig`, then {@link defaults}.
 *
 * Two presets name a whole policy: {@link strict}, today's behaviour and the
 * default, and {@link lenient}, for an api migrating to JSON:API. Pass either
 * to {@link layer}, or spread one and override a member.
 *
 * Every member here is read when the middleware layer is **built**, so a
 * policy is fixed for the api's lifetime. Policies that shape a schema
 * (the undeclared-member error cap, page bounds, include depth, idempotency)
 * are fixed when the resource or endpoint is defined, before any layer
 * exists, and stay options of `Resource.make` and the `Endpoint`
 * constructors.
 *
 * @since 0.23.0
 */
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

/**
 * What the content-negotiation middleware answers to an `Accept` header that
 * names no instance of the JSON:API media type and no wildcard covering it
 * (`application/json`, `text/html`).
 *
 * - `"notAcceptable"` (the default): 406 Not Acceptable.
 * - `"serve"`: answer with the JSON:API document anyway, as RFC 9110 §12.5.1
 *   lets a server do with its only representation. JSON:API 1.1 §Server
 *   Responsibilities requires a 406 only when every JSON:API instance in
 *   `Accept` carries a disallowed parameter, so this stays conformant: an
 *   `Accept` that does name the JSON:API media type is still judged by that
 *   rule.
 *
 * @since 0.23.0
 * @category models
 */
export type AcceptWithoutJsonApi = "notAcceptable" | "serve";

/**
 * What the middleware does with a request's sparse fieldsets on the encoded
 * 2xx document (JSON:API 1.1 §Sparse Fieldsets: an endpoint MUST NOT include
 * fields the request excludes).
 *
 * - `"project"` (the default): remove them, in the primary data and in
 *   `included` alike.
 * - `"verify"`: answer a document carrying one with the opaque JSON:API 500.
 * - `"handler"`: leave fieldsets to the handler, unchecked.
 *
 * @since 0.23.0
 * @category models
 */
export type SparseFieldsets = "project" | "verify" | "handler";

/**
 * What the middleware does with a query parameter whose family base name is
 * not one of the specification's families and that the endpoint does not
 * declare: a reserved all-lowercase name (`?lang=en`), an extension's, or one
 * that is not a legal member name.
 *
 * - `"reject"` (the default): 400 naming it, as JSON:API 1.1 requires.
 * - `"ignore"`: pass it over. Undeclared spec families (`include`, `fields`,
 *   `sort`, `page`, `filter`) are still refused.
 *
 * @since 0.23.0
 * @category models
 */
export type UnknownQueryParameters = "reject" | "ignore";

/**
 * The api-wide policies. Each member is optional in {@link layer}'s options
 * and falls back to {@link defaults}.
 *
 * @since 0.23.0
 * @category models
 */
export interface Policy {
  /**
   * The JSON:API extension URIs the api supports (e.g.
   * `Atomic.EXTENSION_URI`). A media type naming any other is answered 415
   * / 406. Defaults to none.
   */
  readonly extensions: ReadonlyArray<string>;
  /**
   * What an `Accept` naming no JSON:API instance is answered with; see
   * {@link AcceptWithoutJsonApi}. Defaults to `"notAcceptable"`.
   */
  readonly acceptWithoutJsonApi: AcceptWithoutJsonApi;
  /**
   * Family base names the api accepts on every endpoint although the
   * specification would have them answered 400: see
   * `Middleware.QueryParameterOptions.allowedQueryParameters`, whose rules
   * apply to each entry. Defaults to `["_"]`, jQuery's cache-buster.
   */
  readonly allowedQueryParameters: ReadonlyArray<string>;
  /**
   * What a query parameter outside the specification's families that the
   * endpoint does not declare is answered with; see
   * {@link UnknownQueryParameters} and
   * `Middleware.QueryParameterOptions.unknownQueryParameters`. Defaults to
   * `"reject"`.
   */
  readonly unknownQueryParameters: UnknownQueryParameters;
  /**
   * `false` skips the middleware's full-linkage check on every encoded
   * response; see `Middleware.SchemaErrorsOptions.checkLinkage`. Defaults to
   * `true`.
   */
  readonly checkLinkage: boolean;
  /**
   * `false` leaves `Vary` to the api, rather than the middleware adding
   * `Accept` to every response it handles; see
   * `Middleware.VaryOptions.varyAccept`. Defaults to `true`.
   */
  readonly varyAccept: boolean;
  /**
   * What the middleware does with a request's sparse fieldsets on the
   * encoded document; see {@link SparseFieldsets} and
   * `Middleware.SchemaErrorsOptions.sparseFieldsets`. Defaults to
   * `"project"`.
   */
  readonly sparseFieldsets: SparseFieldsets;
}

/**
 * The options of {@link layer} and {@link make}: any subset of
 * {@link Policy}.
 *
 * @since 0.23.0
 * @category models
 */
export type Options = Partial<Policy>;

/**
 * Today's behaviour, the policy an app gets when it provides no
 * {@link JsonApiConfig}: no extensions, a 406 for an `Accept` without the
 * JSON:API media type, `_` admitted as a query parameter, the full-linkage
 * check on, `Vary: Accept` on every response, and sparse fieldsets applied to
 * every encoded document.
 *
 * @since 0.23.0
 * @category constants
 */
export const defaults: Policy = {
  extensions: [],
  acceptWithoutJsonApi: "notAcceptable",
  allowedQueryParameters: ["_"],
  unknownQueryParameters: "reject",
  checkLinkage: true,
  varyAccept: true,
  sparseFieldsets: "project",
};

/**
 * A complete {@link Policy} from a subset: each member given, else its
 * {@link defaults} value.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert"
 * import { JsonApiConfig } from "@thomasfosterau/effect-jsonapi"
 *
 * const policy = JsonApiConfig.make({ acceptWithoutJsonApi: "serve" })
 * strictEqual(policy.acceptWithoutJsonApi, "serve")
 * strictEqual(policy.checkLinkage, true)
 * ```
 *
 * @since 0.23.0
 * @category constructors
 */
export const make = (options?: Options): Policy => ({ ...defaults, ...options });

/**
 * The strict preset: {@link defaults}, today's behaviour. Every choice the
 * specification leaves open is answered the strictest conformant way:
 * unknown query parameters are a 400, a non-JSON:API `Accept` a 406, and the
 * middleware checks full linkage and projects sparse fieldsets on every
 * response.
 *
 * @since 0.23.0
 * @category presets
 */
export const strict: Policy = defaults;

/**
 * The lenient preset, for an api migrating to JSON:API whose clients don't
 * yet speak it strictly: it serves an `Accept: application/json` client
 * instead of answering 406, and ignores query parameters outside the
 * specification's families instead of answering 400. Everything else is
 * {@link strict}'s: the specification's families are still checked, full
 * linkage still holds, sparse fieldsets are still projected.
 *
 * Undeclared members of a request body are a schema's choice, fixed when the
 * resource is defined; pair this with `Resource.make(type, { undeclaredMembers:
 * "ignore", … })` to accept those too.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { JsonApiConfig, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * const ApiLive = HandlersLive.pipe(
 *   Layer.provideMerge(Middleware.layer),
 *   Layer.provide(JsonApiConfig.layer(JsonApiConfig.lenient))
 * )
 * ```
 *
 * @since 0.23.0
 * @category presets
 */
export const lenient: Policy = make({
  acceptWithoutJsonApi: "serve",
  unknownQueryParameters: "ignore",
});

/**
 * The api-wide policy, read by the middleware layers when they are built.
 * Unprovided, it is {@link defaults}.
 *
 * @since 0.23.0
 * @category services
 */
export const JsonApiConfig: Context.Reference<Policy> = Context.Reference<Policy>(
  "effect-jsonapi/JsonApiConfig",
  { defaultValue: () => defaults },
);

/**
 * Provides {@link JsonApiConfig}. Provide it beneath the middleware layer, so
 * the middleware reads it when it is built.
 *
 * `allowedQueryParameters` entries are checked when the middleware layer is
 * built: an entry the check would refuse
 * (`Middleware.InvalidAllowedQueryParameter`) fails that build.
 *
 * @example
 * ```ts
 * import { Layer } from "effect"
 * import { Atomic, JsonApiConfig, Middleware } from "@thomasfosterau/effect-jsonapi"
 *
 * const HandlersLive: Layer.Layer<never> = Layer.empty
 *
 * // Serve `Accept: application/json` clients, and support the atomic
 * // extension, across the whole api.
 * const ApiLive = Layer.mergeAll(HandlersLive).pipe(
 *   Layer.provideMerge(Middleware.layer),
 *   Layer.provide(
 *     JsonApiConfig.layer({
 *       acceptWithoutJsonApi: "serve",
 *       extensions: [Atomic.EXTENSION_URI]
 *     })
 *   )
 * )
 * ```
 *
 * @since 0.23.0
 * @category layers
 */
export const layer = (options?: Options): Layer.Layer<never> =>
  Layer.succeed(JsonApiConfig, make(options));
