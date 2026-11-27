/**
 * JSON:API relationship descriptors and their wire schemas.
 *
 * A relationship is declared on a resource definition with one of four
 * constructors, each capturing a distinct cardinality *and* linkage strategy:
 *
 * | Constructor | Cardinality | Wire shape of the relationship object          |
 * | ----------- | ----------- | ----------------------------------------------- |
 * | `one`       | to-one      | `{ data: identifier, links?, meta? }`            |
 * | `optional`  | to-one      | `{ data: identifier \| null, links?, meta? }`    |
 * | `many`      | to-many     | `{ data: identifier[], links?, meta? }`          |
 * | `paginated` | to-many     | `{ links: { related, self? }, meta? }` — no data |
 *
 * `one` / `optional` / `many` carry **inline linkage**: the related resources
 * are referenced by identifier right inside the parent resource, and can be
 * brought into compound documents via `?include=`.
 *
 * `paginated` carries **no inline linkage**: the relationship is unbounded
 * (think a user's repositories, an article's revision history), so its data is
 * only reachable through the required `links.related` URL — a paginated
 * collection endpoint (see `Endpoint.related`). Paginated relationships are
 * excluded from `?include=` paths and from create/update payloads; they are
 * managed through relationship endpoints instead.
 *
 * ```ts skip-type-checking
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person),         // always present
 *     editor: Relationship.optional(() => Person),    // may be null
 *     tags: Relationship.many(() => Tag),             // small, inlined
 *     comments: Relationship.paginated(() => Comment) // unbounded, linked
 *   }
 * })
 * ```
 *
 * The four constructors are presets over a linkage {@link Policy}: whether the
 * relationship object carries `data`, whether `?include=` may name it, whether
 * payloads may set it, and whether its `links` page its linkage. The core
 * {@link toOne} and {@link toMany} take the policy as options, for the designs
 * the presets don't cover: linkage only when included, a links-only to-one, a
 * large to-many that is still includable or settable, a to-many whose `data`
 * is a page with `links.next`.
 *
 * References are lazy thunks (`() => Person`), so a typo'd reference is a
 * compile error and resources can reference each other regardless of
 * declaration order — including in a **cycle** (`Article` ⇄ `Comment`),
 * which needs one interface annotation per resource in the cycle; see
 * `Resource.make`. The lowercase {@link one} / {@link optional} / {@link many}
 * / {@link paginated} descriptor types are there to write those annotations
 * with.
 *
 * A target may also be a `Resource.family(...)` supertype, not just a single
 * resource — linkage then decodes for any member of the family (keyed on the
 * member `type` tag), since a family structurally satisfies `Resource.Any`.
 *
 * @since 0.1.0
 */
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import * as Arr from "effect/Array";
import * as Schema from "effect/Schema";
import {
  AnyMeta,
  PaginatedRelationshipLinks,
  RelationshipLinks,
  RelationshipPaginationLinks,
} from "./Document.js";
import type { Operator } from "./Filter.js";
import type { Any, AttributeKeys } from "./Resource.js";
import type * as Sort from "./Sort.js";
import { declarationError } from "./internal/errors.js";

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * The filter operators a to-one relationship may declare, as a schema: a
 * `Schema.Literals` narrowing `Filter.Operator` to equality and list
 * membership against the related resource's id, plus the null test. Ordering
 * operators make no sense for an id, so `lt` / `lte` / `gt` / `gte` are
 * excluded; declaring one is a definition-time error in `Resource.make`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship } from "@thomasfosterau/effect-jsonapi"
 *
 * Relationship.FilterOperator.literals // ["eq", "ne", "in", "nin", "isnull"]
 * Schema.is(Relationship.FilterOperator)("gt") // false
 * ```
 *
 * @since 0.13.0
 * @category schemas
 */
export const FilterOperator = Schema.Literals([
  "eq",
  "ne",
  "in",
  "nin",
  "isnull",
] as const satisfies ReadonlyArray<Operator>);

/**
 * A filter operator a to-one relationship may declare — the decoded type of
 * the {@link FilterOperator} schema, a subset of `Filter.Operator`.
 *
 * @since 0.13.0
 * @category models
 */
export type FilterOperator = typeof FilterOperator.Type;

/**
 * Every relationship filter operator, in order — the literals of the
 * {@link FilterOperator} schema.
 *
 * @since 0.13.0
 * @category constants
 */
export const filterOperators: typeof FilterOperator.literals = FilterOperator.literals;

/**
 * How a to-one relationship is declared filterable (`Relationship.one(ref, { filter })`):
 * `true` (every operator in {@link filterOperators}), a subset of them, or
 * `false` (the default) — not filterable.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterDeclaration = boolean | ReadonlyArray<FilterOperator>;

/**
 * A to-one relationship's storage key: the name of the field on the declaring
 * resource's stored row that holds the related resource's id (`"authorId"`
 * for `author: Relationship.one(() => Person, { key: "authorId" })`). A
 * descriptor carries it as `Option<K>` — `Option.none()` when none is
 * declared, which the type reads as `Option<never>`. See {@link one}.
 *
 * @since 0.20.0
 * @category type-level
 */
export type StorageKey = string;

/**
 * When a relationship object carries resource linkage (its `data` member).
 * JSON:API 1.1 requires a relationship object to hold at least one of `data`,
 * `links` and `meta`, and leaves linkage itself to the server:
 *
 *   - `"always"`: `data` is on every relationship object. The default for
 *     {@link one}, {@link optional} and {@link many}.
 *   - `"whenIncluded"`: `data` is sent when the relationship's path is in
 *     `?include=`, and may be left out otherwise, so a server need not load ids
 *     it was not asked for. Requires `includable`.
 *   - `"optional"`: `data` may be left out of any response, and so may the
 *     relationship itself.
 *   - `"never"`: no `data`; the relationship object carries a required
 *     `links.related` instead. The policy of {@link paginated}. Cannot be
 *     `includable` (an included resource must be reached through linkage) or
 *     carry `paginationLinks`.
 *
 * Under `"whenIncluded"` and `"optional"` the relationship's key is optional
 * in a resource object's `relationships`, and its `data` member optional in
 * the relationship object. A write still carries `data`: the create and update
 * payloads read the linkage, whatever the response policy.
 *
 * @see {@link https://jsonapi.org/format/1.1/#document-resource-object-relationships}
 *
 * @since 0.23.0
 * @category models
 */
export type Linkage = "always" | "whenIncluded" | "optional" | "never";

/**
 * A relationship's linkage policy: what its relationship object carries and
 * where it may be used, independent of its cardinality. Every descriptor
 * carries these four members; {@link toOne} and {@link toMany} take them as
 * options, and {@link one}, {@link optional}, {@link many} and
 * {@link paginated} are presets over them ({@link Inline} and
 * {@link LinksOnly}).
 *
 * @since 0.23.0
 * @category models
 */
export interface Policy<
  L extends Linkage = Linkage,
  I extends boolean = boolean,
  W extends boolean = boolean,
  PL extends boolean = boolean,
> {
  readonly linkage: L;
  readonly includable: I;
  readonly writable: W;
  readonly paginationLinks: PL;
}

/**
 * The policy of {@link one}, {@link optional} and {@link many}: linkage on
 * every response, includable, writable, no pagination links.
 *
 * @since 0.23.0
 * @category models
 */
export interface Inline extends Policy<"always", true, true, false> {}

/**
 * The policy of {@link paginated}: no linkage, a required `links.related`,
 * never included or written through a payload.
 *
 * @since 0.23.0
 * @category models
 */
export interface LinksOnly extends Policy<"never", false, false, false> {}

const inline: Inline = {
  linkage: "always",
  includable: true,
  writable: true,
  paginationLinks: false,
};

const linksOnly: LinksOnly = {
  linkage: "never",
  includable: false,
  writable: false,
  paginationLinks: false,
};

/**
 * A required to-one relationship: linkage is always a single resource
 * identifier, never `null`. `F` records its `filter` declaration and `K` its
 * storage {@link StorageKey} (`never` when none is declared); `M` is the
 * schema of its relationship object's `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface One<
  Res extends Any,
  F extends FilterDeclaration = FilterDeclaration,
  K extends StorageKey = StorageKey,
  M extends Schema.Top = Schema.Top,
  T extends boolean = boolean,
  P extends Policy = Policy,
