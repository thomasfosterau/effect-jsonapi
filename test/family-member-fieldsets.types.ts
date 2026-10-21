/**
 * Type-level tests for the sparse fieldsets of a family's members (#350).
 *
 * A `Resource.family`'s `type` is its name, never a wire type: a response
 * carries the family's members, each under its own type. So `fields: true`
 * replaces every family the response can carry by its members (recursively,
 * for a family nested in another), declares `fields[TYPE]` for each, and
 * declares no `fields[<family name>]` (owner decision on #350); the default
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
assertType<Equals<FieldsetTypes<typeof held>, "holders" | "editors" | "reviewers">>(true);
assertType<
  Equals<WireFieldsets<typeof held>, "fields[holders]" | "fields[editors]" | "fields[reviewers]">
>(true);
// The family's name is no fieldset type.
// @ts-expect-error -- `nodes` is the family's name, not a type a response carries
assertType<FieldsOf<typeof held>>({ nodes: ["name"] });

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
assertType<Equals<FieldsetTypes<typeof deep>, "boards" | "holders" | "editors" | "reviewers">>(
  true,
);

// A name-only family: its members, never its name.
const Photo = Resource.make("photos", { attributes: { url: Schema.String } });
const Video = Resource.make("videos", { attributes: { length: Schema.Number } });
const Media = Resource.family("media", [Photo, Video]);
const Gallery = Resource.make("galleries", {
  attributes: { title: Schema.String },
  relationships: { items: Relationship.many(() => Media) },
});
const gallery = Query.schema(Gallery, { fields: true });
assertType<Equals<FieldsetTypes<typeof gallery>, "galleries" | "photos" | "videos">>(true);
assertType<FieldsOf<typeof gallery>>({ photos: ["url"], videos: ["length"] });
// @ts-expect-error -- `media` is the family's name
assertType<FieldsOf<typeof gallery>>({ media: ["url"] });

// A family as the primary resource: its members.
const primary = Query.schema(AnyNode, { fields: true });
assertType<Equals<FieldsetTypes<typeof primary>, "editors" | "reviewers">>(true);
// A name-only family as the primary resource: its members, and no open
// `string` key (#363). Its synthesised `relationships` are typed as the by-key
// intersection the runtime computes, so its direct targets are exact.
const media = Query.schema(Media, { fields: true });
assertType<Equals<FieldsetTypes<typeof media>, "photos" | "videos">>(true);
assertType<Equals<WireFieldsets<typeof media>, "fields[photos]" | "fields[videos]">>(true);
assertType<FieldsOf<typeof media>>({ photos: ["url"], videos: ["length"] });
// @ts-expect-error -- a misspelt member type is no fieldset type
assertType<FieldsOf<typeof media>>({ phtos: ["url"] });
// @ts-expect-error -- `media` is the family's name
assertType<FieldsOf<typeof media>>({ media: ["url"] });

// A related endpoint to a name-only family (#363): its members only.
type QueryOf<E> = HttpApiEndpoint.Query<E>;
export const galleryItems = Endpoint.related(Gallery, "items", { fields: true });
assertType<Equals<FieldsetTypes<QueryOf<typeof galleryItems>>, "photos" | "videos">>(true);
assertType<FieldsOf<QueryOf<typeof galleryItems>>>({ photos: ["url"] });
// @ts-expect-error -- a misspelt member type is no fieldset type
assertType<FieldsOf<QueryOf<typeof galleryItems>>>({ phtos: ["url"] });

// The synthesised relationships are those every member shares with the same
// kind and target type, as at runtime (whose fieldset keys
// `src/Query.fieldsets.test.ts` pins against these): `tags` differs in kind.
const Owner = Resource.make("owners", { attributes: { name: Schema.String } });
const Tag = Resource.make("tags", { attributes: { label: Schema.String } });
const Song = Resource.make("songs", {
  attributes: { title: Schema.String },
  relationships: {
    owner: Relationship.one(() => Owner),
    tags: Relationship.many(() => Tag),
  },
});
const Clip = Resource.make("clips", {
  attributes: { duration: Schema.Number },
  relationships: {
    owner: Relationship.one(() => Owner),
    tags: Relationship.optional(() => Tag),
  },
});
const Track = Resource.family("tracks", [Song, Clip]);
assertType<Equals<keyof (typeof Track)["relationships"], "owner">>(true);
// Positive control: a member's own relationships are unaffected.
assertType<Equals<keyof (typeof Clip)["relationships"], "owner" | "tags">>(true);

// A base-anchored family's name is its base's real type. The base reached in
// its own right is declared as itself, over its own attributes; reached only
// as the family (`held`, above), it is not.
const Pair = Resource.make("pairs", {
  attributes: { label: Schema.String },
  relationships: {
    node: Relationship.one(() => AnyNode),
    base: Relationship.one(() => Node),
  },
});
const pair = Query.schema(Pair, { fields: true });
assertType<Equals<FieldsetTypes<typeof pair>, "pairs" | "nodes" | "editors" | "reviewers">>(true);
assertType<Equals<NonNullable<FieldsOf<typeof pair>["nodes"]>, ReadonlyArray<"name">>>(true);

// A family nested in another: the inner family's members are declared, and
// neither family's name is.
const Other = Resource.make("others", { attributes: { rank: Schema.String } });
const Outer = Resource.family("outer", [AnyNode, Other]);
const Nest = Resource.make("nests", {
  attributes: { label: Schema.String },
  relationships: { o: Relationship.one(() => Outer) },
});
const nest = Query.schema(Nest, { fields: true });
assertType<Equals<FieldsetTypes<typeof nest>, "nests" | "editors" | "reviewers" | "others">>(true);
assertType<FieldsOf<typeof nest>>({ editors: ["level"], reviewers: ["score"], others: ["rank"] });
// @ts-expect-error -- `outer` is a family's name
assertType<FieldsOf<typeof nest>>({ outer: ["name"] });

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

// The members of a nested family are partial too, the inner family's
// included: the type and the runtime walk agree (#350).
export const nested = Endpoint.related(Nest, "o", { fields: true });
assertType<Equals<NonNullable<DataOf<typeof nested>>["type"], "editors" | "reviewers" | "others">>(
  true,
);
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof nested>, { readonly type: "editors" }>>,
    { readonly name?: string; readonly level?: string }
  >
>(true);
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof nested>, { readonly type: "others" }>>,
    { readonly rank?: string }
  >
>(true);
export const nestedIncluded = Endpoint.get(Nest, { fields: true });
assertType<
  Equals<
    AttributesOf<Extract<IncludedOf<typeof nestedIncluded>, { readonly type: "reviewers" }>>,
    { readonly name?: string; readonly score?: string }
  >
>(true);

// `fields: false` keeps a family target strict.
export const relatedStrict = Endpoint.related(Holder, "node", { fields: false });
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof relatedStrict>, { readonly type: "editors" }>>,
    { readonly name: string; readonly level: string }
  >
>(true);
export const nestedStrict = Endpoint.related(Nest, "o", { fields: false });
assertType<
  Equals<
    AttributesOf<Extract<DataOf<typeof nestedStrict>, { readonly type: "editors" }>>,
    { readonly name: string; readonly level: string }
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
