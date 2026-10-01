/**
 * Type-level tests for the `idempotency` endpoint option.
 *
 * Opting in must do two things to an endpoint's *type*, not just its runtime:
 * declare the `Idempotency-Key` header (optional, or required) so handlers and
 * generated clients see it, and add the `Idempotency.Middleware` requirement so
 * an api carrying an idempotent endpoint cannot be built without a store. An
 * endpoint that does not opt in must be unchanged.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions.
 */
import { Schema } from "effect";
import type { HttpApiGroup } from "effect/http-api";
import { Endpoint, Group, Idempotency, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
});

// ---------------------------------------------------------------------------
// The header the option declares
// ---------------------------------------------------------------------------

const plain = Endpoint.create(Article);
const optional = Endpoint.create(Article, { idempotency: true });
const required = Endpoint.create(Article, { idempotency: "required" });

type PlainRequest = (typeof plain)["~Request"];
type OptionalRequest = (typeof optional)["~Request"];
type RequiredRequest = (typeof required)["~Request"];

declare const optionalRequest: OptionalRequest;
declare const requiredRequest: RequiredRequest;
declare const plainRequest: PlainRequest;

// `true` makes the key optional…
export const optionalKey: string | undefined = optionalRequest.headers["idempotency-key"];
// @ts-expect-error — and it is genuinely optional, so it is not a bare string
export const notRequired: string = optionalRequest.headers["idempotency-key"];

// …`"required"` makes it mandatory.
export const requiredKey: string = requiredRequest.headers["idempotency-key"];

// @ts-expect-error — an endpoint that does not opt in declares no headers at all
export const noHeaders = plainRequest.headers;

// ---------------------------------------------------------------------------
// The middleware requirement the option adds
// ---------------------------------------------------------------------------

export const carriesMiddleware: (typeof optional)["~Middleware"] =
  null as unknown as Idempotency.Middleware;
export const requiredCarriesMiddleware: (typeof required)["~Middleware"] =
  null as unknown as Idempotency.Middleware;

// @ts-expect-error — an endpoint that does not opt in carries no store requirement
export const plainCarriesNone: (typeof plain)["~Middleware"] =
  null as unknown as Idempotency.Middleware;

// ---------------------------------------------------------------------------
// `update`, `delete` and `operations` carry the same option
// ---------------------------------------------------------------------------

const updated = Endpoint.update(Article, { idempotency: true });
const deleted = Endpoint.delete(Article, { idempotency: "required" });
const operations = Endpoint.operations([Article], { idempotency: true });

export const updateKey: string | undefined = (null as unknown as (typeof updated)["~Request"])
  .headers["idempotency-key"];
export const deleteKey: string = (null as unknown as (typeof deleted)["~Request"]).headers[
  "idempotency-key"
];
export const operationsKey: string | undefined = (
  null as unknown as (typeof operations)["~Request"]
).headers["idempotency-key"];

// ---------------------------------------------------------------------------
// `Endpoint.resource` / `Group.resource` thread it to every generated write
// ---------------------------------------------------------------------------

const generated = Endpoint.resource(Article, { idempotency: true });
const generatedGroup = Group.resource(Article, {
  idempotency: true,
  endpoints: { delete: { idempotency: "required" } },
});

// The generated set is a union of endpoint types; the writes among them carry
// the middleware, so the whole group does.
export const generatedCarriesMiddleware: (typeof generated)[number]["~Middleware"] =
  null as unknown as Idempotency.Middleware;
type GroupEndpoints =
  typeof generatedGroup extends HttpApiGroup.HttpApiGroup<string, infer E, boolean> ? E : never;
export const generatedGroupCarriesMiddleware: GroupEndpoints["~Middleware"] =
  null as unknown as Idempotency.Middleware;