> {
  readonly kind: "one";
  readonly ref: () => Res;
  /**
   * Phantom: the resource this relationship points at, in a position a plain
   * indexed access can read (see {@link TargetOf}). Type-level only — it is
   * never present on the descriptor value.
   */
  readonly "~target": Res;
  readonly filter: F;
  /**
   * Whether the target's own filterable and sortable fields are reachable
   * through this relationship as dotted paths (`filter[author.name]`,
   * `sort=author.name`). `false` unless declared with `traverse: true`.
   *
   * @since 0.24.0
   */
  readonly traverse: T;
  /**
   * The name of the field on the declaring resource's stored row that holds
   * the related resource's id (a foreign key such as `authorId`):
   * `Option.some(key)` when the relationship declares one, `Option.none()`
   * when it declares none. A storage fact, not a wire one: it changes nothing
   * in the document, the query grammar or the endpoints. Read by derivations
   * from the resource definition into storage.
   *
   * @since 0.20.0
   */
  readonly key: Option.Option<K>;
  /**
   * The schema of the relationship object's `meta` member: the one declared
   * with the constructor's `meta` option, or `Document.AnyMeta` (an open
   * record) when none is.
   *
   * @since 0.20.0
   */
  readonly meta: M;
  /**
   * Whether the relationship object carries resource linkage (`data`): see
   * {@link Linkage}.
   *
   * @since 0.23.0
   */
  readonly linkage: P["linkage"];
  /**
   * Whether the relationship may be named in `?include=` paths, and its
   * target so appear in a compound document's `included`.
   *
   * @since 0.23.0
   */
  readonly includable: P["includable"];
  /**
   * Whether the relationship may be set in a create or update payload.
   *
   * @since 0.23.0
   */
  readonly writable: P["writable"];
  /**
   * Whether the relationship object's `links` may carry pagination links
   * (`first` / `prev` / `next` / `last`) paging its linkage. To-many only.
   *
   * @since 0.23.0
   */
  readonly paginationLinks: P["paginationLinks"];
}

/**
 * An optional (nullable) to-one relationship: linkage is a single resource
 * identifier or `null`. `F` records its `filter` declaration and `K` its
 * storage {@link StorageKey} (`never` when none is declared); `M` is the
 * schema of its relationship object's `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Optional<
  Res extends Any,
  F extends FilterDeclaration = FilterDeclaration,
  K extends StorageKey = StorageKey,
  M extends Schema.Top = Schema.Top,
  T extends boolean = boolean,
  P extends Policy = Policy,
> {
  readonly kind: "optional";
  readonly ref: () => Res;
  /**
   * Phantom: the resource this relationship points at, in a position a plain
   * indexed access can read (see {@link TargetOf}). Type-level only — it is
   * never present on the descriptor value.
   */
  readonly "~target": Res;
  readonly filter: F;
  /**
   * Whether the target's own filterable and sortable fields are reachable
   * through this relationship as dotted paths (`filter[author.name]`,
   * `sort=author.name`). `false` unless declared with `traverse: true`.
   *
   * @since 0.24.0
   */
  readonly traverse: T;
  /**
   * The name of the field on the declaring resource's stored row that holds
   * the related resource's id (a foreign key such as `authorId`):
   * `Option.some(key)` when the relationship declares one, `Option.none()`
   * when it declares none. A storage fact, not a wire one: it changes nothing
   * in the document, the query grammar or the endpoints. Read by derivations
   * from the resource definition into storage.
   *
   * @since 0.20.0
   */
  readonly key: Option.Option<K>;
  /**
   * The schema of the relationship object's `meta` member: the one declared
   * with the constructor's `meta` option, or `Document.AnyMeta` (an open
   * record) when none is.
   *
   * @since 0.20.0
   */
  readonly meta: M;
  /**
   * Whether the relationship object carries resource linkage (`data`): see
   * {@link Linkage}.
   *
   * @since 0.23.0
   */
  readonly linkage: P["linkage"];
  /**
   * Whether the relationship may be named in `?include=` paths, and its
   * target so appear in a compound document's `included`.
   *
   * @since 0.23.0
   */
  readonly includable: P["includable"];
  /**
   * Whether the relationship may be set in a create or update payload.
   *
   * @since 0.23.0
   */
  readonly writable: P["writable"];
  /**
   * Whether the relationship object's `links` may carry pagination links
   * (`first` / `prev` / `next` / `last`) paging its linkage. To-many only.
   *
   * @since 0.23.0
   */
  readonly paginationLinks: P["paginationLinks"];
}

