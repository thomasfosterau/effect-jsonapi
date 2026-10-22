/**
 * The document assembler: the seam every handler routes its JSON:API
 * document returns through.
 *
 * Operations load and shape a resource; the assembler owns everything
 * between that resource and the wire — the envelope, the per-viewer `meta`
 * (`canEdit` / `canDelete`), sparse-fieldset projection, `URL` → string link
 * coercion, pagination links, the `included` walk and the `jsonapi` member.
 * It is built on the `Handlers` builders (`Handlers.data`,
 * `Handlers.collection`, `Handlers.resolveIncluded`,
 * `Handlers.offsetPaginationLinks`) and adds the conventions three
 * consuming applications each restated on top of them.
 *
 * ## The include walk
 *
 * `include` paths are validated first (`Query.validateIncludePaths` — the
 * whole dotted path against `includable`, depth before membership), failing
 * `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth` before any
 * loader runs; the 400 carries `meta.includablePaths`, so a rejected
 * `?include=` is actionable rather than a dead end. The walk itself is
 * `Handlers.resolveIncluded` over a `Handlers.IncludeTargets` registry: one
 * loader call per distinct target type per level, for a single resource and
 * for a whole collection page alike, so a `get` and a `list` can never
 * disagree about what a ref resolves to and a page's walk is never N round
 * trips.
 *
 * A request carrying `include` always answers a compound document: the
 * `included` key is present, `[]` when nothing resolved or every candidate was
 * already primary data (JSON:API 1.1 §Fetching Includes). Without `include`
 * the key is absent unless members the caller resolved itself survive the
 * dedupe against the primary data.
 *
 * ## Capabilities
 *
 * `meta.canEdit` / `meta.canDelete` advertise what the viewer may do to a
 * resource, computed server-side per resource by a {@link CapabilitiesHook}.
 * The assembler is generic in the viewer — an application's session user,
 * `null` for anonymous, whatever its auth layer produces — and ships the
 * three rules the applications converged on: {@link roleCapabilities} (a
 * rung comparison), {@link ownedCapabilities} (the owner, or a moderator
 * acting for them) and {@link noCapabilities} (a family with no write
 * surface). No hook means no stamp: a family that publishes the pair passes
 * one.
 *
 * @since 0.16.0
 */
import { Array as Arr, Effect } from "effect";
import type * as ApiError from "./ApiError.js";
import type * as Document from "./Document.js";
import * as Handlers from "./Handlers.js";
import { assign } from "./internal/define.js";
import * as Query from "./Query.js";

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/**
 * A resource identifier as it appears in relationship `data`.
 *
 * @since 0.16.0
 * @category models
 */
export interface Ref {
  readonly type: string;
  readonly id: string;
}

/**
 * A link value as an application builds it internally: a string, a `URL`,
 * or a link object whose `href` is either — every form coerces to a wire
 * string ({@link stringifyLinks}).
 *
 * @since 0.16.0
 * @category models
 */
export type LinkLike = string | URL | { readonly href: string | URL };

/**
 * A relationship object as the assembler reads it: `data` (resource linkage
 * — one identifier, an identifier array, or `null` for an empty to-one) plus
 * the optional link block and meta.
 *
 * @since 0.16.0
 * @category models
 */
export interface RelationshipObject {
  readonly data?: Ref | ReadonlyArray<Ref> | null | undefined;
  readonly links?: { readonly related?: LinkLike; readonly self?: LinkLike } | undefined;
  readonly meta?: { readonly [key: string]: unknown } | undefined;
}

/**
 * The minimum shape every resource an application hands the assembler
 * exposes. Relationship values are `unknown` so a mapper's own relationship
 * types fit without a cast; the assembler reads them structurally
 * ({@link relationshipRefs}). The `?: T | undefined` members admit an
 * explicit `undefined` under `exactOptionalPropertyTypes`, so a caller
 * forwards possibly-absent members without a conditional spread.
 *
 * @since 0.16.0
 * @category models
 */
export interface ResourceLike {
  readonly type: string;
  readonly id: string;
  readonly attributes: { readonly [key: string]: unknown };
  readonly relationships?: { readonly [key: string]: unknown } | undefined;
  readonly links?: { readonly self?: LinkLike | undefined } | undefined;
  readonly meta?: { readonly [key: string]: unknown } | undefined;
}

/**
 * The **wire** form of a resource — what {@link stringifyLinks} produces:
 * `Document.Wire<R>` (every `URL` a string) with `links.self` narrowed to a
 * plain string, since a link object's `href` is flattened too.
 *
 * @since 0.16.0
 * @category models
 */
export type WireResource<R extends ResourceLike> = Document.Wire<R> & {
  readonly links?: { readonly self?: string };
};

/**
 * The `jsonapi` member every assembled document carries.
 *
 * @since 0.16.0
 * @category constants
 */
export const JSONAPI_MEMBER: { readonly version: "1.1" } = { version: "1.1" };

/**
 * A single-resource document as {@link resource} assembles it, with the
 * `jsonapi` member always present. `included` is the loose {@link ResourceLike}
 * because the walk resolves through an untyped-by-type registry.
 *
 * @since 0.16.0
 * @category models
 */
