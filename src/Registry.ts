/**
 * The handler registry and router: each resource family contributes one
 * {@link Family} — its group name plus the endpoint-name → handler record —
 * and the router registers every handler with `HttpApiBuilder`, wrapped in
 * `ServerErrors.respond`, refusing at module init any family whose handler
 * names do not exactly match its group's endpoint names.
 *
 * ## Typed at declaration, checked at init
 *
 * Declare a family with `satisfies Registry.FamilyFor<typeof group>`: the
 * success channel of every handler is then checked against its endpoint's
 * `success:` schema — the one channel that silently 500s on encode when a
 * producer drifts from its schema. The request half stays loose (per-endpoint
 * typing lives on the family's operations; the HTTP path re-validates
 * through the endpoint schemas), and completeness — every endpoint has a
 * handler, no handler names a missing endpoint — is {@link checkFamily}'s
 * runtime check, run for every family the moment the router is built.
 *
 * ## The router
 *
 * {@link webHandler} builds the Effect router once (route registration only
 * — no I/O) and exposes a Fetch-shaped handler the host's request lifecycle
 * invokes per request with a fresh per-request service context — the
 * database, the viewer, the bindings. The platform services the builder
 * requires for file responses (`FileSystem`, `Path`, `Etag`, `HttpPlatform`)
 * are provided as no-ops, since a JSON:API never serves a file.
 *
 * @since 0.16.0
 */
import type * as Context from "effect/Context";
import { Array as Arr, Effect, FileSystem, Layer, Option, Order, Path, Schema } from "effect";
import type { HttpServerResponse } from "effect/http";
import { Etag, HttpPlatform, HttpRouter } from "effect/http";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpApiBuilder } from "effect/http-api";
import * as Middleware from "./Middleware.js";
import * as ServerErrors from "./ServerErrors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One endpoint handler over the decoded request parts, dispatched by name.
 * `R` is the per-request service catalogue the host's runtime builds.
 *
 * @since 0.16.0
 * @category models
 */
// oxlint-disable-next-line effect/avoid-any -- the request half is dispatched by name; the HTTP path re-validates it
export type RawHandler<R = any> = (request: any) => Effect.Effect<unknown, unknown, R>;

/**
 * The endpoint names a group declares, as a string union.
 *
 * @since 0.16.0
 * @category type-level
 */
export type EndpointNames<G> =
  HttpApiGroup.Endpoints<G> extends { readonly identifier: infer N extends string } ? N : never;

/**
 * The **decoded** success value the named endpoint declares — `Schema.Type`
 * of its `success:` schema, which is what a handler must return and what the
 * response encoder is handed.
 *
 * @since 0.16.0
 * @category type-level
 */
export type EndpointSuccess<G, N extends string> = HttpApiEndpoint.SuccessWithIdentifier<
  HttpApiGroup.Endpoints<G>,
  N
>;

/**
 * One family's handler record, keyed by its group's endpoint names and
 * checked against each endpoint's success schema. `HttpServerResponse`
 * rides alongside because the builder lets a handler answer a raw response
 * (which is what `ServerErrors.respond` does with a failure).
 *
 * @since 0.16.0
 * @category type-level
 */
export type HandlersFor<G> = {
  readonly [N in EndpointNames<G>]: (
    // oxlint-disable-next-line effect/avoid-any -- see `RawHandler`
    request: any,
  ) => Effect.Effect<
    EndpointSuccess<G, N> | HttpServerResponse.HttpServerResponse,
    // oxlint-disable-next-line effect/avoid-any -- the error and requirement channels are checked at the router seam
    any,
    // oxlint-disable-next-line effect/avoid-any -- as above
    any
  >;
};

/**
 * A family checked against its group's endpoint schemas — declare one with
 * `satisfies Registry.FamilyFor<typeof group>`, never with a `: Family`
 * annotation, which erases the group and takes the success channel back to
 * `any`.
 *
 * @since 0.16.0
 * @category models
 */
export interface FamilyFor<G> {
  readonly group: HttpApiGroup.Identifier<G>;
  readonly handlers: HandlersFor<G>;
}

/**
 * A resource family's contribution to the api surface — the erased shape
 * {@link FamilyFor} declarations are collected as, since the list is
 * heterogeneous.
 *
 * @since 0.16.0
 * @category models
 */
// oxlint-disable-next-line effect/avoid-any -- see `RawHandler`
export interface Family<R = any> {
  /** The `HttpApi` group identifier (`"people"`). */
  readonly group: string;
  /** Endpoint name → handler, matching the group's endpoints exactly. */
  readonly handlers: { readonly [endpoint: string]: RawHandler<R> };
}

/**
 * What the registry reads of an `HttpApi`: its groups' endpoint names.
 *
 * @since 0.16.0
 * @category models
 */
export interface ApiLike {
  readonly groups: {
    readonly [id: string]: { readonly endpoints: { readonly [name: string]: unknown } };
  };
}