/**
 * A to-many relationship with inline linkage: an array of resource
 * identifiers (possibly empty). `M` is the schema of its relationship
 * object's `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Many<
  Res extends Any,
  M extends Schema.Top = Schema.Top,
  P extends Policy = Policy,
> {
  readonly kind: "many";
  readonly ref: () => Res;
  /**
   * Phantom: the resource this relationship points at, in a position a plain
   * indexed access can read (see {@link TargetOf}). Type-level only — it is
   * never present on the descriptor value.
   */
  readonly "~target": Res;
  /**
   * The schema of the relationship object's `meta` member: the one declared
   * with the constructor's `meta` option, or `Document.AnyMeta` (an open
   * record) when none is.
   *
   * @since 0.20.0
   */
  readonly meta: M;
  /**
   * Whether the relationship object carries resource linkage (`data`): see
   * {@link Linkage}.
   *
   * @since 0.23.0
   */
  readonly linkage: P["linkage"];
  /**
   * Whether the relationship may be named in `?include=` paths, and its
   * target so appear in a compound document's `included`.
   *
   * @since 0.23.0
   */
  readonly includable: P["includable"];
  /**
   * Whether the relationship may be set in a create or update payload.
   *
   * @since 0.23.0
   */
  readonly writable: P["writable"];
  /**
   * Whether the relationship object's `links` may carry pagination links
   * (`first` / `prev` / `next` / `last`) paging its linkage. To-many only.
   *
   * @since 0.23.0
   */
  readonly paginationLinks: P["paginationLinks"];
}

/**
 * The **canonical order** of a paginated relationship: a non-empty list of
 * {@link Sort.Term}s over the related resource's attributes, or its `id`.
 *
 * Ordering is part of a paginated relationship's wire contract, not a storage
 * detail. A `paginated` relationship carries no inline linkage, so its members
 * are reachable *only* through `links.related` — a paginated collection whose
 * `first` / `prev` / `next` / `last` links only denote a well-defined sequence
 * of pages if the collection has a total order. Without one, paging the same
 * relationship twice may repeat or skip members, and the pagination links the
 * document itself advertises are unsound. Cursor pagination makes this sharpest:
 * a cursor *is* a position in an order.
 *
 * The declaration is spelled in the package's own sort vocabulary
 * ({@link Sort.Term}, what `Query.Sort` decodes `?sort=` into), so it is
 * directly the order the relationship's `Endpoint.related` collection is to be
 * served in when the client asks for no `sort` of its own. Declaring it is what
 * this package does; serving it is the handler's job — nothing here reorders a
 * collection on your behalf.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Order<Res extends Any> = ReadonlyArray<Sort.Term<AttributeKeys<Res> | "id">>;

/**
 * An unbounded to-many relationship with *no* inline linkage: the relationship
 * object carries only a required `related` link pointing at a paginated
 * collection endpoint. `O` records its declared canonical {@link Order}
 * (`never` when none is declared); `M` is the schema of its relationship
 * object's `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Paginated<
  Res extends Any,
  O extends Order<Res> = Order<Res>,
  M extends Schema.Top = Schema.Top,
> {
  readonly kind: "paginated";
  readonly ref: () => Res;
  /**
   * Phantom: the resource this relationship points at, in a position a plain
   * indexed access can read (see {@link TargetOf}). Type-level only — it is
   * never present on the descriptor value.
   */
  readonly "~target": Res;
  /**
   * The declared canonical {@link Order} of the related collection:
   * `Option.some(order)` when the relationship declares one, `Option.none()`
   * when it declares none.
   *
   * @since 0.15.0
   */
  readonly order: Option.Option<O>;
  /**
   * The schema of the relationship object's `meta` member: the one declared
   * with the constructor's `meta` option, or `Document.AnyMeta` (an open
   * record) when none is.
   *
   * @since 0.20.0
   */
  readonly meta: M;
  /** A paginated relationship never carries linkage (see {@link Linkage}). */
  readonly linkage: "never";
  /** A paginated relationship is never included. */
  readonly includable: false;
  /** A paginated relationship is never set in a create or update payload. */
  readonly writable: false;
  /** A paginated relationship has no linkage for pagination links to page. */
  readonly paginationLinks: false;
}

/**
 * The type of `Relationship.one(ref)` — {@link One} with the `filter`
 * declaration defaulted the way the constructor defaults it (`false`, not
 * filterable), rather than to the whole {@link FilterDeclaration} union.
 *
 * Reach for it when writing the interface annotation that makes a
 * mutually-recursive resource graph authorable (see `Resource.make`): a
 * resource definition is **invariant** in its relationship record, so the
 * annotation has to name the same type the constructor produced.
 * `Relationship.one<Comment>` is that type, and reads like the declaration it
 * annotates. For a filterable relationship, pass the declaration as the
 * `const` tuple the constructor infers:
 * `Relationship.one<Comment, readonly ["eq", "in"]>`.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface one<
  Res extends Any,
  F extends FilterDeclaration = false,
  K extends StorageKey = never,
  M extends Schema.Top = typeof AnyMeta,
  T extends boolean = false,
  P extends Policy = Inline,
> extends One<Res, F, K, M, T, P> {}

/**
 * The type of `Relationship.optional(ref)` — {@link Optional} with the
 * `filter` declaration defaulted to `false`, as the constructor defaults it.
 * The {@link one} note on annotating recursive definitions applies here too.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface optional<
  Res extends Any,
  F extends FilterDeclaration = false,
  K extends StorageKey = never,
  M extends Schema.Top = typeof AnyMeta,
  T extends boolean = false,
  P extends Policy = Inline,
> extends Optional<Res, F, K, M, T, P> {}

/**
 * The type of `Relationship.many(ref)` — {@link Many}, named to read like the
 * declaration it annotates in a recursive resource definition.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface many<
  Res extends Any,
  M extends Schema.Top = typeof AnyMeta,
  P extends Policy = Inline,
> extends Many<Res, M, P> {}

/**
 * The type of `Relationship.paginated(ref)` — {@link Paginated} with the
 * canonical {@link Order} defaulted the way the constructor defaults it
 * (`never`, no declared order: `order` is `Option<never>`), rather than to
 * the whole `Order<Res>`. Named to read like the declaration it
 * annotates in a recursive resource definition; the {@link one} note on
 * annotating recursive definitions applies here too. For a relationship that
 * declares an order, pass it as the `const` tuple the constructor infers:
 * `Relationship.paginated<Comment, readonly [{ field: "createdAt"; direction: "desc" }]>`.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface paginated<
  Res extends Any,
  O extends Order<Res> = never,
  M extends Schema.Top = typeof AnyMeta,
> extends Paginated<Res, O, M> {}

/**
 * Any relationship descriptor.
 *
 * @since 0.1.0
 * @category models
 */
