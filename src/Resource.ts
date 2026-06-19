/**
 * JSON:API resource definitions — the single source of truth.
 *
 * A {@link Resource} definition captures a resource's type name, attributes,
 * relationships and meta *once*; everything else is derived from it:
 *
 *   - the resource object schema (the definition *is* a `Schema.Struct`)
 *   - `Id` — the branded id schema (ids can't be mixed across resource types)
 *   - `identifier` — the `{ type, id }` resource-identifier schema
 *   - `localIdentifier` — the `{ type, lid }` schema for resources the client
 *     is creating (no server-assigned id yet); `lidRef(lid)` makes values
 *   - `createPayload` — `{ data: { type, lid?, attributes, relationships } }`
 *     (required `one` relationships must be present)
 *   - `updatePayload` — `{ data: { type, id, attributes? (partial), relationships? } }`
 *   - `document(...)` / `collection(...)` — top-level document schemas whose
 *     `included` union is derived from the relationship graph
 *
 * Relationships are declared with the `Relationship` module's constructors
 * (`Relationship.one(() => Person)`, `Relationship.many(() => Comment)`, …) and
 * reference other resource definitions through lazy thunks, so a typo'd
 * reference is a compile error and the relationship graph can be walked at
 * runtime.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: {
 *     firstName: Schema.NonEmptyString,
 *     lastName: Schema.NonEmptyString
 *   }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person)
 *   }
 * })
 * ```
 *
 * @since 0.1.0
 */
import { Schema, Struct } from "effect"
import { AnyMeta, CollectionDocument, DataDocument, ResourceLinks } from "./Document.js"
import * as Relationship from "./Relationship.js"
import type { Relationships, RelationshipSchemas } from "./Relationship.js"

// The relationship descriptor types (`Descriptor`, `Relationships`,
// `RelationshipSchemas`) are part of the public API under the `Relationship`
// namespace (`Relationship.Descriptor`, …); they are not re-exported at
// the top level to avoid duplicate documentation entries.

// ---------------------------------------------------------------------------
// Id / identifier schemas
// ---------------------------------------------------------------------------

/**
 * The branded id schema for a resource type: `string & Brand<"<type>Id">`.
 *
 * Branding the id by resource type means ids cannot be accidentally mixed
 * across resource types at the type level.
 *
 * @since 0.1.0
 * @category models
 */
export interface Id<Type extends string> extends Schema.brand<Schema.String, `${Type}Id`> {}

/**
 * Creates the branded id schema for a resource type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 *
 * const personId = Person.Id.make("9") // branded with "peopleId"
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Id = <const Type extends string>(type: Type): Id<Type> =>
  Schema.String.pipe(Schema.brand(`${type}Id` as `${Type}Id`))

/**
 * The resource-identifier schema for a resource type: `{ type, id, meta? }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface Identifier<Type extends string> extends Schema.Struct<{
  readonly type: Schema.tag<Type>
  readonly id: Id<Type>
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * Creates the resource-identifier schema for a resource type.
 *
 * Useful standalone — e.g. to validate a `{ type, id }` linkage independently
 * of any resource definition.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const PersonIdentifier = Resource.Identifier("people")
 * const decoded = Schema.decodeUnknownSync(PersonIdentifier)({ type: "people", id: "9" })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const Identifier = <const Type extends string>(type: Type): Identifier<Type> =>
  Schema.Struct({
    type: Schema.tag(type),
    id: Id(type),
    meta: Schema.optionalKey(AnyMeta)
  })

/**
 * The local-identifier schema for a resource type: `{ type, lid, meta? }`.
 *
 * A local identifier (JSON:API v1.1 `lid`) identifies a resource the client is
 * creating, before the server has assigned it an `id` — in creation payloads
 * and in atomic operations, where later operations can reference resources
 * created by earlier ones.
 *
 * @see {@link https://jsonapi.org/format/1.1/#document-resource-object-identification}
 *
 * @since 0.1.0
 * @category models
 */