export interface ResourceDocument<R extends ResourceLike> {
  readonly data: WireResource<R> & { readonly meta?: { readonly [key: string]: unknown } };
  readonly included?: ReadonlyArray<WireResource<ResourceLike>>;
  readonly links?: { readonly self?: string };
  readonly meta?: { readonly [key: string]: unknown };
  readonly jsonapi: typeof JSONAPI_MEMBER;
}

/**
 * A collection document as {@link collection} assembles it: `meta.totalCount`
 * and the five pagination links always present.
 *
 * @since 0.16.0
 * @category models
 */
export interface CollectionDocument<R extends ResourceLike> {
  readonly data: ReadonlyArray<
    WireResource<R> & { readonly meta?: { readonly [key: string]: unknown } }
  >;
  readonly included?: ReadonlyArray<WireResource<ResourceLike>>;
  readonly links: Handlers.LinksValue;
  readonly meta: { readonly totalCount: number; readonly [key: string]: unknown };
  readonly jsonapi: typeof JSONAPI_MEMBER;
}

/**
 * An unpaginated collection document as {@link unpaginatedCollection}
 * assembles it: the whole collection as `data`, with no page math — no
 * `meta.totalCount` and no `first` / `last` / `prev` / `next` links the
 * endpoint wouldn't honour.
 *
 * The top-level `links` member is the collection's own `self` link, and
 * `Self` is the type of the `self` option the document was assembled with:
 * `undefined` (the default — no `self` passed) means no `links` member at
 * all, `string` means `links.self` is always present, and `string |
 * undefined` (a `self` the caller may not have) means `links` is optional.
 *
 * The top-level `meta` member is the caller's own document-level metadata,
 * passed through as given, and `M` is the type of the `meta` option, decided
 * the same way: `undefined` (the default — no `meta` passed) means no `meta`
 * member at all, an object type means `meta` is that type and always
 * present, and an object type `| undefined` means `meta` is optional.
 *
 * @since 0.17.0
 * @category models
 */
export type UnpaginatedCollectionDocument<
  R extends ResourceLike,
  // oxlint-disable-next-line effect/prefer-option-over-null -- a type-level switch on the `self` option's type, not a runtime value: `undefined` selects the linkless document
  Self extends string | undefined = undefined,
  // oxlint-disable-next-line effect/prefer-option-over-null -- a type-level switch on the `meta` option's type, not a runtime value: `undefined` selects the document with no `meta`
  M extends Handlers.MetaValue | undefined = undefined,
> = {
  readonly data: ReadonlyArray<WireResource<R> & { readonly meta?: Handlers.MetaValue }>;
  readonly included?: ReadonlyArray<WireResource<ResourceLike>>;
  readonly jsonapi: typeof JSONAPI_MEMBER;
} & ([Self] extends [undefined]
  ? unknown
  : [Self] extends [string]
    ? { readonly links: { readonly self: string } }
    : { readonly links?: { readonly self: string } }) &
  ([M] extends [undefined]
    ? unknown
    : [undefined] extends [M]
      ? { readonly meta?: Exclude<M, undefined> }
      : { readonly meta: M });

/**
 * A §8.4 relationship document as {@link relationship} assembles it: the
 * linkage as `data`, the caller's extras (never the parent) as `included`.
 *
 * @since 0.16.0
 * @category models
 */
export interface RelationshipDocument<R extends ResourceLike, I extends ResourceLike = R> {
  readonly data: Ref | ReadonlyArray<Ref> | null;
  readonly included: ReadonlyArray<WireResource<I>>;
  readonly links?: { readonly related: string };
  readonly jsonapi: typeof JSONAPI_MEMBER;
}

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

/**
 * Per-resource capability computation: given the resource being emitted and
 * the viewer exactly as the assembler was given it (an application's session
 * user, `null` for anonymous, `undefined` when none was passed), returns the
 * `meta` members that advertise what the viewer may do to it. Reserved
 * members are `canEdit` and `canDelete`. Always computed server-side, never
 * client-guessed.
 *
 * @since 0.16.0
 * @category models
 */
export type CapabilitiesHook<V = unknown> = (
  resource: ResourceLike,
  viewer: V,
) => { readonly [key: string]: unknown };

/**
 * The capability rule of a family whose writes gate on a role rung:
 * `canEdit` / `canDelete` are whatever `canWrite(viewer)` answers — pass the
 * same predicate the family's write operations guard with, so moving a
 * capability between rungs moves the meta with it.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * interface User { readonly id: string; readonly role: "user" | "admin" }
 * const adminOnly = Assemble.roleCapabilities((viewer: User | null | undefined) => viewer?.role === "admin")
 *
 * const person = { type: "people", id: "1", attributes: {} }
 * console.log(adminOnly(person, { id: "9", role: "admin" }), adminOnly(person, null))
 * // → { canEdit: true, canDelete: true } { canEdit: false, canDelete: false }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const roleCapabilities =
  <V>(canWrite: (viewer: V) => boolean): CapabilitiesHook<V> =>
  (_resource, viewer) => {
    const write = canWrite(viewer);
    return { canEdit: write, canDelete: write };
  };

/**
 * Options of {@link ownedCapabilities}.
 *
 * @since 0.16.0
 * @category models
 */
export interface OwnedCapabilitiesOptions<V> {
  /** The viewer's id, or `undefined` for an anonymous viewer. */
  readonly viewerId: (viewer: V) => string | undefined;
  /** Whether the viewer may act on any owner's behalf (a moderator rung). Defaults to never. */
  readonly canModerate?: ((viewer: V) => boolean) | undefined;
  /** The relationship the owner rides on. Defaults to `"owner"`. */
  readonly relationship?: string | undefined;
}

