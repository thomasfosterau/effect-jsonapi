/**
 * Type-level tests for the sparse fieldsets of a family's members (#350).
 *
 * A `Resource.family`'s `type` is its name, never a wire type: a response
 * carries the family's members, each under its own type. So `fields: true`
 * declares `fields[TYPE]` for each member of every family the response can
 * carry (beside the family name, which stays declared), and the default
 * document of an endpoint declaring `fields` makes those members partial
 * (#322). The runtime half is `src/Query.fieldsets.test.ts` (whose
 * `expectFieldsets` also pins the runtime key set against the type's) and
 * `src/Endpoint.sparse.test.ts`.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions. Every negative assertion is paired with a
 * positive control.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint } from "effect/http-api";
import { Endpoint, Handlers, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
const Editor = Resource.extend(Node, "editors", {
  inheritId: true,
  attributes: { level: Schema.String },
});
const Reviewer = Resource.extend(Node, "reviewers", {
  inheritId: true,
  attributes: { score: Schema.String },
});
const AnyNode = Resource.family(Node, [Editor, Reviewer]);
const Holder = Resource.make("holders", {
  attributes: { label: Schema.String },
  relationships: { node: Relationship.one(() => AnyNode) },
});
const Board = Resource.make("boards", {
  attributes: { title: Schema.String },
  relationships: { holders: Relationship.many(() => Holder) },
});

// The decoded `fields` struct of a query schema, and its keys.
type FieldsOf<Q extends { readonly Type: { readonly fields?: unknown } }> = NonNullable<
  Q["Type"]["fields"]
>;
type FieldsetTypes<Q extends { readonly Type: { readonly fields?: unknown } }> = keyof FieldsOf<Q>;
// The flat `fields[TYPE]` keys of a query schema.
type WireFieldsets<Q extends { readonly Encoded: object }> = Extract<
  keyof Q["Encoded"],
  `fields[${string}]`
>;

// ---------------------------------------------------------------------------
// The member types are declared
// ---------------------------------------------------------------------------

const held = Query.schema(Holder, { fields: true });
assertType<Equals<FieldsetTypes<typeof held>, "holders" | "nodes" | "editors" | "reviewers">>(true);
assertType<
  Equals<
    WireFieldsets<typeof held>,
    "fields[holders]" | "fields[nodes]" | "fields[editors]" | "fields[reviewers]"
  >
>(true);

// Each member's fieldset is its own attributes, inherited ones included.
assertType<FieldsOf<typeof held>>({ editors: ["name", "level"], reviewers: ["name", "score"] });
assertType<FieldsOf<typeof held>>({
  // @ts-expect-error -- `score` is a `reviewers` attribute, not an `editors` one
  editors: ["score"],
});

// A family reached only by an include path: its members are declared once
// `include` reaches it, and not before.
const shallow = Query.schema(Board, { fields: true });
assertType<Equals<FieldsetTypes<typeof shallow>, "boards" | "holders">>(true);
// @ts-expect-error -- `include` is off: no response of this endpoint carries an `editors`
assertType<FieldsOf<typeof shallow>>({ editors: ["level"] });
assertType<FieldsOf<typeof shallow>>({ holders: ["label"] });
const deep = Query.schema(Board, { include: true, fields: true });
assertType<
  Equals<FieldsetTypes<typeof deep>, "boards" | "holders" | "nodes" | "editors" | "reviewers">
>(true);

// ---------------------------------------------------------------------------
// The members are partial under the default document of `fields: true`
// ---------------------------------------------------------------------------

type SuccessOf<E> = HttpApiEndpoint.Success<E>["Type"];
type DataOf<E> = SuccessOf<E> extends { readonly data: infer D } ? D : never;
type IncludedOf<E> =
  SuccessOf<E> extends { readonly included?: ReadonlyArray<infer M> } ? M : never;
type AttributesOf<R> = R extends { readonly attributes: infer A } ? A : never;

export const get = Endpoint.get(Holder, { fields: true });
assertType<Equals<IncludedOf<typeof get>["type"], "editors" | "reviewers">>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof get>, { readonly type: "editors" }>>,
    { readonly name?: string; readonly level?: string }
  >
>(true);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof get>, { readonly type: "reviewers" }>>,
    { readonly name?: string; readonly score?: string }
  >
>(true);

// The family target of a related endpoint is partial too.
export const related = Endpoint.related(Holder, "node", { fields: true });
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof related>, { readonly type: "editors" }>>,
    { readonly name?: string; readonly level?: string }
  >
>(true);

// A family reached at depth 2.
export const list = Endpoint.list(Board, { include: true, fields: true });
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof list>, { readonly type: "reviewers" }>>,
    { readonly name?: string; readonly score?: string }
  >
>(true);

// So `Handlers.project(query.fields)` fits, with no cast.
const holder = Holder.make({
  id: Holder.Id.make("1"),
  attributes: { label: "L" },
  relationships: { node: { data: { type: "editors", id: Editor.Id.make("7") } } },
});
const editor = Editor.make({ id: Editor.Id.make("7"), attributes: { name: "Eve", level: "lead" } });
const project = Handlers.project<FieldsOf<typeof held>>({ editors: ["level"] });
assertType<SuccessOf<typeof get>>(
  Handlers.data(holder, { included: [editor], onResource: project }),
);

// Without `fields`, the members stay strict.
export const strict = Endpoint.get(Holder);
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof strict>, { readonly type: "editors" }>>,
    { readonly name: string; readonly level: string }
  >
>(true);
assertType<SuccessOf<typeof strict>>(
  // @ts-expect-error -- a projected member does not fit the strict document
  Handlers.data(holder, { included: [editor], onResource: project }),
);
// Positive control.
assertType<SuccessOf<typeof strict>>(Handlers.data(holder, { included: [editor] }));
