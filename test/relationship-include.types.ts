/**
 * Type-level tests for compound relationship documents (#439).
 *
 * `Endpoint.getRelationship` with `include` accepts `?include=` paths rooted
 * at the parent resource — the parent's include paths whose first segment is
 * the relationship — and its success document gains an optional `included`
 * admitting every resource those paths reach, so a handler can return
 * `Handlers.linkage(ids, { included })`. Without `include` the document has no
 * `included` member, exactly as before. The runtime half is
 * `src/Endpoint.relationshipInclude.test.ts`. The last section covers the
 * same option on the endpoints `Endpoint.resource` / `Group.resource`
 * generate (#484).
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import {
  Document,
  Endpoint,
  Group,
  Handlers,
  Include,
  Query,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const Play = Resource.make("plays", {
  attributes: { playedAt: Schema.String, seconds: Schema.Number },
});
const Label = Resource.make("labels", {
  attributes: { title: Schema.String, founded: Schema.Number },
});
const Artist = Resource.make("artists", {
  attributes: { stageName: Schema.String },
  relationships: { label: Relationship.one(() => Label) },
});
const Track = Resource.make("tracks", {
  attributes: { title: Schema.String, seconds: Schema.Number },
  relationships: { artist: Relationship.one(() => Artist) },
});
const Playlist = Resource.make("playlists", {
  attributes: { name: Schema.String, shared: Schema.Boolean },
  relationships: {
    tracks: Relationship.many(() => Track),
    curator: Relationship.optional(() => Artist),
    plays: Relationship.paginated(() => Play),
  },
});

type SuccessOf<E> = HttpApiEndpoint.Success<E>["Type"];
// The `included` member type of an endpoint's success document; `never` when
// the document has no `included` member.
type IncludedOf<E> =
  SuccessOf<E> extends { readonly included?: ReadonlyArray<infer M> | undefined } ? M : never;
type HasIncluded<E> = "included" extends keyof SuccessOf<E> ? true : false;
// The decoded `include` of an endpoint's query.
type IncludeOf<E> = HttpApiEndpoint.Query<E>["Type"] extends { readonly include?: infer I }
  ? I
  : never;
type HasInclude<E> = "include" extends keyof HttpApiEndpoint.Query<E>["Type"] ? true : false;

const artist = Artist.make({
  id: Artist.Id.make("9"),
  attributes: { stageName: "Ada" },
  relationships: { label: { data: Label.ref(Label.Id.make("2")) } },
});
const track = Track.make({
  id: Track.Id.make("5"),
  attributes: { title: "First", seconds: 180 },
  relationships: { artist: { data: Artist.ref(artist.id) } },
});
const trackIds = [Track.ref(track.id)];

// ---------------------------------------------------------------------------
// `include` off: the linkage document it always was
// ---------------------------------------------------------------------------

export const plain = Endpoint.getRelationship(Playlist, "tracks");
assertType<HasIncluded<typeof plain>>(false);
assertType<HasInclude<typeof plain>>(false);
assertType<SuccessOf<typeof plain>>(Handlers.linkage(trackIds));

// ---------------------------------------------------------------------------
// `include: true` — the parent's depth-2 paths rooted at the relationship
// ---------------------------------------------------------------------------

export const tracks = Endpoint.getRelationship(Playlist, "tracks", { include: true });
assertType<Equals<IncludeOf<typeof tracks>, ReadonlyArray<"tracks" | "tracks.artist">>>(true);
assertType<Equals<IncludedOf<typeof tracks>, typeof Track.Type | typeof Artist.Type>>(true);
assertType<
  Equals<
    Endpoint.RelationshipIncludePaths<typeof Playlist, "tracks", true>,
    "tracks" | "tracks.artist"
  >
>(true);

// The handler's compound document fits; so does the plain one.
assertType<SuccessOf<typeof tracks>>(Handlers.linkage(trackIds, { included: [track, artist] }));
assertType<SuccessOf<typeof tracks>>(Handlers.linkage(trackIds));
// `labels` is three hops from the parent: on no legal path.
const tooDeep = Handlers.linkage(trackIds, {
  included: [
    track,
    Label.make({ id: Label.Id.make("2"), attributes: { title: "Acme", founded: 1999 } }),
  ],
});
// @ts-expect-error -- `labels` is not in the endpoint's `included` union
assertType<SuccessOf<typeof tracks>>(tooDeep);

// `depth` counts from the parent: 3 reaches `tracks.artist.label`.
export const deep = Endpoint.getRelationship(Playlist, "tracks", { include: { depth: 3 } });
assertType<
  Equals<IncludedOf<typeof deep>, typeof Track.Type | typeof Artist.Type | typeof Label.Type>
>(true);

// An allow-list of paths rooted at the relationship.
export const allowList = Endpoint.getRelationship(Playlist, "tracks", {
  include: { paths: ["tracks"] },
});
assertType<Equals<IncludeOf<typeof allowList>, ReadonlyArray<"tracks">>>(true);
assertType<Equals<IncludedOf<typeof allowList>, typeof Track.Type>>(true);

// An include path outside the relationship is rejected — another
// relationship's path…
// @ts-expect-error -- `curator` is the parent's path, but not rooted at `tracks`
Endpoint.getRelationship(Playlist, "tracks", { include: { paths: ["curator"] } });
// …a path rooted at the target rather than the parent…
// @ts-expect-error -- paths are the parent's: `artist` is not one
Endpoint.getRelationship(Playlist, "tracks", { include: { paths: ["artist"] } });
// …and a path no resource has.
// @ts-expect-error -- `tracks.curator` is no path of the graph
Endpoint.getRelationship(Playlist, "tracks", { include: { paths: ["tracks.curator"] } });
// Positive control: a rooted path is accepted.
Endpoint.getRelationship(Playlist, "tracks", { include: { paths: ["tracks.artist"] } });

// ---------------------------------------------------------------------------
// A declared surface over the parent
// ---------------------------------------------------------------------------

const surface = Include.make(Playlist, { tracks: Include.nested(Track, { artist: Artist }) });
export const surfaced = Endpoint.getRelationship(Playlist, "tracks", { include: surface });
assertType<Equals<IncludeOf<typeof surfaced>, ReadonlyArray<"tracks" | "tracks.artist">>>(true);
assertType<Equals<IncludedOf<typeof surfaced>, typeof Track.Type | typeof Artist.Type>>(true);

const offRelationship = Include.make(Playlist, { tracks: Track, curator: Artist });
// @ts-expect-error -- the surface declares `curator`, which is not rooted at `tracks`
Endpoint.getRelationship(Playlist, "tracks", { include: offRelationship });
const overTrack = Include.make(Track, { artist: Artist });
// @ts-expect-error -- a surface over another resource
Endpoint.getRelationship(Playlist, "tracks", { include: overTrack });

// ---------------------------------------------------------------------------
// To-one and paginated relationships
// ---------------------------------------------------------------------------

export const curator = Endpoint.getRelationship(Playlist, "curator", { include: true });
assertType<Equals<IncludeOf<typeof curator>, ReadonlyArray<"curator" | "curator.label">>>(true);
assertType<Equals<IncludedOf<typeof curator>, typeof Artist.Type | typeof Label.Type>>(true);
assertType<SuccessOf<typeof curator>>(
  Handlers.linkage(Artist.ref(artist.id), { included: [artist] }),
);

// A `paginated` relationship is no include path of its parent: none is legal.
export const plays = Endpoint.getRelationship(Playlist, "plays", { include: true });
assertType<Equals<Endpoint.RelationshipIncludePaths<typeof Playlist, "plays", true>, never>>(true);
assertType<Equals<IncludedOf<typeof plays>, never>>(true);

// ---------------------------------------------------------------------------
// `Document.LinkageDocument`'s `included`
// ---------------------------------------------------------------------------

const Linkage = Document.LinkageDocument(Schema.Array(Track.identifier));
const CompoundLinkage = Document.LinkageDocument(Schema.Array(Track.identifier), {
  included: Schema.Union([Track, Artist]),
});
assertType<"included" extends keyof typeof Linkage.Type ? true : false>(false);
assertType<
  Equals<
    (typeof CompoundLinkage.Type)["included"],
    ReadonlyArray<typeof Track.Type | typeof Artist.Type> | undefined
  >
>(true);

// ===========================================================================
// The relationship endpoints `Endpoint.resource` / `Group.resource` generate
// (#484): the top-level `relationshipInclude` sets `include` on every one, a
// relationship's own `relationshipInclude` overrides it, and without either
// nothing changes. The runtime half is
// `src/Endpoint.resourceRelationshipInclude.test.ts`.
// ===========================================================================

// The endpoint named `Name` among a generated tuple's.
type Named<Endpoints extends ReadonlyArray<unknown>, Name extends string> = Extract<
  Endpoints[number],
  { readonly identifier: Name }
>;

// ---------------------------------------------------------------------------
// The default: no `?include=` on the generated relationship endpoints
// ---------------------------------------------------------------------------

const plainResource = Endpoint.resource(Playlist);
type PlainTracks = Named<typeof plainResource, "tracksRelationship">;
assertType<HasIncluded<PlainTracks>>(false);
assertType<HasInclude<PlainTracks>>(false);
assertType<SuccessOf<PlainTracks>>(Handlers.linkage(trackIds));
// The top-level `include` still governs only the `related` endpoints.
const relatedOnly = Endpoint.resource(Playlist, { include: true });
assertType<HasInclude<Named<typeof relatedOnly, "tracksRelationship">>>(false);
assertType<HasInclude<Named<typeof relatedOnly, "tracks">>>(true);

// ---------------------------------------------------------------------------
// Resource-wide `relationshipInclude`
// ---------------------------------------------------------------------------

const all = Endpoint.resource(Playlist, { relationshipInclude: true });
type AllTracks = Named<typeof all, "tracksRelationship">;
type AllCurator = Named<typeof all, "curatorRelationship">;
type AllPlays = Named<typeof all, "playsRelationship">;
assertType<Equals<IncludeOf<AllTracks>, ReadonlyArray<"tracks" | "tracks.artist">>>(true);
assertType<Equals<IncludedOf<AllTracks>, typeof Track.Type | typeof Artist.Type>>(true);
assertType<Equals<IncludeOf<AllCurator>, ReadonlyArray<"curator" | "curator.label">>>(true);
assertType<Equals<IncludedOf<AllCurator>, typeof Artist.Type | typeof Label.Type>>(true);
// A generated handler may now answer with `included`, or without it.
assertType<SuccessOf<AllTracks>>(Handlers.linkage(trackIds, { included: [track, artist] }));
assertType<SuccessOf<AllTracks>>(Handlers.linkage(trackIds));
// `labels` is three hops from the parent: on no depth-2 path.
const tooDeepResource = Handlers.linkage(trackIds, {
  included: [
    track,
    Label.make({ id: Label.Id.make("2"), attributes: { title: "Acme", founded: 1999 } }),
  ],
});
// @ts-expect-error -- `labels` is not in the endpoint's `included` union
assertType<SuccessOf<AllTracks>>(tooDeepResource);
// A `paginated` relationship has no include paths: the setting legalises none.
assertType<Equals<IncludedOf<AllPlays>, never>>(true);

// A `{ depth }` bound applies to every relationship.
const deepResource = Endpoint.resource(Playlist, { relationshipInclude: { depth: 3 } });
assertType<
  Equals<
    IncludedOf<Named<typeof deepResource, "tracksRelationship">>,
    typeof Track.Type | typeof Artist.Type | typeof Label.Type
  >
>(true);

// An allow-list or a surface names one relationship's paths: per-relationship
// only.
// @ts-expect-error -- `paths` belongs on a relationship's own config
Endpoint.resource(Playlist, { relationshipInclude: { paths: ["tracks"] } });
// @ts-expect-error -- a surface belongs on a relationship's own config
Endpoint.resource(Playlist, { relationshipInclude: surface });

// ---------------------------------------------------------------------------
// Per-relationship `relationshipInclude`
// ---------------------------------------------------------------------------

const perRelationship = Endpoint.resource(Playlist, {
  relationshipInclude: true,
  relationships: {
    tracks: { relationshipInclude: { paths: ["tracks"] } },
    curator: { relationshipInclude: false },
    plays: { relationshipInclude: true },
  },
});
type PerTracks = Named<typeof perRelationship, "tracksRelationship">;
assertType<Equals<IncludeOf<PerTracks>, ReadonlyArray<"tracks">>>(true);
assertType<Equals<IncludedOf<PerTracks>, typeof Track.Type>>(true);
assertType<HasIncluded<Named<typeof perRelationship, "curatorRelationship">>>(false);
assertType<HasInclude<Named<typeof perRelationship, "curatorRelationship">>>(false);

// A declared surface over the parent, rooted at the relationship.
const surfacedResource = Endpoint.resource(Playlist, {
  relationships: { tracks: { relationshipInclude: surface } },
});
type SurfacedTracks = Named<typeof surfacedResource, "tracksRelationship">;
assertType<Equals<IncludeOf<SurfacedTracks>, ReadonlyArray<"tracks" | "tracks.artist">>>(true);
assertType<Equals<IncludedOf<SurfacedTracks>, typeof Track.Type | typeof Artist.Type>>(true);
// Unmentioned relationships keep the top-level default — off here.
assertType<HasInclude<Named<typeof surfacedResource, "curatorRelationship">>>(false);

// The paths are checked against the relationship they configure.
Endpoint.resource(Playlist, {
  // @ts-expect-error -- `curator` is the parent's path, but not rooted at `tracks`
  relationships: { tracks: { relationshipInclude: { paths: ["curator"] } } },
});
Endpoint.resource(Playlist, {
  // @ts-expect-error -- the surface declares `curator`, which is not rooted at `tracks`
  relationships: { tracks: { relationshipInclude: offRelationship } },
});
// Positive control: a rooted path is accepted.
Endpoint.resource(Playlist, {
  relationships: { tracks: { relationshipInclude: { paths: ["tracks.artist"] } } },
});

// ---------------------------------------------------------------------------
// `Group.resource` threads the option through
// ---------------------------------------------------------------------------

const group = Group.resource(Playlist, {
  relationshipInclude: true,
  relationships: { curator: { relationshipInclude: false } },
});
type GroupEndpoints = HttpApiGroup.Endpoints<typeof group>;
type GroupTracks = Extract<GroupEndpoints, { readonly identifier: "tracksRelationship" }>;
assertType<Equals<IncludedOf<GroupTracks>, typeof Track.Type | typeof Artist.Type>>(true);
assertType<SuccessOf<GroupTracks>>(Handlers.linkage(trackIds, { included: [track, artist] }));
assertType<HasIncluded<Extract<GroupEndpoints, { readonly identifier: "curatorRelationship" }>>>(
  false,
);

// ---------------------------------------------------------------------------
// `fields` (#485): sparse fieldsets on the `included` members
// ---------------------------------------------------------------------------

// The decoded `fields` of an endpoint's query, and its flat `fields[TYPE]` keys.
type FieldsOf<E> = HttpApiEndpoint.Query<E>["Type"] extends { readonly fields?: infer F }
  ? NonNullable<F>
  : never;
type HasFields<E> = "fields" extends keyof HttpApiEndpoint.Query<E>["Type"] ? true : false;

export const sparseTracks = Endpoint.getRelationship(Playlist, "tracks", {
  include: true,
  fields: true,
});
// The types the include paths reach — not `playlists`, the parent, which the
// document never carries, nor `labels`, three hops away.
assertType<Equals<keyof FieldsOf<typeof sparseTracks>, "tracks" | "artists">>(true);
assertType<
  Equals<Endpoint.RelationshipFieldsetTypes<typeof Playlist, "tracks", true>, "tracks" | "artists">
>(true);
assertType<FieldsOf<typeof sparseTracks>>({ tracks: ["title"], artists: ["stageName"] });
// @ts-expect-error -- `playlists` is the parent's type: no resource object of this document
assertType<FieldsOf<typeof sparseTracks>>({ playlists: ["name"] });
// @ts-expect-error -- `artist` is a relationship, not an attribute of `tracks`
assertType<FieldsOf<typeof sparseTracks>>({ tracks: ["artist"] });

// The `included` members admit any subset of their attributes; the primary
// data is the same identifiers.
type SparseTrack = Extract<IncludedOf<typeof sparseTracks>, { readonly type: "tracks" }>;
assertType<
  Equals<SparseTrack["attributes"], { readonly title?: string; readonly seconds?: number }>
>(true);
assertType<Equals<SuccessOf<typeof sparseTracks>["data"], SuccessOf<typeof tracks>["data"]>>(true);

// A handler projecting `query.fields` fits the sparse document, not the strict one.
declare const requested: FieldsOf<typeof sparseTracks>;
const projected = Handlers.linkage(trackIds, {
  included: [track, artist],
  onResource: Handlers.project(requested),
});
assertType<SuccessOf<typeof sparseTracks>>(projected);
// @ts-expect-error -- `tracks` declares no `fields`: its members' attributes are required
assertType<SuccessOf<typeof tracks>>(projected);

// `depth` and to-one relationships follow the include paths.
export const sparseDeep = Endpoint.getRelationship(Playlist, "tracks", {
  include: { depth: 3 },
  fields: true,
});
assertType<Equals<keyof FieldsOf<typeof sparseDeep>, "tracks" | "artists" | "labels">>(true);
export const sparseCurator = Endpoint.getRelationship(Playlist, "curator", {
  include: true,
  fields: true,
});
assertType<Equals<keyof FieldsOf<typeof sparseCurator>, "artists" | "labels">>(true);

// Without `include` nothing is included, so `fields` declares no fieldset.
export const fieldsOnly = Endpoint.getRelationship(Playlist, "tracks", { fields: true });
assertType<HasFields<typeof fieldsOnly>>(false);
assertType<HasIncluded<typeof fieldsOnly>>(false);
assertType<HasFields<typeof tracks>>(false);

// `Query.schema`'s `fields` allow-list, which `getRelationship` builds its
// query with: the listed types alone, in the flat (wire) record and the
// nested one alike.
const allowListed = Query.schema(Playlist, { include: true, fields: ["tracks", "artists"] });
type FlatFieldsets<Q extends { readonly Encoded: object }> = Extract<
  keyof Q["Encoded"],
  `fields[${string}]`
>;
assertType<Equals<FlatFieldsets<typeof allowListed>, "fields[tracks]" | "fields[artists]">>(true);
assertType<Equals<keyof NonNullable<(typeof allowListed.Type)["fields"]>, "tracks" | "artists">>(
  true,
);
// The parent's own `fields: true` declares its type and its direct targets too.
const everyType = Query.schema(Playlist, { include: true, fields: true });
assertType<
  Equals<
    FlatFieldsets<typeof everyType>,
    "fields[playlists]" | "fields[tracks]" | "fields[artists]" | "fields[labels]"
  >
>(true);
// An empty allow-list declares none, as `false` does.
const noneListed = Query.schema(Playlist, { include: true, fields: [] });
assertType<Equals<FlatFieldsets<typeof noneListed>, never>>(true);
assertType<"fields" extends keyof typeof noneListed.Type ? true : false>(false);

// ---------------------------------------------------------------------------
// `relationshipFields` on the endpoints `Endpoint.resource` / `Group.resource`
// generate (#489): the top-level default sets `fields` on every generated
// `getRelationship`, a relationship's own overrides it, and without either
// nothing changes. The runtime half is
// `src/Endpoint.resourceRelationshipInclude.test.ts`.
// ---------------------------------------------------------------------------

// The default: no fieldsets, strict members — even under the top-level
// `fields`, which governs `get`, `list` and the `related` endpoints.
const includeOnly = Endpoint.resource(Playlist, { relationshipInclude: true, fields: true });
type IncludeOnlyTracks = Named<typeof includeOnly, "tracksRelationship">;
assertType<HasFields<IncludeOnlyTracks>>(false);
// @ts-expect-error -- `relationshipFields` is off: the members' attributes are required
assertType<SuccessOf<IncludeOnlyTracks>>(projected);
assertType<HasFields<Named<typeof includeOnly, "tracks">>>(true);

const sparseResource = Endpoint.resource(Playlist, {
  relationshipInclude: true,
  relationshipFields: true,
});
type SparseResourceTracks = Named<typeof sparseResource, "tracksRelationship">;
assertType<Equals<keyof FieldsOf<SparseResourceTracks>, "tracks" | "artists">>(true);
assertType<
  Equals<keyof FieldsOf<Named<typeof sparseResource, "curatorRelationship">>, "artists" | "labels">
>(true);
// The generated handler admits partial `included` members: a projected answer.
assertType<SuccessOf<SparseResourceTracks>>(projected);
assertType<SuccessOf<SparseResourceTracks>>(Handlers.linkage(trackIds));
type SparseResourceTrack = Extract<IncludedOf<SparseResourceTracks>, { readonly type: "tracks" }>;
assertType<
  Equals<SparseResourceTrack["attributes"], { readonly title?: string; readonly seconds?: number }>
>(true);
// @ts-expect-error -- `playlists` is the parent's type: no resource object of this document
assertType<FieldsOf<SparseResourceTracks>>({ playlists: ["name"] });
// A `paginated` relationship has no include paths, so no fieldset.
assertType<HasFields<Named<typeof sparseResource, "playsRelationship">>>(false);

// Per relationship: an override off, an opt-in alone, and the paths it follows.
const perRelationshipFields = Endpoint.resource(Playlist, {
  relationshipInclude: true,
  relationships: {
    tracks: { relationshipInclude: { paths: ["tracks"] }, relationshipFields: true },
    curator: { relationshipFields: false },
  },
});
assertType<
  Equals<keyof FieldsOf<Named<typeof perRelationshipFields, "tracksRelationship">>, "tracks">
>(true);
assertType<HasFields<Named<typeof perRelationshipFields, "curatorRelationship">>>(false);
const overridden = Endpoint.resource(Playlist, {
  relationshipInclude: true,
  relationshipFields: true,
  relationships: { tracks: { relationshipFields: false } },
});
assertType<HasFields<Named<typeof overridden, "tracksRelationship">>>(false);
assertType<HasFields<Named<typeof overridden, "curatorRelationship">>>(true);

// Without `relationshipInclude` nothing is included, so no fieldset.
const fieldsWithoutInclude = Endpoint.resource(Playlist, { relationshipFields: true });
assertType<HasFields<Named<typeof fieldsWithoutInclude, "tracksRelationship">>>(false);
assertType<HasIncluded<Named<typeof fieldsWithoutInclude, "tracksRelationship">>>(false);

// The option is a boolean.
// @ts-expect-error -- `relationshipFields` takes no allow-list
Endpoint.resource(Playlist, { relationshipFields: ["tracks"] });

// `Group.resource` threads it through.
const sparseGroup = Group.resource(Playlist, {
  relationshipInclude: true,
  relationshipFields: true,
  relationships: { curator: { relationshipFields: false } },
});
type SparseGroupEndpoints = HttpApiGroup.Endpoints<typeof sparseGroup>;
type SparseGroupTracks = Extract<
  SparseGroupEndpoints,
  { readonly identifier: "tracksRelationship" }
>;
assertType<Equals<keyof FieldsOf<SparseGroupTracks>, "tracks" | "artists">>(true);
assertType<SuccessOf<SparseGroupTracks>>(projected);
assertType<
  HasFields<Extract<SparseGroupEndpoints, { readonly identifier: "curatorRelationship" }>>
>(false);