/**
 * The capability rule of an **owned** resource: the owner may edit and
 * delete their own row, and so may a viewer `canModerate` admits — the
 * `requireOwnerOrRole` gate a write path applies, restated as `meta`. The
 * owner is read off the resource's `owner` relationship (or `relationship`);
 * a resource without one advertises nothing an anonymous or stranger viewer
 * could act on.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * interface User { readonly id: string; readonly role: "user" | "moderator" }
 * const owned = Assemble.ownedCapabilities({
 *   viewerId: (viewer: User | null | undefined) => viewer?.id,
 *   canModerate: (viewer) => viewer?.role === "moderator"
 * })
 * const garden = {
 *   type: "gardens", id: "1", attributes: {},
 *   relationships: { owner: { data: { type: "users", id: "9" } } }
 * }
 * console.log(owned(garden, { id: "9", role: "user" }), owned(garden, { id: "2", role: "user" }))
 * // → { canEdit: true, canDelete: true } { canEdit: false, canDelete: false }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const ownedCapabilities =
  <V>(options: OwnedCapabilitiesOptions<V>): CapabilitiesHook<V> =>
  (resource, viewer) => {
    const ownerId = relationshipRefs(resource, options.relationship ?? "owner")[0]?.id;
    const id = options.viewerId(viewer);
    const isOwner = id !== undefined && ownerId !== undefined && id === ownerId;
    const write = isOwner || (options.canModerate?.(viewer) ?? false);
    return { canEdit: write, canDelete: write };
  };

/**
 * The opt-out for a family that has **no write surface for the pair to
 * describe**: the merged meta stays empty, and the assembler then omits the
 * member entirely rather than shipping a permanently-false constant. Not a
 * general escape hatch — any family with a write endpoint publishes the pair.
 *
 * @since 0.16.0
 * @category constants
 */
export const noCapabilities: CapabilitiesHook = () => ({});

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * The maximum `?include=` depth by default. §7.1 leaves the bound
 * implementation-defined; three levels covers compound-document needs
 * without enabling unbounded relationship walks.
 *
 * @since 0.16.0
 * @category constants
 */
export const MAX_INCLUDE_DEPTH = 3;

/**
 * Options accepted by every assembler entry point.
 *
 * @since 0.16.0
 * @category models
 */
export interface Options<V = unknown, Targets extends Handlers.IncludeTargets = never> {
  /** The current request's viewer, as the application's auth layer produced it. */
  readonly viewer?: V | undefined;
  /**
   * Sparse fieldsets keyed by resource `type` to the attribute names the
   * caller wants. Empty / missing means the full resource.
   */
  readonly fields?: Handlers.Fields | undefined;
  /**
   * The requested `?include=` paths (JSON:API §7.1 dot paths), or `undefined`
   * when the request carried no `include`. Presence is the signal: any array,
   * even the `[]` a bare `?include=` decodes to, answers with the `included`
   * key.
   */
  readonly include?: ReadonlyArray<string> | undefined;
  /**
   * The legal include paths — anything else fails
   * `ApiError.UnsupportedIncludePath`, which publishes this set as
   * `meta.includablePaths`. Required whenever `include` is non-empty.
   */
  readonly includable?: ReadonlyArray<string> | undefined;
  /**
   * The registry the walk loads through, keyed by target type
   * (`Handlers.IncludeTargets`). Omit it and no walk runs — `include` is
   * validated, and `included` holds only what the caller resolved itself
   * (`[]` for {@link resource}): a request carrying `include` always gets the
   * key, empty when nothing remains (JSON:API 1.1 §Fetching Includes).
   */
  readonly targets?: Targets | undefined;
  /** The maximum number of hops. Defaults to {@link MAX_INCLUDE_DEPTH}. */
  readonly depth?: number | undefined;
  /** How many loader calls of one level may run at once. Defaults to unbounded. */
  readonly concurrency?: number | "unbounded" | undefined;
  /**
   * The capability rule stamped onto every emitted resource — primary and
   * included alike, keyed by resource rather than by handler, so a compound
   * document mixing families stamps each member honestly. Omit for no stamp.
   */
  readonly capabilities?: CapabilitiesHook<V> | undefined;
}

/**
 * {@link collection}'s options: the shared {@link Options} plus compound
 * members the caller already resolved (every one must be reachable from the
 * page's primary data through resource linkage — directly, or through other
 * included members; the full-linkage check raises otherwise).
 *
 * @since 0.16.0
 * @category models
 */
export interface CollectionOptions<
  V = unknown,
  Targets extends Handlers.IncludeTargets = never,
> extends Options<V, Targets> {
  readonly included?: ReadonlyArray<ResourceLike> | undefined;
}

/**
 * {@link unpaginatedCollection}'s options: {@link CollectionOptions} plus the
 * collection's own `self` link, the request query it carries and the
 * document's top-level `meta`. `Self` is the type of `self` as passed, and
 * decides whether the document type has a `links` member; `M` is the type of
 * `meta` as passed, and decides whether it has a `meta` member
 * ({@link UnpaginatedCollectionDocument}).
 *
 * `Self` and `M` are decided from a concrete type, so a caller forwarding its
 * own generic parameter (`<S extends string | undefined>(self: S) => …`)
 * widens it at the call site — `self: self as string | undefined` (or `as
 * string`), and likewise `meta` to its object type — otherwise `query` is
 * rejected and `links` / `meta` stay unresolved.
 *
 * @since 0.17.0
 * @category models
 */