export interface LocalIdentifier<Type extends string> extends Schema.Struct<{
  readonly type: Schema.tag<Type>
  readonly lid: Schema.String
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * Creates the local-identifier schema for a resource type.
 *
 * @since 0.1.0
 * @category constructors
 */
export const LocalIdentifier = <const Type extends string>(type: Type): LocalIdentifier<Type> =>
  Schema.Struct({
    type: Schema.tag(type),
    lid: Schema.String,
    meta: Schema.optionalKey(AnyMeta)
  })

/**
 * A ref to a resource: either its `{ type, id }` identifier or — for resources
 * that don't have a server-assigned id yet — its `{ type, lid }` local
 * identifier.
 *
 * @since 0.1.0
 * @category models
 */
export interface Ref<R extends Any> extends Schema.Union<
  readonly [Schema.suspend<R["identifier"]>, Schema.suspend<LocalIdentifier<R["type"]>>]
> {}

/**
 * Creates the ref schema for a resource: identifier or local identifier.
 *
 * Accepts the resource definition or a thunk, so refs can be built lazily from
 * relationship descriptors.
 *
 * @since 0.1.0
 * @category constructors
 */
export const Ref = <R extends Any>(resource: R | (() => R)): Ref<R> => {
  const thunk = typeof resource === "function" ? resource : () => resource
  return Schema.Union([
    Schema.suspend(() => thunk().identifier as R["identifier"]),
    Schema.suspend(() => LocalIdentifier(thunk().type) as LocalIdentifier<R["type"]>)
  ])
}

/**
 * A ref *value*: an id-based identifier or a lid-based local identifier.
 *
 * @since 0.1.0
 * @category models
 */
export type RefValue = { readonly type: string; readonly id: string } | { readonly type: string; readonly lid: string }

// ---------------------------------------------------------------------------
// The resource definition
// ---------------------------------------------------------------------------

/**
 * The field map of a resource object schema.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResourceFields<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top
> = {
  readonly type: Schema.tag<Type>
  readonly id: Id<Type>
  readonly attributes: Schema.Struct<Attributes>
  readonly relationships: Schema.optionalKey<Schema.Struct<RelationshipSchemas<Rels>>>
  readonly links: Schema.optionalKey<typeof ResourceLinks>
  readonly meta: Schema.optionalKey<Meta>
}

/**
 * The union of resource definitions referenced by a relationship record —
 * every relationship's target, regardless of kind.
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelationshipTargets<Rels extends Relationships> = {
  [K in keyof Rels]: Rels[K] extends { readonly ref: () => infer R extends Any } ? R : never
}[keyof Rels]

/**
 * The union of resource definitions that can appear in a compound document's
 * `included` member: the targets of every relationship *except* `paginated`
 * ones (whose data is never inlined).
 *
 * @since 0.1.0
 * @category type-level
 */
export type IncludableTargets<Rels extends Relationships> = {
  [K in keyof Rels]: Rels[K] extends Relationship.Paginated<Any>
    ? never
    : Rels[K] extends { readonly ref: () => infer R extends Any }
      ? R
      : never
}[keyof Rels]

// Resolves to `T` for every concrete relationship record; needed because the
// conditional mapped types below can't be proven to satisfy `Struct.Fields`
// while `Rels` is still generic.
type AsFields<T> = T extends Schema.Struct.Fields ? T : never

/**
 * Whether a relationship record contains at least one required (`one`)
 * relationship — in which case the create payload's `relationships` member is
 * itself required.
 *
 * @since 0.1.0
 * @category type-level
 */
export type HasRequiredRelationship<Rels extends Relationships> = {
  [K in keyof Rels]: Rels[K] extends Relationship.One<Any> ? true : never
}[keyof Rels] extends never
  ? false
  : true

/**
 * The relationship fields of a create payload:
 *
 *   - `one` relationships are **required** (the resource cannot exist without them)
 *   - `optional` / `many` relationships are optional
 *   - `paginated` relationships are excluded — unbounded collections are
 *     managed through relationship endpoints, not create payloads
 *
 * @since 0.1.0
 * @category type-level
 */
export type CreateRelationshipFields<Rels extends Relationships> = {
  readonly [K in keyof Rels as Rels[K] extends Relationship.Paginated<Any>
    ? never
    : K]: Rels[K] extends Relationship.One<Any>
    ? RelationshipSchemas<Rels>[K]
    : Schema.optionalKey<RelationshipSchemas<Rels>[K]>
}

/**
 * The `relationships` member of a create payload: a required key when the
 * resource has required (`one`) relationships, optional otherwise.
 *
 * @since 0.1.0
 * @category type-level
 */
export type CreateRelationshipsMember<Rels extends Relationships> =
  HasRequiredRelationship<Rels> extends true
    ? Schema.Struct<AsFields<CreateRelationshipFields<Rels>>>
    : Schema.optionalKey<Schema.Struct<AsFields<CreateRelationshipFields<Rels>>>>

/**
 * The relationship fields of an update payload: every non-`paginated`
 * relationship, each optional (PATCH semantics — omitted means unchanged).
 *
 * @since 0.1.0
 * @category type-level
 */
export type UpdateRelationshipFields<Rels extends Relationships> = {
  readonly [K in keyof Rels as Rels[K] extends Relationship.Paginated<Any> ? never : K]: Schema.optionalKey<
    RelationshipSchemas<Rels>[K]
  >
}

/**
 * The request body schema for creating a resource: the client supplies
 * attributes (and relationships and optionally a local id `lid`) but never a
 * server-assigned `id`.
 *
 * Required (`one`) relationships must be present; `paginated` relationships
 * cannot appear.
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-creating}
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * // { data: { type: "articles", lid?, attributes, relationships? } }
 * const CreateArticle = Article.createPayload
 * ```
 *
 * @since 0.1.0
 * @category models
 */
export interface CreatePayload<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships
> extends Schema.Struct<{
  readonly data: Schema.Struct<{
    readonly type: Schema.tag<Type>
    readonly lid: Schema.optionalKey<Schema.String>
    readonly attributes: Schema.Struct<Attributes>
    readonly relationships: CreateRelationshipsMember<Rels>
  }>
}> {}

/**
 * The partial attributes of an update payload.
 *
 * @since 0.1.0
 * @category type-level
 */
export type PartialAttributes<Attributes extends Schema.Struct.Fields> = {
  readonly [K in keyof Attributes]: Schema.optionalKey<Attributes[K]>
}

/**
 * The request body schema for updating a resource: `id` is mandatory,
 * attributes and relationships are partial. `paginated` relationships cannot
 * appear (use relationship endpoints).
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating}
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 *
 * // { data: { type: "articles", id, attributes?, relationships? } }
 * const UpdateArticle = Article.updatePayload
 * ```
 *
 * @since 0.1.0
 * @category models
 */
export interface UpdatePayload<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships
> extends Schema.Struct<{
  readonly data: Schema.Struct<{
    readonly type: Schema.tag<Type>
    readonly id: Id<Type>
    readonly attributes: Schema.optionalKey<Schema.Struct<PartialAttributes<Attributes>>>
    readonly relationships: Schema.optionalKey<Schema.Struct<AsFields<UpdateRelationshipFields<Rels>>>>
  }>
}> {}

/**
 * The default `included` union for a resource's compound documents: the
 * resource definitions referenced by its non-`paginated` relationships.
 *
 * @since 0.1.0
 * @category models
 */
export interface DefaultIncluded<Rels extends Relationships> extends Schema.Union<
  ReadonlyArray<IncludableTargets<Rels>>
> {}

/**
 * A JSON:API resource definition: the resource object `Schema.Struct` itself,
 * augmented with every schema derived from it.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 *
 * // Everything is derived from the definition:
 * Person.Id            // branded id schema
 * Person.identifier    // { type, id } schema
 * Person.createPayload // create request body schema
 * Person.document()    // single-resource document schema
 * ```
 *
 * @since 0.1.0
 * @category models
 */
export interface Resource<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships = {},
  Meta extends Schema.Top = typeof AnyMeta
> extends Schema.Struct<ResourceFields<Type, Attributes, Rels, Meta>> {
  /** The resource type name. */
  readonly type: Type
  /** The branded id schema for this resource type. */
  readonly Id: Id<Type>
  /** The `{ type, id }` resource-identifier schema. */
  readonly identifier: Identifier<Type>
  /** The `{ type, lid }` local-identifier schema (for resources not yet assigned an id). */
  readonly localIdentifier: LocalIdentifier<Type>
  /** The relationship descriptors, as declared. */
  readonly relationships: Rels
  /** Request body schema for creating this resource (no `id`, optional `lid`, required `one` relationships). */
  readonly createPayload: CreatePayload<Type, Attributes, Rels>
  /** Request body schema for updating this resource (`id` required, attributes partial). */
  readonly updatePayload: UpdatePayload<Type, Attributes, Rels>
  /**
   * Creates a typed resource-identifier value (a "ref"): `{ type, id }` with
   * this resource's type tag and branded id.
   *
   * ```ts
   * Article.ref("1")   // { type: "articles", id: "1" } — id is branded
   * // handy for relationship linkage:
   * relationships: { author: { data: Person.ref("9") } }
   * ```
   */
  ref(id: string): Identifier<Type>["Type"]
  /**
   * Creates a typed local-identifier value: `{ type, lid }` with this
   * resource's type tag — the counterpart of {@link ref} for resources that
   * don't have a server-assigned id yet (creation payloads, atomic
   * operations).
   *
   * ```ts
   * Article.lidRef("a1")   // { type: "articles", lid: "a1" }
   * ```
   */
  lidRef(lid: string): LocalIdentifier<Type>["Type"]
  /**
   * Single-resource document schema. The compound `included` union defaults to
   * the resources referenced by this resource's non-`paginated` relationships;
   * override it (or the document `meta`) per call.
   */
  document<Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(options?: {
    readonly included?: Included
    readonly meta?: M
  }): DataDocument<Resource<Type, Attributes, Rels, Meta>, Included, M>
  /**
   * Collection document schema (strict array `data`). Same defaults as
   * {@link document}.
   */
  collection<Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(options?: {
    readonly included?: Included
    readonly meta?: M
  }): CollectionDocument<Resource<Type, Attributes, Rels, Meta>, Included, M>
}

/**
 * The structural interface every {@link Resource} definition satisfies.
 * Use as the constraint when accepting "any resource definition".
 *
 * @since 0.1.0
 * @category models
 */
export interface Any extends Schema.Top {
  readonly type: string
  readonly Id: Schema.Top
  readonly identifier: Schema.Top
  readonly relationships: Relationships
  readonly fields: {
    readonly attributes: Schema.Top & { readonly fields: Schema.Struct.Fields }
  }
}

/**
 * The attribute keys of a resource definition, as a union of string literals.
 *
 * Distributes over unions of resource definitions (the keys of *any* member),
 * so it also serves heterogeneous endpoints.
 *
 * @since 0.1.0
 * @category type-level
 */
export type AttributeKeys<R extends Any> = R extends Any ? keyof R["fields"]["attributes"]["fields"] & string : never

// ---------------------------------------------------------------------------
// Relationship names & targets (type level)
// ---------------------------------------------------------------------------

/**
 * The relationship keys of a resource definition, as a union of string
 * literals.
 *
 * @since 0.1.0
 * @category type-level
 */
export type RelationshipName<R extends Any> = keyof R["relationships"] & string

/**
 * The to-one (`one` / `optional`) relationship keys of a resource definition.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ToOneName<R extends Any> = {
  [K in keyof R["relationships"]]: R["relationships"][K] extends Relationship.ToOne<Any> ? K : never
}[keyof R["relationships"]] &
  string

/**
 * The to-many (`many` / `paginated`) relationship keys of a resource
 * definition.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ToManyName<R extends Any> = {
  [K in keyof R["relationships"]]: R["relationships"][K] extends Relationship.ToMany<Any> ? K : never
}[keyof R["relationships"]] &
  string

/**
 * The resource definition a relationship key points at.
 *
 * @since 0.1.0
 * @category type-level
 */
export type Target<R extends Any, K> = R["relationships"][K & keyof R["relationships"]] extends {
  readonly ref: () => infer T
}
  ? T extends Any
    ? T
    : never
  : never

/**
 * The resource definitions referenced by a resource's relationships.
 *
 * Distributes over unions of resource definitions.
 *
 * @since 0.1.0
 * @category type-level
 */
export type TargetsOf<R extends Any> = R extends Any ? RelationshipTargets<R["relationships"]> : never

// ---------------------------------------------------------------------------
// Include paths (type level)
// ---------------------------------------------------------------------------

/**
 * The relationship keys of a resource that can appear in `?include=` paths —
 * every key except `paginated` relationships, whose data is never inlined.
 *
 * @since 0.1.0
 * @category type-level
 */
export type IncludableKeys<R extends Any> = {
  [K in keyof R["relationships"]]: R["relationships"][K] extends Relationship.Paginated<Any> ? never : K
}[keyof R["relationships"]] &
  string

/**
 * The legal `include` query parameter paths for a resource, as a union of
 * string literals — every non-`paginated` relationship key, plus dotted paths
 * one further hop into the graph (e.g. `"author" | "comments" | "comments.author"`).
 *
 * Mirrors {@link includePaths} (the runtime walk) at depth 2, and distributes
 * over unions of resource definitions.
 *
 * @since 0.1.0
 * @category type-level
 */
export type IncludePath<R extends Any> = R extends Any
  ? {
      [K in IncludableKeys<R>]: K | `${K}.${IncludableKeys<Target<R, K>>}`
    }[IncludableKeys<R>]
  : never

/**
 * The resource definitions brought into a compound document by one include
 * path. Dotted paths include the intermediate resources as well as the leaf,
 * per the spec.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResolveIncludePath<R extends Any, Path> = Path extends `${infer Head}.${infer Rest}`
  ? Target<R, Head> | ResolveIncludePath<Target<R, Head>, Rest>
  : Target<R, Path>

/**
 * The union of resource definitions brought into a compound document by a set
 * of requested include paths.
 *
 * Per the spec, a server "MUST NOT include unrequested resource objects", so
 * this is exactly the `included` member union of a compliant response.
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-includes}
 *
 * @since 0.1.0
 * @category type-level
 */
export type IncludedFor<R extends Any, Paths extends ReadonlyArray<string>> = ResolveIncludePath<R, Paths[number]>

// ---------------------------------------------------------------------------
// Runtime graph walking
// ---------------------------------------------------------------------------

/**
 * The attribute keys of a resource definition, at runtime.
 *
 * @since 0.1.0
 * @category accessors
 */
export const attributeKeys = <R extends Any>(resource: R): ReadonlyArray<AttributeKeys<R>> =>
  Object.keys(resource.fields.attributes.fields) as unknown as ReadonlyArray<AttributeKeys<R>>

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * Resource definitions referenced by `resource`'s non-`paginated`
 * relationships — the ones whose data can appear inline (and therefore in
 * compound documents).
 *
 * @since 0.1.0
 * @category accessors
 */
export const directTargets = (resource: Any): ReadonlyArray<Any> =>
  dedupe(
    Object.values(resource.relationships)
      .filter(Relationship.isLinkable)
      .map((descriptor) => descriptor.ref())
  )

/**
 * Resource definitions referenced by *all* of `resource`'s relationships,
 * including `paginated` ones — e.g. for sparse-fieldset configuration, where
 * a paginated relationship's target is still addressable.
 *
 * @since 0.1.0
 * @category accessors
 */
export const allTargets = (resource: Any): ReadonlyArray<Any> =>
  dedupe(Object.values(resource.relationships).map((descriptor) => descriptor.ref()))

/**
 * The legal `include` query parameter paths for a resource: every
 * non-`paginated` relationship path reachable from it, as dot-separated keys,
 * up to `maxDepth` hops.
 *
 * Cycles in the relationship graph are handled by the depth limit.
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-includes}
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * Resource.includePaths(Article) // ["author"]
 * ```
 *
 * @since 0.1.0
 * @category accessors
 */
export const includePaths = (resource: Any, maxDepth: number = 3): ReadonlyArray<string> => {
  const paths: Array<string> = []
  const visit = (current: Any, prefix: string, depth: number): void => {
    if (depth > maxDepth) return
    for (const [key, descriptor] of Object.entries(current.relationships)) {
      if (descriptor.kind === "paginated") continue
      const path = prefix === "" ? key : `${prefix}.${key}`
      paths.push(path)
      visit(descriptor.ref(), path, depth + 1)
    }
  }
  visit(resource, "", 1)
  return paths
}

// ---------------------------------------------------------------------------
// The Resource constructor
// ---------------------------------------------------------------------------

/**
 * Defines a JSON:API resource — the single source of truth from which the
 * resource object schema, identifier, payloads and documents are derived.
 *
 * The returned value *is* the resource object `Schema.Struct`, augmented with
 * the derived members.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: {
 *     firstName: Schema.NonEmptyString,
 *     lastName: Schema.NonEmptyString
 *   }
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.paginated(() => Person)
 *   }
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = <
  const Type extends string,
  const Attributes extends Schema.Struct.Fields,
  const Rels extends Relationships = {},
  Meta extends Schema.Top = typeof AnyMeta
>(
  type: Type,
  options: {
    readonly attributes: Attributes
    readonly relationships?: Rels
    readonly meta?: Meta
  }
): Resource<Type, Attributes, Rels, Meta> => {
  const relationships = (options.relationships ?? {}) as Rels
  const meta = (options.meta ?? AnyMeta) as Meta
  const id = Id(type)
  const identifier = Identifier(type)
  const localIdentifier = LocalIdentifier(type)
  const relationshipSchemas = Relationship.makeRelationshipSchemas(relationships)
  const schemaByKey = relationshipSchemas as Record<string, Schema.Top>
  const attributes = Schema.Struct(options.attributes)
  const relationshipsStruct = Schema.Struct(relationshipSchemas)

  const fields: ResourceFields<Type, Attributes, Rels, Meta> = {
    type: Schema.tag(type),
    id,
    attributes,
    relationships: Schema.optionalKey(relationshipsStruct),
    links: Schema.optionalKey(ResourceLinks),
    meta: Schema.optionalKey(meta)
  }

  const struct = Schema.Struct(fields)

  // Create payload relationships: `one` required, `optional`/`many` optional,
  // `paginated` excluded. The member itself is required iff a `one` exists.
  const createRelationshipFields: Record<string, Schema.Top> = {}
  let hasRequiredRelationship = false
  for (const [key, descriptor] of Object.entries(relationships)) {
    if (descriptor.kind === "paginated") continue
    if (descriptor.kind === "one") {
      hasRequiredRelationship = true
      createRelationshipFields[key] = schemaByKey[key]!
    } else {
      createRelationshipFields[key] = Schema.optionalKey(schemaByKey[key]!)
    }
  }
  const createRelationshipsStruct = Schema.Struct(createRelationshipFields)

  const createPayload = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      lid: Schema.optionalKey(Schema.String),
      attributes,
      relationships: hasRequiredRelationship ? createRelationshipsStruct : Schema.optionalKey(createRelationshipsStruct)
    })
  }) as unknown as CreatePayload<Type, Attributes, Rels>

  // Update payload relationships: every non-`paginated` relationship, optional.
  const updateRelationshipFields: Record<string, Schema.Top> = {}
  for (const [key, descriptor] of Object.entries(relationships)) {
    if (descriptor.kind === "paginated") continue
    updateRelationshipFields[key] = Schema.optionalKey(schemaByKey[key]!)
  }

  const updatePayload = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      id,
      attributes: Schema.optionalKey(
        Schema.Struct(Struct.map(Schema.optionalKey)(options.attributes) as PartialAttributes<Attributes>)
      ),
      relationships: Schema.optionalKey(Schema.Struct(updateRelationshipFields))
    })
  }) as unknown as UpdatePayload<Type, Attributes, Rels>

  // The default `included` union: resources referenced by non-`paginated`
  // relationships. Built lazily so out-of-order / mutually recursive
  // definitions resolve.
  const includedUnion = (): DefaultIncluded<Rels> =>
    // The cast is sound: every linkable descriptor's target is, by construction
    // of `Rels`, a member of `IncludableTargets<Rels>`.
    Schema.Union(
      dedupe(
        Object.values(relationships)
          .filter(Relationship.isLinkable)
          .map((descriptor) => descriptor.ref())
      )
    ) as unknown as DefaultIncluded<Rels>

  const resource: Resource<Type, Attributes, Rels, Meta> = Object.assign(struct, {
    type,
    Id: id,
    identifier,
    localIdentifier,
    relationships,
    createPayload,
    updatePayload,
    ref: (refId: string) => identifier.make({ id: id.make(refId) }),
    lidRef: (lid: string) => localIdentifier.make({ lid }),
    document: <Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(opts?: {
      readonly included?: Included
      readonly meta?: M
    }) =>
      DataDocument(resource, {
        included: (opts?.included ?? includedUnion()) as Included,
        meta: (opts?.meta ?? meta) as M
      }),
    collection: <Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(opts?: {
      readonly included?: Included
      readonly meta?: M
    }) =>
      CollectionDocument(resource, {
        included: (opts?.included ?? includedUnion()) as Included,
        meta: (opts?.meta ?? meta) as M
      })
  })

  return resource
}