/**
 * A family in the registry names a group the `HttpApi` does not declare.
 *
 * @since 0.16.0
 * @category errors
 */
export class UnknownFamily extends Schema.TaggedError<UnknownFamily>()("UnknownFamily", {
  group: Schema.String,
  message: Schema.String,
}) {}

/**
 * A family's handler names do not exactly match its group's endpoint names.
 *
 * @since 0.16.0
 * @category errors
 */
export class FamilyMismatch extends Schema.TaggedError<FamilyMismatch>()("FamilyMismatch", {
  group: Schema.String,
  message: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * The module-init drift check: a family whose group is not in the api, or
 * whose handler names don't exactly match its group's endpoint names,
 * throws — before the server can serve a request. Exported so a unit suite
 * can run it over every family without building the router.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { Endpoint, Group, Registry, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const Api = HttpApi.make("blog").add(Group.make(Article, Endpoint.get(Article)))
 *
 * Registry.checkFamily(Api, { group: "articles", handlers: { get: () => Effect.succeed({}) } })
 * try {
 *   Registry.checkFamily(Api, { group: "articles", handlers: {} })
 * } catch (error) {
 *   console.log((error as Registry.FamilyMismatch)._tag)
 * }
 * // → FamilyMismatch
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const checkFamily = (api: ApiLike, family: Family): void => {
  const group = api.groups[family.group];
  if (group === undefined) {
    throw new UnknownFamily({
      group: family.group,
      message: `API family "${family.group}" has no group in the HttpApi`,
    });
  }
  const endpointNames = Arr.sort(Object.keys(group.endpoints), Order.String);
  const handlerNames = Arr.sort(Object.keys(family.handlers), Order.String);
  if (endpointNames.join(",") !== handlerNames.join(",")) {
    throw new FamilyMismatch({
      group: family.group,
      message: `API family "${family.group}" handlers [${handlerNames.join(", ")}] do not match its endpoints [${endpointNames.join(", ")}]`,
    });
  }
};

/**
 * Resolves the raw handler a `group.endpoint` pair registers; `none` when no
 * family registers it.
 *
 * @since 0.16.0
 * @category utils
 */
export const handlerFor = <R>(
  families: ReadonlyArray<Family<R>>,
  group: string,
  endpoint: string,
): Option.Option<RawHandler<R>> =>
  Option.fromNullishOr(families.find((family) => family.group === group)?.handlers[endpoint]);

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

/**
 * The platform services `HttpApiBuilder.layer` requires only for file
 * responses, which a JSON:API never produces: a no-op file system, and the
 * path, etag and platform layers over it.
 *
 * @since 0.16.0
 * @category layers
 */
export const platformLayer: Layer.Layer<
  Etag.Generator | Path.Path | FileSystem.FileSystem | HttpPlatform.HttpPlatform
> = Layer.mergeAll(
  Etag.layer,
  Path.layer,
  FileSystem.layerNoop({}),
  HttpPlatform.layer.pipe(Layer.provide(FileSystem.layerNoop({}))),
);

/**
 * Options of {@link layer} and {@link webHandler}.
 *
 * @since 0.16.0
 * @category models
 */
export interface Options<R> {
  /**
   * The JSON:API middleware layer. Defaults to
   * `Middleware.layerHostNegotiated` — the pairing for a host whose front
   * door runs the `Negotiation` verdict, so the api does not re-negotiate
   * (and reject) a request the host already admitted; its `SchemaErrors`
   * and `CreatedLocation` are live, giving request-validation failures a
   * JSON:API 400 and a create's 201 its `Location` header. Pass
   * `Middleware.layer` for an api that owns its own URLs.
   *
   * The router always provides `Middleware.CreatedLocationLive` beneath this
   * layer, so a set that supplies only `ContentNegotiation` and
   * `SchemaErrors` still serves a create; a `CreatedLocation` in the set
   * takes precedence.
   */
  readonly middleware?: Layer.Layer<Middleware.ContentNegotiation | Middleware.SchemaErrors>;
  /**
   * The boundary every handler is wrapped in. Defaults to
   * `ServerErrors.respond` with no extra arms; pass
   * `(effect) => ServerErrors.respond(effect, { materialise })` to add the
   * application's own.
   */
  readonly respond?:
    | (<A, E>(
        effect: Effect.Effect<A, E, R>,
      ) => Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R>)
    | undefined;
}

/**
 * The honest type of one family's group layer: it provides its group service
 * to `HttpApiBuilder.layer`, and its handlers' leftover service requirements
 * surface as the router's per-request `Requires`.
 *
 * @since 0.16.0
 * @category models
 */
export type FamilyLayer<R> = Layer.Layer<
  HttpApiGroup.Service<string, string>,
  never,
  HttpRouter.Request<"Requires", R>
>;

/**
 * Registers one family's handlers with its `HttpApiBuilder` group, each
 * wrapped in the boundary, after {@link checkFamily}. The generic fold
 * trades the builder's per-endpoint inference for a single registration
 * seam — which is why completeness is the runtime check.
 *
 * @since 0.16.0
 * @category layers
 */
export const familyLayer = <R>(
  // oxlint-disable-next-line effect/avoid-any -- the api's groups are folded dynamically
  api: HttpApi.HttpApi<any, any>,
  family: Family<R>,
  options?: Options<R>,
): FamilyLayer<R> => {
  checkFamily(api, family);
  const respond =
    options?.respond ?? (<A, E>(effect: Effect.Effect<A, E, R>) => ServerErrors.respond(effect));
  // reason: a dynamic fold over the handler record; completeness is the runtime check above
  const fold = (handlers: any): any =>
    Object.entries(family.handlers).reduce(
      (current: any, [name, handler]) =>
        current.handle(name, (request: never) => respond(handler(request))),
      handlers,
    );
  return HttpApiBuilder.group(api, family.group as never, fold) as unknown as FamilyLayer<R>;
};

/**
 * The api's full router layer: `HttpApiBuilder.layer` over every family's
 * {@link familyLayer}, the platform no-ops and the middleware provided, the
 * handlers' per-request services left as the layer's requirement. The
 * middleware is {@link Options.middleware} over
 * `Middleware.CreatedLocationLive`, so a create endpoint is served whatever
 * set the caller passes.
 *
 * @since 0.16.0
 * @category layers
 */
export const layer = <R>(
  // oxlint-disable-next-line effect/avoid-any -- see `familyLayer`
  api: HttpApi.HttpApi<any, any>,
  families: ReadonlyArray<Family<R>>,
  options?: Options<R>,
): Layer.Layer<never, never, HttpRouter.HttpRouter | HttpRouter.Request<"Requires", R>> => {
  const [first, ...rest] = families.map((family) => familyLayer(api, family, options));
  if (first === undefined) throw new Error("Registry.layer: at least one family is required");
  const groups = rest.reduce((merged, next) => Layer.merge(merged, next), first);
  return HttpApiBuilder.layer(api).pipe(
    Layer.provideMerge(groups),
    Layer.provide(platformLayer),
    // `Endpoint.create` requires `CreatedLocation`, which `Options.middleware`
    // does not name: provide the live one under the caller's set, which comes
    // later in the merge and so wins when it carries its own.
    Layer.provide(
      Layer.mergeAll(
        Middleware.CreatedLocationLive,
        options?.middleware ?? Middleware.layerHostNegotiated,
      ),
    ),
  ) as unknown as Layer.Layer<
    never,
    never,
    HttpRouter.HttpRouter | HttpRouter.Request<"Requires", R>
  >;
};

/**
 * The Fetch-shaped api handler {@link webHandler} builds. The caller supplies
 * the per-request service context (built fresh per request by its runtime).
 *
 * @since 0.16.0
 * @category models
 */
export interface WebHandler<R> {
  readonly handler: (request: Request, context: Context.Context<R>) => Promise<Response>;
  readonly dispose: () => Promise<void>;
}

/**
 * Builds the router once and exposes a Fetch-shaped handler: `(request,
 * context) => Promise<Response>`, where `context` carries the per-request
 * services the families' handlers require.
 *
 * @example
 * ```ts
 * import { Context, Effect, Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { Assemble, Endpoint, Group, MEDIA_TYPE, Registry, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 * const Api = HttpApi.make("blog").add(Group.make(Article, Endpoint.get(Article)))
 *
 * const articles = {
 *   group: "articles",
 *   handlers: {
 *     get: ({ params }: { readonly params: { readonly id: string } }) =>
 *       Effect.map(
 *         Assemble.resource({ type: "articles", id: params.id, attributes: { title: "Hi" } }),
 *         (document) => document as never
 *       )
 *   }
 * } satisfies Registry.FamilyFor<typeof Api.groups.articles>
 *
 * const program = Effect.gen(function* () {
 *   const { handler, dispose } = Registry.webHandler(Api, [articles])
 *   const response = yield* Effect.promise(() =>
 *     handler(new Request("http://localhost/articles/1", { headers: { accept: MEDIA_TYPE } }), Context.empty())
 *   )
 *   yield* Effect.promise(dispose)
 *   return response.status
 * })
 * console.log(Effect.runPromise(program).then(console.log))
 * // → 200
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const webHandler = <R = never>(
  // oxlint-disable-next-line effect/avoid-any -- see `familyLayer`
  api: HttpApi.HttpApi<any, any>,
  families: ReadonlyArray<Family<R>>,
  options?: Options<R> & { readonly disableLogger?: boolean | undefined },
): WebHandler<R> => {
  const web = HttpRouter.toWebHandler(layer(api, families, options), {
    disableLogger: options?.disableLogger ?? true,
  });
  return web as unknown as WebHandler<R>;
};
