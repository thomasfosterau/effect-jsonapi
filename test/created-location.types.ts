/**
 * Type-level tests for the `Middleware.CreatedLocation` requirement (#236).
 *
 * `Endpoint.create` attaches the middleware, so its requirement must survive
 * every path that builds a create endpoint — `Endpoint.resource` and
 * `Group.resource` / `Group.flat` derive theirs through casts, and a cast that
 * dropped the requirement would let an api type-check and then fail at
 * runtime with `Service not found`. Endpoints that do not create carry none.
 *
 * `Registry.Options.middleware` keeps its pre-#236 type: the router provides
 * `Middleware.CreatedLocationLive` itself, so a custom set of the other two
 * still type-checks — and still runs (`src/Registry.test.ts`).
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions.
 */
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { HttpApiGroup } from "effect/http-api";
import {
  Endpoint,
  FlatQuery,
  Group,
  Middleware,
  Registry,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

declare const created: Middleware.CreatedLocation;

type GroupEndpoints<G> = G extends HttpApiGroup.HttpApiGroup<string, infer E, boolean> ? E : never;

// ---------------------------------------------------------------------------
// Every create carries the requirement
// ---------------------------------------------------------------------------

const createEndpoint = Endpoint.create(Article);
export const createCarries: (typeof createEndpoint)["~Middleware"] = created;

const generated = Endpoint.resource(Article);
export const resourceCarries: (typeof generated)[number]["~Middleware"] = created;

const generatedGroup = Group.resource(Article);
export const groupCarries: GroupEndpoints<typeof generatedGroup>["~Middleware"] = created;

const { group: flatGroup } = Group.flat({
  resource: Article,
  list: FlatQuery.listInput({ maxLimit: 100 }),
  create: Schema.Struct({ title: Schema.NonEmptyString }),
  update: Schema.Struct({ id: Schema.String }),
});
export const flatCarries: GroupEndpoints<typeof flatGroup>["~Middleware"] = created;

// ---------------------------------------------------------------------------
// …and nothing that does not create does
// ---------------------------------------------------------------------------

const readOnly = Endpoint.resource(Article, { endpoints: { create: false } });
// @ts-expect-error — no create endpoint, so no `CreatedLocation` requirement
export const readOnlyCarriesNone: (typeof readOnly)[number]["~Middleware"] = created;

const fetched = Endpoint.get(Article);
// @ts-expect-error — `get` answers 200, never 201
export const getCarriesNone: (typeof fetched)["~Middleware"] = created;

// ---------------------------------------------------------------------------
// `Registry` still takes a pre-#236 middleware set
// ---------------------------------------------------------------------------

export const registryOptions: Registry.Options<never> = {
  middleware: Layer.mergeAll(
    Middleware.ContentNegotiationPassthrough,
    Middleware.schemaErrorsLayer(),
  ),
};
