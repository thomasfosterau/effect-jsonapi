/**
 * Type-level tests for compound relationship documents (#439).
 *
 * `Endpoint.getRelationship` with `include` accepts `?include=` paths rooted
 * at the parent resource — the parent's include paths whose first segment is
 * the relationship — and its success document gains an optional `included`
 * admitting every resource those paths reach, so a handler can return
 * `Handlers.linkage(ids, { included })`. Without `include` the document has no
 * `included` member, exactly as before. The runtime half is
 * `src/Endpoint.relationshipInclude.test.ts`.
 *
 * This file is type-checked by `tsconfig.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a positive control.
 */
import * as Schema from "effect/Schema";
import type { HttpApiEndpoint } from "effect/http-api";
import {
  Document,
  Endpoint,
  Handlers,
  Include,
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
