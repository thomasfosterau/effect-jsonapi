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
 * ```ts
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
 * declaration order.
 *
 * A target may also be a `Resource.family(...)` supertype, not just a single
 * resource — linkage then decodes for any member of the family (keyed on the
 * member `type` tag), since a family structurally satisfies `Resource.Any`.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"
import { AnyMeta, PaginatedRelationshipLinks, RelationshipLinks } from "./Document.js"
import type { Operator } from "./Filter.js"
import type { Any, AttributeKeys } from "./Resource.js"
import type * as Sort from "./Sort.js"

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
  "isnull"
] as const satisfies ReadonlyArray<Operator>)

/**
 * A filter operator a to-one relationship may declare — the decoded type of
 * the {@link FilterOperator} schema, a subset of `Filter.Operator`.
 *
 * @since 0.13.0
 * @category models
 */
export type FilterOperator = typeof FilterOperator.Type

/**
 * Every relationship filter operator, in order — the literals of the
 * {@link FilterOperator} schema.
 *
 * @since 0.13.0
 * @category constants
 */
export const filterOperators: typeof FilterOperator.literals = FilterOperator.literals

/**
 * How a to-one relationship is declared filterable (`Relationship.one(ref, { filter })`):
 * `true` (every operator in {@link filterOperators}), a subset of them, or
 * `false` (the default) — not filterable.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterDeclaration = boolean | ReadonlyArray<FilterOperator>

/**
 * A required to-one relationship: linkage is always a single resource
 * identifier, never `null`. `F` records its `filter` declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface One<R extends Any, F extends FilterDeclaration = FilterDeclaration> {
  readonly kind: "one"
  readonly ref: () => R
  readonly filter: F
}

/**
 * An optional (nullable) to-one relationship: linkage is a single resource
 * identifier or `null`. `F` records its `filter` declaration.
 *
 * @since 0.1.0
 * @category models
 */
export interface Optional<R extends Any, F extends FilterDeclaration = FilterDeclaration> {
  readonly kind: "optional"
  readonly ref: () => R
  readonly filter: F
}

/**
 * A to-many relationship with inline linkage: an array of resource
 * identifiers (possibly empty).
 *
 * @since 0.1.0
 * @category models
 */
export interface Many<R extends Any> {
  readonly kind: "many"
  readonly ref: () => R
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
export type Order<R extends Any> = ReadonlyArray<Sort.Term<AttributeKeys<R> | "id">>

/**
 * An unbounded to-many relationship with *no* inline linkage: the relationship
 * object carries only a required `related` link pointing at a paginated
 * collection endpoint. `O` records its declared canonical {@link Order}
 * (`undefined` when none is declared).
 *
 * @since 0.1.0
 * @category models
 */
export interface Paginated<R extends Any, O extends Order<R> | undefined = Order<R> | undefined> {
  readonly kind: "paginated"
  readonly ref: () => R
  /**
   * The declared canonical {@link Order} of the related collection, or
   * `undefined` when the relationship declares none.
   *
   * @since 0.15.0
   */
  readonly order: O
}

/**
 * Any relationship descriptor.
 *
 * @since 0.1.0
 * @category models
 */
export type Descriptor = One<Any> | Optional<Any> | Many<Any> | Paginated<Any>

/**
 * A record of relationship descriptors, as written in a resource definition.
 *
 * @since 0.1.0
 * @category models
 */
export type Relationships = { readonly [key: string]: Descriptor }

/**
 * The to-one descriptors: linkage is a single identifier (nullable or not).
 *
 * @since 0.1.0
 * @category models
 */
export type ToOne<R extends Any> = One<R> | Optional<R>

/**
 * The to-many (collection-valued) descriptors.
 *
 * @since 0.1.0
 * @category models
 */
export type ToMany<R extends Any> = Many<R> | Paginated<R>

/**
 * The descriptors that carry inline `data` linkage — everything except
 * `paginated`.
 *
 * @since 0.1.0
 * @category models
 */
export type Linkable<R extends Any> = One<R> | Optional<R> | Many<R>

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

/**
 * Declares a required to-one relationship: `data` is always a resource
 * identifier, never `null`. Required in create payloads.
 *
 * The reference is a thunk so resources can reference each other regardless of
 * declaration order (mutually recursive definitions may require an explicit
 * type annotation on one side).
 *
 * Pass `filter` to make the relationship a filterable field of its resource
 * (`?filter[author]=9`), valued by the related resource's id: `true` admits
 * every operator in {@link filterOperators}, an array admits that subset. The
 * declaration is read by `Resource.filterable`; the literal codec is the
 * target's `Id` schema, resolved lazily.
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
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person, { filter: ["eq", "in"] }) }
 * })
 *
 * Resource.filterable(Article).author.operators // ["eq", "in"]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
// `NoInfer` keeps `F` from being inferred off the *contextual* return type
// (`Relationships` widens it to the whole `FilterDeclaration` inside a
// `Resource.make` call); it is inferred from `options.filter` alone, and
// defaults to `false`.
export const one = <R extends Any, const F extends FilterDeclaration = false>(
  ref: () => R,
  options?: { readonly filter?: F }
): One<R, NoInfer<F>> => ({ kind: "one", ref, filter: (options?.filter ?? false) as F })

/**
 * Declares an optional (nullable) to-one relationship: `data` is a resource
 * identifier or `null`.
 *
 * Takes the same `filter` option as {@link one}; `isnull` is the natural
 * operator here (`?filter[assignee][isnull]=true`).
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
export const optional = <R extends Any, const F extends FilterDeclaration = false>(
  ref: () => R,
  options?: { readonly filter?: F }
): Optional<R, NoInfer<F>> => ({ kind: "optional", ref, filter: (options?.filter ?? false) as F })

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
export const many = <R extends Any>(ref: () => R): Many<R> => ({ kind: "many", ref })

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
 * `Resource.relationships(Article).comments.order`. Each term names an attribute
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
 * // [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "asc" }]
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
// `NoInfer` keeps `O` from being inferred off the *contextual* return type (the
// `Relationships` record of a `Resource.make` call widens it); it is inferred
// from `options.order` alone, and defaults to `undefined` — no declared order.
export const paginated = <R extends Any, const O extends Order<R> | undefined = undefined>(
  ref: () => R,
  options?: { readonly order?: O }
): Paginated<R, NoInfer<O>> => {
  const order = options?.order
  if (order !== undefined) {
    if (order.length === 0) {
      throw new Error("Relationship.paginated: `order` declares no terms; name at least one, or omit the option")
    }
    const seen = new Set<string>()
    for (const term of order) {
      if (seen.has(term.field)) {
        throw new Error(
          `Relationship.paginated: \`order\` names "${term.field}" more than once; each term must order by a distinct field`
        )
      }
      seen.add(term.field)
    }
  }
  return { kind: "paginated", ref, order: order as NoInfer<O> }
}

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
export const isLinkable = (descriptor: Descriptor): descriptor is Linkable<Any> => descriptor.kind !== "paginated"