export type Descriptor = One<Any> | Optional<Any> | Many<Any> | Paginated<Any>;

/**
 * A record of relationship descriptors, as written in a resource definition.
 *
 * @since 0.1.0
 * @category models
 */
export type Relationships = { readonly [key: string]: Descriptor };

/**
 * The to-one descriptors: linkage is a single identifier (nullable or not).
 *
 * @since 0.1.0
 * @category models
 */
export type ToOne<Res extends Any> = One<Res> | Optional<Res>;

/**
 * The to-many (collection-valued) descriptors.
 *
 * @since 0.1.0
 * @category models
 */
export type ToMany<Res extends Any> = Many<Res> | Paginated<Res>;

/**
 * The descriptor kinds that can carry inline `data` linkage — everything
 * except `paginated`. A {@link toOne} or {@link toMany} with
 * `linkage: "never"` is one of these kinds and still carries none; read
 * {@link isLinkable} for the policy.
 *
 * @since 0.1.0
 * @category models
 */
export type Linkable<Res extends Any> = One<Res> | Optional<Res> | Many<Res>;

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * The options {@link one} and {@link optional} take.
 *
 * @since 0.20.0
 * @category models
 */
export interface ToOneOptions<
  F extends FilterDeclaration = FilterDeclaration,
  K extends StorageKey = StorageKey,
  M extends Schema.Top = Schema.Top,
  T extends boolean = boolean,
> extends MetaOptions<M> {
  /** Make the relationship a filterable field of its resource (see {@link one}). */
  readonly filter?: F;
  /**
   * Expose the target's own filterable and sortable fields through this
   * relationship as dotted paths (`filter[author.name]`, `sort=author.name`;
   * see {@link one}).
   */
  readonly traverse?: T;
  /**
   * The relationship's storage {@link StorageKey}: the field of the declaring
   * resource's stored row that holds the related id. A non-empty string,
   * distinct from every attribute name and from every other to-one
   * relationship's key on the same resource; `Resource.make` refuses a
   * violation at definition time.
   */
  readonly key?: K;
}

/**
 * The `meta` option every relationship constructor takes: the schema of the
 * relationship object's `meta` member, which the resource schema, its
 * documents, `Document.wire` and so the endpoints and their OpenAPI and
 * client types then carry, in place of the open `Document.AnyMeta` record.
 *
 * @since 0.20.0
 * @category models
 */
export interface MetaOptions<M extends Schema.Top = Schema.Top> {
  /**
   * The schema of the relationship object's `meta` member, such as
   * `Schema.Struct({ totalCount: Schema.Finite })` for a to-many arm whose
   * linkage is capped per parent. Defaults to `Document.AnyMeta`.
   */
  readonly meta?: M;
}

// An empty key names no field: refused when the relationship is declared.
// The checks that need the whole resource (an attribute or another to-one
// relationship with the same key) run in `Resource.make`.
const storageKey = <K extends StorageKey>(
  constructor: string,
  key: Option.Option<K>,
): Option.Option<K> => {
  if (Option.isSome(key) && key.value === "") {
    throw declarationError(
      `${constructor}: \`key\` is empty; name the stored field that holds the related id, or omit the option`,
    );
  }
  return key;
};