export interface UnpaginatedCollectionOptions<
  V = unknown,
  Targets extends Handlers.IncludeTargets = never,
  // oxlint-disable-next-line effect/prefer-option-over-null -- inferred from the `self` option as passed; an `Option` there would stop a caller forwarding its own optional `self`
  Self extends string | undefined = undefined,
  // oxlint-disable-next-line effect/prefer-option-over-null -- inferred from the `meta` option as passed; an `Option` there would stop a caller forwarding its own optional `meta`
  M extends Handlers.MetaValue | undefined = undefined,
> extends CollectionOptions<V, Targets> {
  /**
   * The collection's own absolute URL, emitted as the document's
   * `links.self`. Supplied by the handler, as {@link Pagination.baseUrl} is,
   * so the assembler stays request-agnostic. Omit it (or pass `undefined`)
   * and the document has no `links` member.
   *
   * An explicit `undefined` is accepted only when `Self` already admits it,
   * so a caller's own bare-optional `o.self` (read as `string | undefined`
   * under `exactOptionalPropertyTypes`) forwards as is, while a `self` that
   * infers as `string` keeps `links.self` required.
   */
  readonly self?: Self | ([undefined] extends [Self] ? undefined : never);
  /**
   * The rest of the request's query as canonical wire pairs
   * (`Query.canonicalPairs(listQuery)(query)`) — `?include=`, each
   * `?filter[…]=`, `?sort=` — appended to `links.self` and serialised
   * canonically, as the pagination links of a {@link collection} carry
   * theirs, so `self` names the request the document answers. It rides on
   * `self`: a call with no `self` can't pass it, and a `self` that turns out
   * `undefined` drops it with the `links` member.
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling AGENTS.md requires under exactOptionalPropertyTypes, as the sibling options do
  readonly query?: ([Self] extends [undefined] ? never : ReadonlyArray<Query.Pair>) | undefined;
  /**
   * The document's top-level `meta` — document-level metadata that isn't
   * page math: a generation timestamp, a cache hint, an application-specific
   * summary — emitted as given. Omit it (or pass `undefined`) and the
   * document has no `meta` member. `totalCount` is not special-cased: one
   * passed here is emitted verbatim and, with a `self`, makes the document
   * structurally assignable to {@link CollectionDocument} — a caller that
   * wants a paginated total wants {@link collection} and its page math.
   *
   * `M` is inferred `const`, as on `Handlers.collection`: the document emits
   * this very value, so an object literal keeps its literal type. Its
   * constraint is `Handlers.MetaValue`, which a value typed by an `interface`
   * without an index signature doesn't satisfy (as on `Handlers.collection`):
   * spread it (`{ ...stamp }`) or declare its type with a `type` alias.
   *
   * An explicit `undefined` is accepted only when `M` already admits it, as
   * for `self`, so a caller's own bare-optional `o.meta` forwards as is while
   * a `meta` that infers as an object type keeps the document's `meta`
   * required.
   */
  readonly meta?: M | ([undefined] extends [M] ? undefined : never);
}

/**
 * The page math of a {@link collection}.
 *
 * @since 0.16.0
 * @category models
 */
export interface Pagination {
  /** The unpaged total — `meta.totalCount`. */
  readonly totalCount: number;
  readonly offset: number;
  readonly limit: number;
  /**
   * The absolute base URL the pagination links are built under. Supplied by
   * the handler, so the assembler stays request-agnostic.
   */
  readonly baseUrl: string;
  /**
   * The rest of the request's query as canonical wire pairs
   * (`Query.canonicalPairs(listQuery)(query)`) — `?include=`, each
   * `?filter[…]=`, `?sort=` — carried into every link so `next` is the *same*
   * query on the next page rather than an unfiltered, un-included one. Each
   * link's own `page[*]` cursor replaces the pairs' rather than appending.
   */
  readonly query?: ReadonlyArray<Query.Pair> | undefined;
}

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

const toLinkString = (value: LinkLike): string => {
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.href;
  return typeof value.href === "string" ? value.href : value.href.href;
};

/**
 * Reads a `relationships[key]` value as a relationship object. Bare
 * identifier shapes (`{ type, id }`, an identifier array) are tolerated.
 */
const readRelationship = (resource: ResourceLike, key: string): RelationshipObject | undefined => {
  const value = resource.relationships?.[key];
  if (value === null || typeof value !== "object") return undefined;
  if (Array.isArray(value)) return { data: value as ReadonlyArray<Ref> };
  if ("data" in value) return value as RelationshipObject;
  if ("type" in value && "id" in value) return { data: value as Ref };
  return undefined;
};