/**
 * Whether a descriptor is to-one (`one` or `optional`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const isToOne = (descriptor: Descriptor): descriptor is ToOne<Any> =>
  descriptor.kind === "one" || descriptor.kind === "optional"

/**
 * Whether a descriptor is to-many (`many` or `paginated`).
 *
 * @since 0.1.0
 * @category accessors
 */
export const isToMany = (descriptor: Descriptor): descriptor is ToMany<Any> =>
  descriptor.kind === "many" || descriptor.kind === "paginated"

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
export interface OneSchema<R extends Any> extends Schema.Struct<{
  readonly data: Schema.suspend<R["identifier"]>
  readonly links: Schema.optionalKey<typeof RelationshipLinks>
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * The wire schema of an optional to-one relationship:
 * `{ data: identifier | null, links?, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface OptionalSchema<R extends Any> extends Schema.Struct<{
  readonly data: Schema.NullOr<Schema.suspend<R["identifier"]>>
  readonly links: Schema.optionalKey<typeof RelationshipLinks>
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * The wire schema of an inline to-many relationship:
 * `{ data: identifier[], links?, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ManySchema<R extends Any> extends Schema.Struct<{
  readonly data: Schema.$Array<Schema.suspend<R["identifier"]>>
  readonly links: Schema.optionalKey<typeof RelationshipLinks>
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * The wire schema of a paginated to-many relationship: *no* `data`; `links`
 * (with a required `related` member) is mandatory.
 *
 * @since 0.1.0
 * @category models
 */
export interface PaginatedSchema extends Schema.Struct<{
  readonly links: typeof PaginatedRelationshipLinks
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

const makeOneSchema = <R extends Any>(descriptor: One<R>): OneSchema<R> =>
  Schema.Struct({
    data: Schema.suspend(() => descriptor.ref().identifier as R["identifier"]),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(AnyMeta)
  })

const makeOptionalSchema = <R extends Any>(descriptor: Optional<R>): OptionalSchema<R> =>
  Schema.Struct({
    data: Schema.NullOr(Schema.suspend(() => descriptor.ref().identifier as R["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(AnyMeta)
  })

const makeManySchema = <R extends Any>(descriptor: Many<R>): ManySchema<R> =>
  Schema.Struct({
    data: Schema.Array(Schema.suspend(() => descriptor.ref().identifier as R["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(AnyMeta)
  })

const makePaginatedSchema = (_descriptor: Paginated<Any>): PaginatedSchema =>
  Schema.Struct({
    links: PaginatedRelationshipLinks,
    meta: Schema.optionalKey(AnyMeta)
  })

/**
 * The wire schema of a single relationship descriptor.
 *
 * @since 0.1.0
 * @category type-level
 */
export type SchemaFor<D extends Descriptor> =
  D extends One<infer R>
    ? OneSchema<R>
    : D extends Optional<infer R>
      ? OptionalSchema<R>
      : D extends Many<infer R>
        ? ManySchema<R>
        : D extends Paginated<Any>
          ? PaginatedSchema
          : never

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
        : makePaginatedSchema(descriptor)) as SchemaFor<D>

/**
 * Maps a record of relationship descriptors to their wire schemas.
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelationshipSchemas<Rels extends Relationships> = {
  readonly [K in keyof Rels]: SchemaFor<Rels[K]>
}

/**
 * Creates the wire schemas for a record of relationship descriptors.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeRelationshipSchemas = <Rels extends Relationships>(rels: Rels): RelationshipSchemas<Rels> =>
  Object.fromEntries(
    Object.entries(rels).map(([key, descriptor]) => [key, schemaFor(descriptor)])
  ) as RelationshipSchemas<Rels>