/**
 * Declares a required to-one relationship: `data` is always a resource
 * identifier, never `null`. Required in create payloads.
 *
 * The reference is a thunk so resources can reference each other regardless of
 * declaration order, cycles included; a mutually-recursive pair needs an
 * explicit interface annotation on each definition in the cycle (see
 * `Resource.make`).
 *
 * Pass `filter` to make the relationship a filterable field of its resource
 * (`?filter[author]=9`), valued by the related resource's id: `true` admits
 * every operator in {@link filterOperators}, an array admits that subset. The
 * declaration is read by `Resource.filterable`; the literal codec is the
 * target's `Id` schema, resolved lazily.
 *
 * Pass `traverse: true` to reach the target's own filterable and sortable
 * fields through the relationship as dotted paths: `filter[author.name]=Ada`
 * and `sort=author.name` when the target declares `name` filterable and
 * sortable. The path keys join the declaring resource's
 * `Resource.filterable` / `Resource.sortable` with the target's declaration
 * (operators and literal codec) unchanged. One hop only: the target's own
 * paths are not reached through it. A handler or data adapter translates a
 * dotted field into a join.
 *
 * Pass `key` to declare the relationship's storage key: the field of the
 * declaring resource's stored row that holds the related id (a foreign key,
 * `authorId`). It is a storage fact, not a wire one — on the wire the
 * relationship stays linkage, never an attribute — read off the descriptor
 * (`Resource.relationships(Article).author.key`) by a derivation into storage
 * or a sync engine, so the fact is declared once, beside the relationship. It
 * must be non-empty, must not be an attribute name of the resource, and must
 * not repeat across the resource's to-one relationships; `Resource.make`
 * refuses a violation at definition time. The descriptor's `key` is
 * `Option.some(key)` when declared and `Option.none()` without it.
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Option, Schema } from "effect"
 * import { strictEqual } from "node:assert"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person, { filter: ["eq", "in"], key: "authorId" })
 *   }
 * })
 *
 * Resource.filterable(Article).author.operators // ["eq", "in"]
 * // `Option.some("authorId")`; a derivation into storage falls back to its own default
 * const column = Option.getOrElse(Resource.relationships(Article).author.key, () => "author_id")
 * strictEqual(column, "authorId")
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
// `NoInfer` keeps `F` from being inferred off the *contextual* return type
// (`Relationships` widens it to the whole `FilterDeclaration` inside a
// `Resource.make` call); it is inferred from `options.filter` alone, and
// defaults to `false`.
// The cast on each constructor's result is for the descriptors' phantom
// `~target` member, which is type-level only and has no runtime counterpart.
export const one = <
  Res extends Any,
  const F extends FilterDeclaration = false,
  const K extends StorageKey = never,
  M extends Schema.Top = typeof AnyMeta,
  const T extends boolean = false,
>(
  ref: () => Res,
  options?: ToOneOptions<F, K, M, T>,
): One<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>, NoInfer<T>, Inline> =>
  ({
    kind: "one",
    ref,
    filter: options?.filter ?? false,
    traverse: options?.traverse ?? false,
    key: storageKey("Relationship.one", Option.fromUndefinedOr(options?.key)),
    meta: options?.meta ?? AnyMeta,
    ...inline,
  }) as One<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>, NoInfer<T>, Inline>;

/**
 * Declares an optional (nullable) to-one relationship: `data` is a resource
 * identifier or `null`.
 *
 * Takes the same `filter` and `key` options as {@link one}; `isnull` is the
 * natural filter operator here (`?filter[assignee][isnull]=true`).
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * const Issue = Resource.make("issues", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { assignee: Relationship.optional(() => Person, { filter: true }) }
 * })
 *
 * Resource.filterable(Issue).assignee.operators // ["eq", "ne", "in", "nin", "isnull"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const optional = <
  Res extends Any,
  const F extends FilterDeclaration = false,
  const K extends StorageKey = never,
  M extends Schema.Top = typeof AnyMeta,
  const T extends boolean = false,
>(
  ref: () => Res,
  options?: ToOneOptions<F, K, M, T>,
): Optional<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>, NoInfer<T>, Inline> =>
  ({
    kind: "optional",
    ref,
    filter: options?.filter ?? false,
    traverse: options?.traverse ?? false,
    key: storageKey("Relationship.optional", Option.fromUndefinedOr(options?.key)),
    meta: options?.meta ?? AnyMeta,
    ...inline,
  }) as Optional<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>, NoInfer<T>, Inline>;

/**
 * Declares a to-many relationship with inline linkage: `data` is an array of
 * resource identifiers (possibly empty). Suited to small, bounded collections.
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Tag = Resource.make("tags", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { tags: Relationship.many(() => Tag) }
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const many = <Res extends Any, M extends Schema.Top = typeof AnyMeta>(
  ref: () => Res,
  options?: MetaOptions<M>,
): Many<Res, NoInfer<M>, Inline> =>
  ({ kind: "many", ref, meta: options?.meta ?? AnyMeta, ...inline }) as Many<
    Res,
    NoInfer<M>,
    Inline
  >;

/**
 * Declares an unbounded to-many relationship with no inline linkage: the
 * relationship object carries only a required `related` link pointing at a
 * paginated collection endpoint (see `Endpoint.related`).
 *
 * Paginated relationships are excluded from `?include=` paths, compound
 * `included` unions and create/update payloads — they are read and written
 * through their own endpoints. This is the {@link LinksOnly} policy; reach for
 * {@link toMany} with `linkage: "never"` for a links-only to-many that a payload
 * may still set.
 *
 * Pass `order` to declare the relationship's canonical {@link Order} — the
 * total order its `links.related` collection is paged in. Paging is only
 * well-defined over a stable order (see {@link Order}), so this is a property of
 * the relationship's wire contract, and it is read straight off the descriptor:
 * `Resource.relationships(Article).comments.order`, `Option.some(terms)` when
 * declared and `Option.none()` without it. Each term names an attribute
 * of the *related* resource, or its `id`; a term naming anything else is a
 * compile error, and an empty or repeating order is refused at definition time.
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString, createdAt: Schema.DateFromString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     // newest first, `id` breaking ties so the order is total (and so a
 *     // cursor into it is stable)
 *     comments: Relationship.paginated(() => Comment, {
 *       order: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "asc" }]
 *     })
 *   }
 * })
 *
 * Resource.relationships(Article).comments.order
 * // Option.some([{ field: "createdAt", direction: "desc" }, { field: "id", direction: "asc" }])
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
// `NoInfer` keeps `O` from being inferred off the *contextual* return type (the
// `Relationships` record of a `Resource.make` call widens it); it is inferred
// from `options.order` alone, and defaults to `never` — no declared order.
export const paginated = <
  Res extends Any,
  const O extends Order<Res> = never,
  M extends Schema.Top = typeof AnyMeta,
>(
  ref: () => Res,
  options?: { readonly order?: O } & MetaOptions<M>,
): Paginated<Res, NoInfer<O>, NoInfer<M>> => {
  const order = options?.order;
  if (order !== undefined) {
    if (Arr.isReadonlyArrayEmpty(order)) {
      throw declarationError(
        "Relationship.paginated: `order` declares no terms; name at least one, or omit the option",
      );
    }
    const seen = MutableHashSet.empty<string>();
    Arr.forEach(order, (term) => {
      if (MutableHashSet.has(seen, term.field)) {
        throw declarationError(
          `Relationship.paginated: \`order\` names "${term.field}" more than once; each term must order by a distinct field`,
        );
      }
      MutableHashSet.add(seen, term.field);
    });
  }
  return {
    kind: "paginated",
    ref,
    order: order === undefined ? Option.none<O>() : Option.some(order),
    meta: options?.meta ?? AnyMeta,
    ...linksOnly,
  } as Paginated<Res, NoInfer<O>, NoInfer<M>>;
};

/**
 * The policy options {@link toOne} and {@link toMany} take; each defaults to
 * the {@link Inline} preset's value. See {@link Linkage}.
 *
 * @since 0.23.0
 * @category models
 */
export interface PolicyOptions<
  L extends Linkage = Linkage,
  I extends boolean = boolean,
  W extends boolean = boolean,
> {
  /** When the relationship object carries `data` (default `"always"`). */
  readonly linkage?: L;
  /**
   * Whether `?include=` may name the relationship. Defaults to `true`, or
   * `false` under `linkage: "never"`, which cannot be included.
   */
  readonly includable?: I;
  /** Whether create and update payloads may set the relationship (default `true`). */
  readonly writable?: W;
}

/**
 * The options {@link toOne} takes: {@link one}'s, a policy, and whether
 * linkage may be `null`.
 *
 * @since 0.23.0
 * @category models
 */
export interface ToOneCoreOptions<
  N extends boolean = boolean,
  F extends FilterDeclaration = FilterDeclaration,
  K extends StorageKey = StorageKey,
  M extends Schema.Top = Schema.Top,
  L extends Linkage = Linkage,
  I extends boolean = boolean,
  W extends boolean = boolean,
  T extends boolean = boolean,
>
  extends ToOneOptions<F, K, M, T>, PolicyOptions<L, I, W> {
  /** `true` for linkage that may be `null` ({@link optional}); `false` by default ({@link one}). */
  readonly nullable?: N;
}