/**
 * The resource identifiers a resource's relationship `data` carries, in
 * declaration order — empty when the relationship is absent or its linkage
 * is `null` / `[]`. Bare identifier shapes are read too.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * const contest = {
 *   type: "contests", id: "1", attributes: {},
 *   relationships: {
 *     election: { data: { type: "elections", id: "e1" } },
 *     candidates: { data: [{ type: "candidates", id: "c1" }, { type: "candidates", id: "c2" }] },
 *     polity: { data: null }
 *   }
 * }
 * console.log(Assemble.relationshipRefs(contest, "candidates").map((ref) => ref.id))
 * // → [ "c1", "c2" ]
 * console.log(Assemble.relationshipRefs(contest, "polity"), Assemble.relationshipRefs(contest, "missing"))
 * // → [] []
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const relationshipRefs = (resource: ResourceLike, key: string): ReadonlyArray<Ref> => {
  const data = readRelationship(resource, key)?.data;
  if (data === null || data === undefined) return [];
  return Array.isArray(data) ? (data as ReadonlyArray<Ref>) : [data as Ref];
};

/** A relationship object's link block with every member a wire string. */
const wireRelationshipLinks = (value: unknown): unknown => {
  const links = (value as RelationshipObject | null)?.links;
  if (links === undefined || links === null) return value;
  return {
    ...(value as object),
    links: {
      ...links,
      ...(links.related === undefined ? {} : { related: toLinkString(links.related) }),
      ...(links.self === undefined ? {} : { self: toLinkString(links.self) }),
    },
  };
};

/**
 * `resource` with its `links.self` and every relationship's `links.related`
 * / `links.self` coerced to a wire string — "URL internal, string on the
 * wire". Attributes and relationship `data` are untouched. Applied to every
 * resource the assembler emits, so no raw `URL` reaches the serialiser.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * const wired = Assemble.stringifyLinks({
 *   type: "people", id: "1", attributes: {},
 *   relationships: { home: { data: null, links: { related: new URL("https://example.test/people/1/home") } } },
 *   links: { self: new URL("https://example.test/people/1") }
 * })
 * console.log(wired.links?.self)
 * // → https://example.test/people/1
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const stringifyLinks = <R extends ResourceLike>(resource: R): WireResource<R> => {
  const self = resource.links?.self;
  const relationships = resource.relationships;
  const out: ResourceLike = {
    ...resource,
    ...(self === undefined ? {} : { links: { ...resource.links, self: toLinkString(self) } }),
    ...(relationships === undefined
      ? {}
      : {
          relationships: Object.fromEntries(
            Object.entries(relationships).map(([key, value]) => [
              key,
              wireRelationshipLinks(value),
            ]),
          ),
        }),
  };
  // The honest assertion: the value differs from `R` only in the link fields
  // just coerced, which `Document.Wire` mirrors at the type level.
  return out as WireResource<R>;
};

const toWireValue = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof URL) return value.href;
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : toWireValue(entry)));
  }
  if (value !== null && typeof value === "object") {
    const withToJson = value as { readonly toJSON?: () => unknown };
    if (typeof withToJson.toJSON === "function") return toWireValue(withToJson.toJSON());
    const out: { [key: string]: unknown } = {};
    for (const [key, entry] of Object.entries(value)) {
      // An own `__proto__` member (as `JSON.parse` gives) stays a member.
      if (entry !== undefined) assign(out, key, toWireValue(entry));
    }
    return out;
  }
  return value;
};

/**
 * Deep-coerces runtime-only values to their wire form — `Date` → ISO string,
 * `URL` → href, an explicitly-`undefined` member dropped, an `undefined`
 * array element `null`, a `toJSON` honoured — mirroring `JSON.stringify`'s
 * value semantics without serialising. Every member is copied as an own
 * property, so one keyed `__proto__` (as `JSON.parse` gives) stays a member.
 *
 * Needed for a document whose members cross into a structurally-open
 * (`Schema.Unknown` / open `Record`) response schema: the response encoder
 * runs every JSON success schema through `Schema.toCodecJson`, which makes
 * `Unknown` a strict "already JSON" codec on encode — a raw `Date` under it
 * fails with a bodyless 400. A typed resource schema launders dates through
 * its own codec and never needs this.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * console.log(Assemble.toWireSafeResource({
 *   type: "t", id: "1",
 *   attributes: { at: new Date("2026-01-01T00:00:00Z"), gone: undefined, list: [undefined, 1] }
 * }).attributes)
 * // → { at: "2026-01-01T00:00:00.000Z", list: [ null, 1 ] }
 * ```
 *
 * @since 0.16.0
 * @category utils
 */
export const toWireSafeResource = <R extends ResourceLike>(resource: R): R =>
  toWireValue(resource) as R;

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/** The resource-level transform every emitted resource goes through. */
const onResourceFor = <V>(options: Options<V, any>) =>
  Handlers.compose(
    Handlers.withMeta((resource) =>
      options.capabilities === undefined
        ? undefined
        : // The viewer is handed to the hook exactly as it was given: an
          // omitted option is `undefined`, which is then what `V` is.
          options.capabilities(resource as ResourceLike, options.viewer as V),
    ),
    Handlers.project(options.fields),
  );

// `ResourceLike`'s `relationships` values widen to `unknown`, which the
// builders' stricter `ResourceValue` rejects; the builders only read
// `type` / `id` / `relationships.data`, all present.
const asValue = (resource: ResourceLike): Handlers.ResourceValue =>
  resource as unknown as Handlers.ResourceValue;

/**
 * Validates the requested paths, then walks them. `undefined` means the
 * request carried no `include`, and only that: a request that did — even a
 * bare `?include=`, which decodes to `[]` — gets an array, `[]` when there is
 * no registry to walk through or no path to walk, so the document keeps its
 * `included` key (§Fetching Includes, #232).
 */
