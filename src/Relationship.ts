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
import { AnyMeta, PaginatedRelationshipLinks, RelationshipLinks } from "./Document.js";
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
}

/**
 * A to-many relationship with inline linkage: an array of resource
 * identifiers (possibly empty). `M` is the schema of its relationship
 * object's `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Many<Res extends Any, M extends Schema.Top = Schema.Top> {
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
> extends One<Res, F, K, M> {}

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
> extends Optional<Res, F, K, M> {}

/**
 * The type of `Relationship.many(ref)` — {@link Many}, named to read like the
 * declaration it annotates in a recursive resource definition.
 *
 * @since 0.15.0
 * @category type-level
 */
export interface many<Res extends Any, M extends Schema.Top = typeof AnyMeta> extends Many<
  Res,
  M
> {}

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
 * The descriptors that carry inline `data` linkage — everything except
 * `paginated`.
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
> extends MetaOptions<M> {
  /** Make the relationship a filterable field of its resource (see {@link one}). */
  readonly filter?: F;
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
>(
  ref: () => Res,
  options?: ToOneOptions<F, K, M>,
): One<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>> =>
  ({
    kind: "one",
    ref,
    filter: options?.filter ?? false,
    key: storageKey("Relationship.one", Option.fromUndefinedOr(options?.key)),
    meta: options?.meta ?? AnyMeta,
  }) as One<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>>;

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
>(
  ref: () => Res,
  options?: ToOneOptions<F, K, M>,
): Optional<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>> =>
  ({
    kind: "optional",
    ref,
    filter: options?.filter ?? false,
    key: storageKey("Relationship.optional", Option.fromUndefinedOr(options?.key)),
    meta: options?.meta ?? AnyMeta,
  }) as Optional<Res, NoInfer<F>, NoInfer<K>, NoInfer<M>>;

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
): Many<Res, NoInfer<M>> =>
  ({ kind: "many", ref, meta: options?.meta ?? AnyMeta }) as Many<Res, NoInfer<M>>;

/**
 * Declares an unbounded to-many relationship with no inline linkage: the
 * relationship object carries only a required `related` link pointing at a
 * paginated collection endpoint (see `Endpoint.related`).
 *
 * Paginated relationships are excluded from `?include=` paths, compound
 * `included` unions and create/update payloads — they are read and written
 * through their own endpoints.
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
  } as Paginated<Res, NoInfer<O>, NoInfer<M>>;
};

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * Whether a descriptor carries inline `data` linkage (everything except
 * `paginated`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const isLinkable = (descriptor: Descriptor): descriptor is Linkable<Any> =>
  descriptor.kind !== "paginated";

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

const makeOneSchema = <Res extends Any, M extends Schema.Top>(
  descriptor: One<Res, FilterDeclaration, StorageKey, M>,
): OneSchema<Res, M> =>
  Schema.Struct({
    data: Schema.suspend(() => descriptor.ref().identifier as Res["identifier"]),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(metaOf(descriptor)),
  });

const makeOptionalSchema = <Res extends Any, M extends Schema.Top>(
  descriptor: Optional<Res, FilterDeclaration, StorageKey, M>,
): OptionalSchema<Res, M> =>
  Schema.Struct({
    data: Schema.NullOr(Schema.suspend(() => descriptor.ref().identifier as Res["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(metaOf(descriptor)),
  });

const makeManySchema = <Res extends Any, M extends Schema.Top>(
  descriptor: Many<Res, M>,
): ManySchema<Res, M> =>
  Schema.Struct({
    data: Schema.Array(Schema.suspend(() => descriptor.ref().identifier as Res["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(metaOf(descriptor)),
  });

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
 * The wire schema of a single relationship descriptor.
 *
 * Selected by the descriptor's `kind` tag — a plain indexed access — rather
 * than by a chain of `D extends One<infer Res> ? …` conditionals. The two agree
 * on every descriptor, but only this one survives a **cyclic** resource graph:
 * matching `D` against `One<infer Res>` makes TypeScript relate the target
 * resource to the descriptor interfaces, and in an `Article` ⇄ `Comment`
 * cycle that relation re-enters the very mapped type it is computing
 * (`TS2615`).
 *
 * @since 0.1.0
 * @category type-level
 */
export type SchemaFor<D extends Descriptor> = {
  readonly one: OneSchema<TargetOf<D>, MetaOf<D>>;
  readonly optional: OptionalSchema<TargetOf<D>, MetaOf<D>>;
  readonly many: ManySchema<TargetOf<D>, MetaOf<D>>;
  readonly paginated: PaginatedSchema<MetaOf<D>>;
}[D["kind"]];

/**
 * The schema of a relationship descriptor's `meta` member: the one its
 * constructor's `meta` option declared, or `Document.AnyMeta`.
 *
 * @since 0.20.0
 * @category type-level
 */
export type MetaOf<D extends Descriptor> = D["meta"];

/**
 * Creates the wire schema for a relationship descriptor.
 *
 * @since 0.1.0
 * @category constructors
 */
export const schemaFor = <D extends Descriptor>(descriptor: D): SchemaFor<D> =>
  (descriptor.kind === "one"
    ? makeOneSchema(descriptor)
    : descriptor.kind === "optional"
      ? makeOptionalSchema(descriptor)
      : descriptor.kind === "many"
        ? makeManySchema(descriptor)
        : makePaginatedSchema(descriptor)) as SchemaFor<D>;

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
  R.fromEntries(
    R.toEntries(rels).map(([key, descriptor]) => [key, schemaFor(descriptor)]),
  ) as RelationshipSchemas<Rels>;