/**
 * The options {@link toMany} takes: {@link many}'s, a policy, and whether the
 * relationship object may carry pagination links.
 *
 * @since 0.23.0
 * @category models
 */
export interface ToManyCoreOptions<
  M extends Schema.Top = Schema.Top,
  L extends Linkage = Linkage,
  I extends boolean = boolean,
  W extends boolean = boolean,
  PL extends boolean = boolean,
>
  extends MetaOptions<M>, PolicyOptions<L, I, W> {
  /**
   * `true` lets `links` carry `first` / `prev` / `next` / `last`, paging the
   * relationship's `data` (JSON:API 1.1: "Any pagination links in a
   * relationship object MUST paginate the relationship data"). Default
   * `false`; refused under `linkage: "never"`, which has no data to page.
   */
  readonly paginationLinks?: PL;
}

/**
 * The type of `Relationship.toOne(ref, options)`: an {@link Optional} when
 * `N` (the `nullable` option) is `true`, a {@link One} otherwise.
 *
 * @since 0.23.0
 * @category type-level
 */
export type ToOneDescriptor<
  Res extends Any,
  N extends boolean,
  F extends FilterDeclaration,
  K extends StorageKey,
  M extends Schema.Top,
  T extends boolean,
  P extends Policy,
> = N extends true ? Optional<Res, F, K, M, T, P> : One<Res, F, K, M, T, P>;

/**
 * The default `includable` for a {@link Linkage}: `false` under `"never"`,
 * `true` otherwise.
 *
 * @since 0.23.0
 * @category type-level
 */
export type DefaultIncludable<L extends Linkage> = L extends "never" ? false : true;

// Builds and checks a policy: the combinations the spec rules out are refused
// when the relationship is declared.
const policyOf = (
  constructor: string,
  options?: PolicyOptions & { readonly paginationLinks?: boolean },
): Policy => {
  const linkage = options?.linkage ?? "always";
  const includable = options?.includable ?? linkage !== "never";
  const paginationLinks = options?.paginationLinks ?? false;
  if (linkage === "never" && includable) {
    throw declarationError(
      `${constructor}: \`linkage: "never"\` cannot be \`includable\`; an included resource must be reached through linkage`,
    );
  }
  if (linkage === "never" && paginationLinks) {
    throw declarationError(
      `${constructor}: \`linkage: "never"\` cannot carry \`paginationLinks\`; they page the relationship's data`,
    );
  }
  if (linkage === "whenIncluded" && !includable) {
    throw declarationError(
      `${constructor}: \`linkage: "whenIncluded"\` needs \`includable\`; without it the linkage is never sent`,
    );
  }
  return { linkage, includable, writable: options?.writable ?? true, paginationLinks };
};

/**
 * Declares a to-one relationship with an explicit {@link Policy}: the core
 * {@link one} and {@link optional} are presets of (`toOne(ref)` is
 * `one(ref)`, `toOne(ref, { nullable: true })` is `optional(ref)`).
 *
 * Reach for it when the server shows less than inline linkage on every
 * response: linkage only when included, a links-only relationship for an
 * expensive lookup, or one a response may leave out. A combination the spec
 * rules out (see {@link Linkage}) throws when declared.
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 * import { strictEqual } from "node:assert"
 *
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     // `data` only when `?include=author` asks for it
 *     author: Relationship.toOne(() => Person, { linkage: "whenIncluded" }),
 *     // only `links.related`, never included
 *     reviewer: Relationship.toOne(() => Person, { nullable: true, linkage: "never" })
 *   }
 * })
 *
 * const decode = Schema.decodeUnknownSync(Article)
 * const article = decode({
 *   type: "articles",
 *   id: "1",
 *   attributes: { title: "Hello" },
 *   relationships: {
 *     author: { links: { related: "/articles/1/author" } },
 *     reviewer: { links: { related: "/articles/1/reviewer" } }
 *   }
 * })
 * strictEqual(article.relationships?.author?.data, undefined)
 * ```
 *
 * @since 0.23.0
 * @category constructors
 */
export const toOne = <
  Res extends Any,
  const N extends boolean = false,
  const F extends FilterDeclaration = false,
  const K extends StorageKey = never,
  M extends Schema.Top = typeof AnyMeta,
  const L extends Linkage = "always",
  const I extends boolean = DefaultIncludable<L>,
  const W extends boolean = true,
  const T extends boolean = false,
>(
  ref: () => Res,
  options?: ToOneCoreOptions<N, F, K, M, L, I, W, T>,
): ToOneDescriptor<
  Res,
  NoInfer<N>,
  NoInfer<F>,
  NoInfer<K>,
  NoInfer<M>,
  NoInfer<T>,
  Policy<NoInfer<L>, NoInfer<I>, NoInfer<W>, false>
> => {
  const kind = options?.nullable === true ? "optional" : "one";
  const constructor = "Relationship.toOne";
  // SAFETY: `kind` follows `nullable` as `ToOneDescriptor` does, and the
  // phantom `~target` has no runtime counterpart.
  return {
    kind,
    ref,
    filter: options?.filter ?? false,
    traverse: options?.traverse ?? false,
    key: storageKey(constructor, Option.fromUndefinedOr(options?.key)),
    meta: options?.meta ?? AnyMeta,
    ...policyOf(constructor, options),
  } as never;
};

/**
 * Declares a to-many relationship with an explicit {@link Policy}: the core
 * {@link many} is a preset of (`toMany(ref)` is `many(ref)`), and
 * {@link paginated} is its `linkage: "never"` counterpart with a canonical
 * order.
 *
 * Reach for it for a large to-many that is still includable or settable on
 * create, one whose `data` is a page of its linkage with `links.next` paging
 * the rest (`paginationLinks: true`), or one whose linkage is sent only when
 * included. A combination the spec rules out (see {@link Linkage}) throws when
 * declared.
 *
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 * import { deepStrictEqual } from "node:assert"
 *
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     comments: Relationship.toMany(() => Comment, { paginationLinks: true })
 *   }
 * })
 *
 * const decode = Schema.decodeUnknownSync(Article)
 * const article = decode({
 *   type: "articles",
 *   id: "1",
 *   attributes: { title: "Hello" },
 *   relationships: {
 *     comments: {
 *       data: [{ type: "comments", id: "5" }],
 *       links: { next: "/articles/1/relationships/comments?page[offset]=1" }
 *     }
 *   }
 * })
 * deepStrictEqual(article.relationships?.comments.links?.next, "/articles/1/relationships/comments?page[offset]=1")
 * ```
 *
 * @since 0.23.0
 * @category constructors
 */