const walk = <Targets extends Handlers.IncludeTargets>(
  primary: ReadonlyArray<ResourceLike>,
  options: Options<any, Targets>,
): Effect.Effect<
  ReadonlyArray<ResourceLike> | undefined,
  | ApiError.UnsupportedIncludeDepth
  | ApiError.UnsupportedIncludePath
  | Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> => {
  const include = options.include;
  if (include === undefined) return Effect.succeed(undefined);
  const depth = options.depth ?? MAX_INCLUDE_DEPTH;
  return Query.validateIncludePaths(include, {
    includable: options.includable ?? [],
    maxDepth: depth,
  }).pipe(
    Effect.flatMap(() =>
      options.targets === undefined
        ? Effect.succeed([])
        : Handlers.resolveIncluded(primary.map(asValue), include, options.targets, {
            depth,
            concurrency: options.concurrency,
          }),
    ),
  ) as Effect.Effect<
    ReadonlyArray<ResourceLike> | undefined,
    | ApiError.UnsupportedIncludeDepth
    | ApiError.UnsupportedIncludePath
    | Handlers.IncludeTargetError<Targets>,
    Handlers.IncludeTargetServices<Targets>
  >;
};

/**
 * The failures an assembler's include walk can raise, beyond the target
 * registry's own.
 *
 * @since 0.16.0
 * @category models
 */
export type IncludeError = ApiError.UnsupportedIncludeDepth | ApiError.UnsupportedIncludePath;

/**
 * Assembles a JSON:API document around a single primary resource: capability
 * `meta` stamped, links stringified, sparse fieldsets projected, the
 * requested `include` paths validated and walked (when `targets` is given)
 * into `included`, the `jsonapi` member set.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Assemble, Handlers } from "@thomasfosterau/effect-jsonapi"
 *
 * const person = {
 *   type: "people", id: "1", attributes: { name: "Ada" },
 *   relationships: { birthPlace: { data: { type: "places", id: "p1" } } },
 *   links: { self: new URL("https://example.test/people/1") }
 * }
 * const places: Handlers.IncludeTarget = (ids) =>
 *   Effect.succeed(ids.map((id) => ({ type: "places", id, attributes: { name: "London" } })))
 * const document = Effect.runSync(Assemble.resource(person, {
 *   viewer: { admin: true },
 *   capabilities: Assemble.roleCapabilities((viewer?: { admin: boolean }) => viewer?.admin === true),
 *   include: ["birthPlace"],
 *   includable: ["birthPlace"],
 *   targets: { places }
 * }))
 * console.log(document.data.links?.self, document.data.meta, document.included?.length)
 * // → https://example.test/people/1 { canEdit: true, canDelete: true } 1
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const resource = <
  R extends ResourceLike,
  V = unknown,
  Targets extends Handlers.IncludeTargets = never,
>(
  resource: R,
  options: Options<V, Targets> = {},
): Effect.Effect<
  ResourceDocument<R>,
  IncludeError | Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> => {
  const wired = stringifyLinks(resource);
  return walk([wired], options).pipe(
    Effect.map((included) => {
      const built = Handlers.data(asValue(wired), {
        ...(wired.links?.self === undefined ? {} : { self: wired.links.self }),
        // An empty walk keeps the key: the request carried `include` (#232).
        ...(included === undefined
          ? {}
          : { included: included.map((r) => asValue(stringifyLinks(r))) }),
        onResource: onResourceFor(options),
      });
      return { ...built, jsonapi: JSONAPI_MEMBER } as unknown as ResourceDocument<R>;
    }),
  );
};

// A document answering a request that carried no `include` keeps `included`
// only when something is in it: the caller may have resolved no members of
// its own, or only members that are primary data, which the builders' dedupe
// then drops, leaving their empty array.
const withoutEmptyIncluded = <T extends { readonly included?: ReadonlyArray<unknown> }>(
  document: T,
): T => {
  if (document.included === undefined || Arr.isReadonlyArrayNonEmpty(document.included))
    return document;
  const { included: _included, ...rest } = document;
  return rest as T;
};

/**
 * The shared body of {@link collection} and {@link unpaginatedCollection}:
 * link coercion, the batched walk, the caller's pre-resolved `included`, the
 * per-resource transform and the `jsonapi` member. `top` is the only thing
 * the two differ by — the pagination `meta` / `links`, or the collection's
 * own `self` (with the query it carries) and the caller's own `meta`, or
 * nothing — and the document type `D` that difference produces.
 */
const assembleCollection = <D, V, Targets extends Handlers.IncludeTargets>(
  resources: ReadonlyArray<ResourceLike>,
  options: CollectionOptions<V, Targets>,
  top: {
    readonly meta?: Handlers.MetaValue;
    readonly links?: Handlers.LinksValue;
    readonly self?: string;
    readonly query?: ReadonlyArray<Query.Pair>;
  },
): Effect.Effect<
  D,
  IncludeError | Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> => {
  const wired = resources.map(stringifyLinks);
  return walk(wired, options).pipe(
    Effect.map((resolved) => {
      // `resolved` is an array exactly when the request carried `include`.
      const requested = resolved !== undefined;
      const included = [...(options.included ?? []), ...(resolved ?? [])];
      const built = Handlers.collection(wired.map(asValue), {
        ...top,
        included: included.map((r) => asValue(stringifyLinks(r))),
        onResource: onResourceFor(options),
      });
      // SAFETY: `Handlers.collection` types its value over the builders' loose
      // `ResourceValue`; the value is `D` by construction — the wired, stamped
      // resources, `included` when the request carried `include` (empty if
      // nothing remains, #232) or when members survive the dedupe against
      // the primary data, exactly the `top` members the caller's `D`
      // declares, and the `jsonapi` member.
      return {
        ...(requested ? built : withoutEmptyIncluded(built)),
        jsonapi: JSONAPI_MEMBER,
      } as unknown as D;
    }),
  );
};

