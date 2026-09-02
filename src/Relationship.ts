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
import type { Any } from "./Resource.js"

// ---------------------------------------------------------------------------
// Descriptors
// ---------------------------------------------------------------------------

/**
 * The filter operators a to-one relationship may declare: equality and list
 * membership against the related resource's id, plus the null test. Ordering
 * operators make no sense for an id, so `lt` / `lte` / `gt` / `gte` are
 * excluded; declaring one is a definition-time error in `Resource.make`.
 *
 * @since 0.13.0
 * @category constants
 */
export const filterOperators = ["eq", "ne", "in", "nin", "isnull"] as const

/**
 * A filter operator a to-one relationship may declare — one of
 * {@link filterOperators}.
 *
 * @since 0.13.0
 * @category models
 */
export type FilterOperator = (typeof filterOperators)[number]

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
 * An unbounded to-many relationship with *no* inline linkage: the relationship
 * object carries only a required `related` link pointing at a paginated
 * collection endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface Paginated<R extends Any> {
  readonly kind: "paginated"
  readonly ref: () => R
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
 * @example
 * ```ts
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 * import { Schema } from "effect"
 *
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { comments: Relationship.paginated(() => Comment) }
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const paginated = <R extends Any>(ref: () => R): Paginated<R> => ({ kind: "paginated", ref })

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