export const toMany = <
  Res extends Any,
  M extends Schema.Top = typeof AnyMeta,
  const L extends Linkage = "always",
  const I extends boolean = DefaultIncludable<L>,
  const W extends boolean = true,
  const PL extends boolean = false,
>(
  ref: () => Res,
  options?: ToManyCoreOptions<M, L, I, W, PL>,
): Many<Res, NoInfer<M>, Policy<NoInfer<L>, NoInfer<I>, NoInfer<W>, NoInfer<PL>>> =>
  ({
    kind: "many",
    ref,
    meta: options?.meta ?? AnyMeta,
    ...policyOf("Relationship.toMany", options),
  }) as Many<Res, NoInfer<M>, Policy<NoInfer<L>, NoInfer<I>, NoInfer<W>, NoInfer<PL>>>;

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Whether a descriptor's relationship object may carry `data` linkage: every
 * {@link Linkage} but `"never"`.
 *
 * @since 0.1.0
 * @category accessors
 */
export const isLinkable = (descriptor: Descriptor): boolean => descriptor.linkage !== "never";

/**
 * Whether `?include=` may name a descriptor's relationship (its
 * {@link Policy}'s `includable`).
 *
 * @since 0.23.0
 * @category accessors
 */
export const isIncludable = (descriptor: Descriptor): boolean => descriptor.includable;

/**
 * Whether create and update payloads may set a descriptor's relationship (its
 * {@link Policy}'s `writable`).
 *
 * @since 0.23.0
 * @category accessors
 */
export const isWritable = (descriptor: Descriptor): boolean => descriptor.writable;

/**
 * Whether a descriptor is to-one (`one` or `optional`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const isToOne = (descriptor: Descriptor): descriptor is ToOne<Any> =>
  descriptor.kind === "one" || descriptor.kind === "optional";

/**
 * Whether a descriptor is to-many (`many` or `paginated`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const isToMany = (descriptor: Descriptor): descriptor is ToMany<Any> =>
  descriptor.kind === "many" || descriptor.kind === "paginated";

// ---------------------------------------------------------------------------
// Wire schemas (derived from descriptors)
// ---------------------------------------------------------------------------

/**
 * The wire schema of a required to-one relationship:
 * `{ data: identifier, links?, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface OneSchema<
  Res extends Any,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Schema.suspend<Res["identifier"]>;
  readonly links: Schema.optionalKey<typeof RelationshipLinks>;
  readonly meta: Schema.optionalKey<M>;
}> {}

/**
 * The wire schema of an optional to-one relationship:
 * `{ data: identifier | null, links?, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface OptionalSchema<
  Res extends Any,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Schema.NullOr<Schema.suspend<Res["identifier"]>>;
  readonly links: Schema.optionalKey<typeof RelationshipLinks>;
  readonly meta: Schema.optionalKey<M>;
}> {}

/**
 * The wire schema of an inline to-many relationship:
 * `{ data: identifier[], links?, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ManySchema<
  Res extends Any,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Schema.$Array<Schema.suspend<Res["identifier"]>>;
  readonly links: Schema.optionalKey<typeof RelationshipLinks>;
  readonly meta: Schema.optionalKey<M>;
}> {}

/**
 * The wire schema of a paginated to-many relationship: *no* `data`; `links`
 * (with a required `related` member) is mandatory.
 *
 * @since 0.1.0
 * @category models
 */
export interface PaginatedSchema<M extends Schema.Top = typeof AnyMeta> extends Schema.Struct<{
  readonly links: typeof PaginatedRelationshipLinks;
  readonly meta: Schema.optionalKey<M>;
}> {}

/**
 * The wire schema of a relationship whose `data` is on every relationship
 * object and whose `links` take `Links`: a {@link toMany} with
 * `paginationLinks`, where {@link OneSchema} / {@link OptionalSchema} /
 * {@link ManySchema} are the presets' fixed spelling of it.
 *
 * @since 0.23.0
 * @category models
 */
export interface LinkedSchema<
  Data extends Schema.Top,
  Links extends Schema.Top,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Data;
  readonly links: Schema.optionalKey<Links>;
  readonly meta: Schema.optionalKey<M>;
}> {}

/**
 * The wire schema of a relationship whose {@link Linkage} is `"whenIncluded"`
 * or `"optional"`: `data` may be left out.
 *
 * @since 0.23.0
 * @category models
 */
export interface MaybeLinkedSchema<
  Data extends Schema.Top,
  Links extends Schema.Top,
  M extends Schema.Top = typeof AnyMeta,
> extends Schema.Struct<{
  readonly data: Schema.optionalKey<Data>;
  readonly links: Schema.optionalKey<Links>;
  readonly meta: Schema.optionalKey<M>;
}> {}

// The linkage (`data`) schema of a descriptor, by cardinality.
const dataSchema = (descriptor: Descriptor): Schema.Top => {
  const identifier = Schema.suspend(() => descriptor.ref().identifier);
  return descriptor.kind === "one"
    ? identifier
    : descriptor.kind === "optional"
      ? Schema.NullOr(identifier)
      : Schema.Array(identifier);
};

const makePaginatedSchema = <M extends Schema.Top>(descriptor: {
  readonly meta: M;
}): PaginatedSchema<M> =>
  Schema.Struct({
    links: PaginatedRelationshipLinks,
    meta: Schema.optionalKey(metaOf(descriptor)),
  });

// A descriptor built before relationship `meta` was declarable (or by hand)
// carries no `meta`; it reads as the open record it always had.
const metaOf = <M extends Schema.Top>(descriptor: { readonly meta: M }): M =>
  // SAFETY: `M` defaults to `typeof AnyMeta` wherever the descriptor carries none.
  descriptor.meta ?? AnyMeta;

/**
 * The resource a relationship descriptor points at — the return type of its
 * `ref` thunk.
 *
 * Reads the target off the descriptor's one structural member rather than
 * matching the descriptor against `One<infer Res>` / `Many<infer Res>` / …: a
 * whole-descriptor `infer` has to relate the *target resource* to each
 * candidate interface, which is a loop TypeScript cannot close when the
 * resource graph is cyclic (see {@link SchemaFor}).
 *
 * @since 0.15.0
 * @category type-level
 */
export type TargetOf<D extends Descriptor> = D["~target"];