/**
 * Assembles a JSON:API document around a collection page: every resource
 * stamped and projected as {@link resource} does, `meta.totalCount` and the
 * five pagination links (`Handlers.offsetPaginationLinks`, carrying the
 * request's other query pairs) surfacing the page math, and the page's
 * `include` walk resolved **batched** — one loader call per distinct target
 * type per level across the whole page — into `included`. Members the caller
 * resolved itself (`included`) are emitted alongside. A collection served
 * whole, with no page math, goes through {@link unpaginatedCollection}.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * const people = [1, 2, 3].map((n) => ({ type: "people", id: `${n}`, attributes: { name: `P${n}` } }))
 * const document = Effect.runSync(Assemble.collection(people, {
 *   totalCount: 42, offset: 10, limit: 3,
 *   baseUrl: "https://example.test/people",
 *   query: [["filter[q]", "ada"]]
 * }))
 * console.log(document.meta.totalCount, document.links.next)
 * // → 42 https://example.test/people?filter[q]=ada&page[offset]=13&page[limit]=3
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const collection = <
  R extends ResourceLike,
  V = unknown,
  Targets extends Handlers.IncludeTargets = never,
>(
  resources: ReadonlyArray<R>,
  pagination: Pagination,
  options: CollectionOptions<V, Targets> = {},
): Effect.Effect<
  CollectionDocument<R>,
  IncludeError | Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> =>
  assembleCollection<CollectionDocument<R>, V, Targets>(resources, options, {
    meta: { totalCount: pagination.totalCount },
    links: Handlers.offsetPaginationLinks(
      pagination.baseUrl,
      { offset: pagination.offset, limit: pagination.limit },
      pagination.totalCount,
      pagination.query === undefined ? undefined : { query: pagination.query },
    ),
  });

/**
 * Assembles a JSON:API document around a whole, **unpaginated** collection —
 * a small fixed list, or a to-many related collection served in one piece.
 * Everything {@link collection} does except the page math: every resource
 * stamped and projected, the `include` walk validated and resolved batched
 * into `included` alongside any members the caller resolved itself, the
 * `jsonapi` member set — but no `meta.totalCount` and no pagination links,
 * so the document doesn't advertise `next` / `last` cursors the endpoint
 * doesn't honour.
 *
 * Pass `self` — the collection's absolute URL — and the document carries it
 * as `links.self`, with `query` (the request's canonical pairs) appended
 * and serialised as {@link collection}'s pagination links are, so the link
 * names the request the document answers. Without `self` the document has
 * no `links` member at all.
 *
 * Pass `meta` — document-level metadata that isn't page math, such as a
 * generation timestamp or a cache hint — and the document carries it as the
 * top-level `meta`, as given, typed as passed (an object literal keeps its
 * literal type). Without it the document has no `meta` member.
 * `meta.totalCount` is not special-cased: it is emitted verbatim, and with a
 * `self` the document is then structurally a {@link CollectionDocument}; a
 * collection whose total matters is a page of something, and goes through
 * {@link collection}.
 *
 * The return type ({@link UnpaginatedCollectionDocument}) follows the
 * `self` and `meta` passed: no `links` / `meta` member without one, the
 * member required when the option's type excludes `undefined`, and optional
 * when it admits it (a caller forwarding its own optional).
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Assemble, Handlers } from "@thomasfosterau/effect-jsonapi"
 *
 * const colours = ["red", "green"].map((id) => ({
 *   type: "colours", id, attributes: { name: id },
 *   relationships: { family: { data: { type: "families", id: "primary" } } }
 * }))
 * const families: Handlers.IncludeTarget = (ids) =>
 *   Effect.succeed(ids.map((id) => ({ type: "families", id, attributes: { name: "Primary" } })))
 * const document = Effect.runSync(Assemble.unpaginatedCollection(colours, {
 *   include: ["family"],
 *   includable: ["family"],
 *   targets: { families }
 * }))
 * console.log(document.data.length, document.included?.length, "links" in document, "meta" in document)
 * // → 2 1 false false
 *
 * // …with the collection's own `self` link, carrying the request's query
 * const linked = Effect.runSync(Assemble.unpaginatedCollection(colours, {
 *   self: "https://example.test/colours",
 *   query: [["include", "family"]],
 *   include: ["family"],
 *   includable: ["family"],
 *   targets: { families }
 * }))
 * console.log(linked.links.self)
 * // → https://example.test/colours?include=family
 *
 * // …with document-level `meta`, typed as passed
 * const stamped = Effect.runSync(Assemble.unpaginatedCollection(colours, {
 *   self: "https://example.test/colours",
 *   meta: { generatedAt: "2026-10-08T00:00:00Z" }
 * }))
 * console.log(stamped.meta.generatedAt, stamped.links.self)
 * // → 2026-10-08T00:00:00Z https://example.test/colours
 * ```
 *
 * @since 0.17.0
 * @category constructors
 */
