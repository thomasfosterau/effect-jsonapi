/**
 * Type-level tests for overrides that extend an endpoint's derived contract:
 * the derived parts keep their types through `Query.extend` and
 * `Document.extend`. The runtime half is `src/Endpoint.override.test.ts`.
 *
 * This file is type-checked by `tsconfig.json`; each `assertType` is an
 * assertion.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint } from "effect/http-api";
import { Document, Endpoint, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const list = Endpoint.list(Article, {
  include: true,
  sort: true,
  query: (derived) =>
    Query.extend(derived, { includeDeleted: Schema.optionalKey(Schema.Literals(["true"])) }),
  success: (derived) => Document.extend(derived, { meta: Schema.Struct({ total: Schema.Int }) }),
});

type QueryOf<E> = HttpApiEndpoint.Query<E>["Type"];
type SuccessOf<E> = HttpApiEndpoint.Success<E>["Type"];
type IncludedOf<E> =
  SuccessOf<E> extends { readonly included?: ReadonlyArray<infer M> } ? M : never;

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ListQuery = QueryOf<typeof list>;
// The added parameter, typed.
assertType<Equals<NonNullable<ListQuery["includeDeleted"]>, "true">>(true);
// The derived families keep their types.
assertType<Equals<NonNullable<ListQuery["include"]>, ReadonlyArray<"author">>>(true);
assertType<Equals<keyof ListQuery, "include" | "sort" | "includeDeleted">>(true);

type ListSuccess = SuccessOf<typeof list>;
assertType<Equals<NonNullable<ListSuccess["meta"]>, { readonly total: number }>>(true);
// `included` is still the derived union.
assertType<Equals<IncludedOf<typeof list>["type"], "people">>(true);

// A plain schema still replaces the default whole.
const replaced = Endpoint.get(Article, {
  query: Schema.Struct({ x: Schema.optionalKey(Schema.String) }),
});
assertType<Equals<keyof QueryOf<typeof replaced>, "x">>(true);