/**
 * The linkage (`data`) schema of a relationship descriptor, by cardinality:
 * an identifier, a nullable one, or an array of them.
 *
 * @since 0.23.0
 * @category type-level
 */
export type DataSchemaOf<D extends Descriptor> = {
  readonly one: Schema.suspend<TargetOf<D>["identifier"]>;
  readonly optional: Schema.NullOr<Schema.suspend<TargetOf<D>["identifier"]>>;
  readonly many: Schema.$Array<Schema.suspend<TargetOf<D>["identifier"]>>;
  readonly paginated: Schema.$Array<Schema.suspend<TargetOf<D>["identifier"]>>;
}[D["kind"]];

/**
 * The `links` schema of a relationship descriptor that carries linkage:
 * `Document.RelationshipPaginationLinks` under `paginationLinks`, else
 * `Document.RelationshipLinks`.
 *
 * @since 0.23.0
 * @category type-level
 */
export type LinksSchemaOf<D extends Descriptor> = D["paginationLinks"] extends true
  ? typeof RelationshipPaginationLinks
  : typeof RelationshipLinks;

/**
 * The schema a create or update payload reads a relationship with: its
 * linkage always present, whatever the descriptor's response {@link Linkage}.
 * Selected by the descriptor's `kind` tag (see {@link SchemaFor}).
 *
 * @since 0.23.0
 * @category type-level
 */
export type WriteSchemaFor<D extends Descriptor> = {
  readonly one: OneSchema<TargetOf<D>, MetaOf<D>>;
  readonly optional: OptionalSchema<TargetOf<D>, MetaOf<D>>;
  readonly many: ManySchema<TargetOf<D>, MetaOf<D>>;
  readonly paginated: ManySchema<TargetOf<D>, MetaOf<D>>;
}[D["kind"]];

/**
 * The wire schema of a single relationship descriptor, read off its
 * {@link Policy}: {@link PaginatedSchema} under `linkage: "never"`,
 * {@link MaybeLinkedSchema} when linkage may be left out, and otherwise the
 * preset's {@link OneSchema} / {@link OptionalSchema} / {@link ManySchema}
 * (or a {@link LinkedSchema} with pagination links).
 *
 * The cardinality is selected by the descriptor's `kind` tag — a plain
 * indexed access — rather than by a chain of `D extends One<infer Res> ? …`
 * conditionals. The two agree on every descriptor, but only this one survives
 * a **cyclic** resource graph: matching `D` against `One<infer Res>` makes
 * TypeScript relate the target resource to the descriptor interfaces, and in
 * an `Article` ⇄ `Comment` cycle that relation re-enters the very mapped type
 * it is computing (`TS2615`).
 *
 * @since 0.1.0
 * @category type-level
 */
export type SchemaFor<D extends Descriptor> = D["linkage"] extends "never"
  ? PaginatedSchema<MetaOf<D>>
  : D["linkage"] extends "always"
    ? D["paginationLinks"] extends true
      ? LinkedSchema<DataSchemaOf<D>, LinksSchemaOf<D>, MetaOf<D>>
      : WriteSchemaFor<D>
    : MaybeLinkedSchema<DataSchemaOf<D>, LinksSchemaOf<D>, MetaOf<D>>;

/**
 * The schema of a relationship descriptor's `meta` member: the one its
 * constructor's `meta` option declared, or `Document.AnyMeta`.
 *
 * @since 0.20.0
 * @category type-level
 */
export type MetaOf<D extends Descriptor> = D["meta"];

/**
 * Creates the wire schema for a relationship descriptor (see {@link SchemaFor}).
 *
 * @since 0.1.0
 * @category constructors
 */
export const schemaFor = <D extends Descriptor>(descriptor: D): SchemaFor<D> => {
  if (descriptor.linkage === "never") return makePaginatedSchema(descriptor) as SchemaFor<D>;
  const data = dataSchema(descriptor);
  return Schema.Struct({
    data: descriptor.linkage === "always" ? data : Schema.optionalKey(data),
    links: Schema.optionalKey(
      descriptor.paginationLinks ? RelationshipPaginationLinks : RelationshipLinks,
    ),
    meta: Schema.optionalKey(metaOf(descriptor)),
  }) as SchemaFor<D>;
};

/**
 * Creates the schema a create or update payload reads a relationship with
 * (see {@link WriteSchemaFor}).
 *
 * @since 0.23.0
 * @category constructors
 */
export const writeSchemaFor = <D extends Descriptor>(descriptor: D): WriteSchemaFor<D> =>
  Schema.Struct({
    data: dataSchema(descriptor),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(metaOf(descriptor)),
  }) as WriteSchemaFor<D>;

/**
 * Maps a record of relationship descriptors to their wire schemas.
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelationshipSchemas<Rels extends Relationships> = {
  readonly [K in keyof Rels]: SchemaFor<Rels[K]>;
};

/**
 * Creates the wire schemas for a record of relationship descriptors.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeRelationshipSchemas = <Rels extends Relationships>(
  rels: Rels,
): RelationshipSchemas<Rels> =>
  R.map(rels, (descriptor) => schemaFor(descriptor)) as RelationshipSchemas<Rels>;

/**
 * Whether a resource object may leave a relationship out of its
 * `relationships` member: under `linkage: "whenIncluded"` or `"optional"`.
 *
 * @since 0.23.0
 * @category type-level
 */
export type MayOmit<D extends Descriptor> = D["linkage"] extends "always" | "never" ? false : true;

/**
 * The fields of a resource object's `relationships` member: each
 * relationship's wire schema, an optional key when {@link MayOmit}.
 *
 * @since 0.23.0
 * @category type-level
 */
export type RelationshipFields<Rels extends Relationships> = {
  readonly [K in keyof Rels]: MayOmit<Rels[K]> extends true
    ? Schema.optionalKey<SchemaFor<Rels[K]>>
    : SchemaFor<Rels[K]>;
};

/**
 * Creates the fields of a resource object's `relationships` member (see
 * {@link RelationshipFields}).
 *
 * @since 0.23.0
 * @category constructors
 */
export const makeRelationshipFields = <Rels extends Relationships>(
  rels: Rels,
): RelationshipFields<Rels> =>
  R.map(rels, (descriptor) =>
    descriptor.linkage === "always" || descriptor.linkage === "never"
      ? schemaFor(descriptor)
      : Schema.optionalKey(schemaFor(descriptor)),
  ) as RelationshipFields<Rels>;