export const unpaginatedCollection = <
  R extends ResourceLike,
  V = unknown,
  Targets extends Handlers.IncludeTargets = never,
  // oxlint-disable-next-line effect/prefer-option-over-null -- see `UnpaginatedCollectionOptions`: inferred from the `self` option as passed
  Self extends string | undefined = undefined,
  // oxlint-disable-next-line effect/prefer-option-over-null -- see `UnpaginatedCollectionOptions`: inferred from the `meta` option as passed
  const M extends Handlers.MetaValue | undefined = undefined,
>(
  resources: ReadonlyArray<R>,
  options: UnpaginatedCollectionOptions<V, Targets, Self, M> = {},
): Effect.Effect<
  // `Self` is widened to `string`, so a literal `self` doesn't leak into the
  // type; `M` is not, since the document emits that very value.
  UnpaginatedCollectionDocument<R, Self extends string ? string : undefined, M>,
  IncludeError | Handlers.IncludeTargetError<Targets>,
  Handlers.IncludeTargetServices<Targets>
> => {
  const links =
    options.self === undefined
      ? {}
      : options.query === undefined
        ? { self: options.self }
        : { self: options.self, query: options.query };
  return assembleCollection<
    UnpaginatedCollectionDocument<R, Self extends string ? string : undefined, M>,
    V,
    Targets
  >(resources, options, options.meta === undefined ? links : { ...links, meta: options.meta });
};

/**
 * Input of {@link relationship}.
 *
 * @since 0.16.0
 * @category models
 */
export interface RelationshipInput<R extends ResourceLike, I extends ResourceLike, V> {
  /** The (post-mutation) parent resource, whose linkage is the document's `data`. */
  readonly parent: R;
  /** The relationship key under `parent.relationships`. */
  readonly key: string;
  readonly viewer?: V | undefined;
  readonly capabilities?: CapabilitiesHook<V> | undefined;
  /**
   * Resources to carry in `included`, typically the related resources the
   * linkage names. Full linkage applies: each must be reachable from the
   * primary identifiers.
   */
  readonly included?: ReadonlyArray<I> | undefined;
}

/**
 * Assembles a §8.4 relationship document: primary `data` is the parent's
 * linkage for `key`, `included` is the extras passed as `included`,
 * deduplicated (empty when none are); `links.related` is the relationship's
 * related link when the parent carries one.
 *
 * The parent itself is never in `included`: the primary data names the
 * related resources, not the parent, so it would be reachable only through a
 * child linking back to it and the document would fail full linkage (#444).
 * A client that needs the post-mutation parent fetches it.
 *
 * @example
 * ```ts
 * import { Assemble } from "@thomasfosterau/effect-jsonapi"
 *
 * const list = {
 *   type: "lists", id: "1", attributes: {},
 *   relationships: { items: { data: [{ type: "books", id: "b1" }], links: { related: "https://example.test/lists/1/items" } } }
 * }
 * const document = Assemble.relationship({ parent: list, key: "items" })
 * console.log(document.data, document.included.length, document.links?.related)
 * // → [ { type: "books", id: "b1" } ] 0 https://example.test/lists/1/items
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const relationship = <R extends ResourceLike, I extends ResourceLike = R, V = unknown>(
  input: RelationshipInput<R, I, V>,
): RelationshipDocument<R, I> => {
  const stamp = onResourceFor(input);
  const emit = (r: ResourceLike): WireResource<ResourceLike> =>
    stamp(asValue(stringifyLinks(r))) as unknown as WireResource<ResourceLike>;
  const seen = new Set<string>();
  const included: Array<WireResource<ResourceLike>> = [];
  for (const candidate of input.included ?? []) {
    const key = `${candidate.type}\0${candidate.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    included.push(emit(candidate));
  }
  const rel = readRelationship(input.parent, input.key);
  const related = rel?.links?.related === undefined ? undefined : toLinkString(rel.links.related);
  return {
    data: rel?.data ?? null,
    included: included as unknown as ReadonlyArray<WireResource<I>>,
    ...(related === undefined || related === "" ? {} : { links: { related } }),
    jsonapi: JSONAPI_MEMBER,
  };
};

/**
 * A page of an **edge** family — a to-many relationship's own rows, served
 * as a collection under `<base>/<segment>` with no capabilities (an edge has
 * no write surface of its own) and no walk. The one shape every edge family
 * shares, stated once.
 *
 * @since 0.16.0
 * @category constructors
 */
export const edgePage = <R extends ResourceLike, V = unknown>(
  segment: string,
  page: { readonly items: ReadonlyArray<R>; readonly totalCount: number },
  input: { readonly limit: number; readonly offset: number },
  base: string,
  viewer?: V,
): Effect.Effect<CollectionDocument<R>> =>
  // No `include` is passed, so the walk's validation can't fail: the error
  // channel really is empty.
  Effect.orDie(
    collection(
      page.items,
      {
        totalCount: page.totalCount,
        offset: input.offset,
        limit: input.limit,
        baseUrl: `${base}/${segment}`,
      },
      { viewer, capabilities: noCapabilities },
    ),
  );
