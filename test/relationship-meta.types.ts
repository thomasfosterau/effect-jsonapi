/**
 * Type-level tests for a typed relationship `meta` (#513):
 *
 * - a relationship's `meta` option types its relationship object's `meta` in
 *   the resource's `Type`, and so in `Document.wire`'s and the flat documents';
 * - `Document.wire`'s `toManyMeta` narrows every to-many arm, inline and
 *   paginated, and leaves a to-one arm as declared;
 * - an `Assemble.ResourceDocument` over the resource's own `Type` fits the
 *   flat `get` document with no cast — what `ResourceHandlers` answers is
 *   what the endpoint declares.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as R from "effect/Record";
import {
  Assemble,
  Document,
  Endpoint,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T[] => [];

const Count = Schema.Struct({ totalCount: Schema.Finite });
const Ballot = Resource.make("ballots", { attributes: { label: Schema.String } });
const Contest = Resource.make("contests", {
  attributes: { name: Schema.String },
  relationships: {
    ballots: Relationship.many(() => Ballot, { meta: Count }),
    chair: Relationship.one(() => Ballot),
  },
});

type Relationships = NonNullable<(typeof Contest.Type)["relationships"]>;
export const declared =
  assertTrue<
    Equals<
      Pick<Relationships["ballots"], "meta">,
      { readonly meta?: { readonly totalCount: number } }
    >
  >();
// A relationship without the option keeps the open record.
export const open =
  assertTrue<
    Equals<
      Pick<Relationships["chair"], "meta">,
      { readonly meta?: R.ReadonlyRecord<string, unknown> }
    >
  >();

// @ts-expect-error a declared meta is not the open record
export const notOpen: Relationships["ballots"]["meta"] = { totalCount: "many" };

// `toManyMeta` narrows a to-many arm declared without a meta, and leaves a
// to-one arm alone.
const Plain = Resource.make("plains", {
  attributes: { name: Schema.String },
  relationships: {
    ballots: Relationship.many(() => Ballot),
    history: Relationship.paginated(() => Ballot),
    chair: Relationship.optional(() => Ballot),
  },
});
const WirePlain = Document.wire(Plain, { toManyMeta: Count });
type Wired = NonNullable<(typeof WirePlain.Type)["relationships"]>;
export const narrowedMany =
  assertTrue<
    Equals<Pick<Wired["ballots"], "meta">, { readonly meta?: { readonly totalCount: number } }>
  >();
export const narrowedPaginated =
  assertTrue<
    Equals<Pick<Wired["history"], "meta">, { readonly meta?: { readonly totalCount: number } }>
  >();
export const untouchedToOne =
  assertTrue<
    Equals<Pick<Wired["chair"], "meta">, { readonly meta?: R.ReadonlyRecord<string, unknown> }>
  >();

// What `Assemble.resource` answers over the resource's own Type fits the flat
// `get` document's primary data — the relationship metas included — with no
// re-labelling cast. (`included` is the walk's loose registry type, typed
// separately.)
const GetDocument = Endpoint.ResourceDocument(Contest);
export const fits = (
  document: Assemble.ResourceDocument<typeof Contest.Type>,
): (typeof GetDocument.Type)["data"] => document.data;

// The same through the per-call override, for a resource that declares none.
const PlainGetDocument = Endpoint.ResourceDocument(Plain, { toManyMeta: Count });
export const plainMeta = (
  document: (typeof PlainGetDocument.Type)["data"],
): Option.Option<{ readonly totalCount: number }> =>
  Option.fromUndefinedOr(document.relationships?.ballots.meta);
export const plainMetaIsNarrow = (document: (typeof PlainGetDocument.Type)["data"]) =>
  // @ts-expect-error the narrowed meta has no open members
  document.relationships?.ballots.meta?.anything;
