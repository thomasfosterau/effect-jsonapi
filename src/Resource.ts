/**
 * JSON:API resource definitions — the single source of truth.
 *
 * A {@link Resource} definition captures a resource's type name, attributes,
 * relationships and meta *once*; everything else is derived from it:
 *
 *   - the resource object schema (the definition *is* a `Schema.Struct`)
 *   - `Id` — the branded id schema (ids can't be mixed across resource types)
 *   - `identifier` — the `{ type, id }` resource-identifier schema
 *   - `createPayload` — `{ data: { type, lid?, attributes, relationships? } }`
 *   - `updatePayload` — `{ data: { type, id, attributes? (partial), relationships? } }`
 *   - `document(...)` / `collection(...)` — top-level document schemas whose
 *     `included` union is derived from the relationship graph
 *
 * Relationships reference other resource definitions through lazy thunks
 * (`toOne(() => Person)`), so a typo'd reference is a compile error and the
 * relationship graph can be walked at runtime.
 */
import { Schema, Struct } from "effect"
import { AnyMeta, CollectionDocument, DataDocument, RelationshipLinks, ResourceLinks } from "./Document.js"

// ---------------------------------------------------------------------------
// Relationship descriptors
// ---------------------------------------------------------------------------

/**
 * A to-one relationship descriptor pointing at another resource definition.
 */
export interface ToOne<R extends Any> {
  readonly kind: "toOne"
  readonly ref: () => R
}

/**
 * A to-many relationship descriptor pointing at another resource definition.
 */
export interface ToMany<R extends Any> {
  readonly kind: "toMany"
  readonly ref: () => R
}

/**
 * Any relationship descriptor.
 */
export type Relationship = ToOne<Any> | ToMany<Any>

/**
 * A record of relationship descriptors, as written in a resource definition.
 */
export type Relationships = { readonly [key: string]: Relationship }

/**
 * Declares a to-one relationship to another resource definition.
 *
 * The reference is a thunk so resources can reference each other regardless of
 * declaration order (mutually recursive definitions may require an explicit
 * type annotation on one side).
 */
export const toOne = <R extends Any>(ref: () => R): ToOne<R> => ({ kind: "toOne", ref })

/**
 * Declares a to-many relationship to another resource definition.
 */
export const toMany = <R extends Any>(ref: () => R): ToMany<R> => ({ kind: "toMany", ref })

// ---------------------------------------------------------------------------
// Id / identifier schemas
// ---------------------------------------------------------------------------

/**
 * The branded id schema for a resource type: `string & Brand<"<type>Id">`.
 */
export interface Id<Type extends string> extends Schema.brand<Schema.String, `${Type}Id`> {}

/**
 * Creates the branded id schema for a resource type.
 */
export const Id = <const Type extends string>(type: Type): Id<Type> =>
  Schema.String.pipe(Schema.brand(`${type}Id` as `${Type}Id`))

/**
 * The resource-identifier schema for a resource type: `{ type, id, meta? }`.
 */
export interface Identifier<Type extends string> extends
  Schema.Struct<{
    readonly type: Schema.tag<Type>
    readonly id: Id<Type>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Creates the resource-identifier schema for a resource type.
 */
export const Identifier = <const Type extends string>(type: Type): Identifier<Type> =>
  Schema.Struct({
    type: Schema.tag(type),
    id: Id(type),
    meta: Schema.optionalKey(AnyMeta)
  })

// ---------------------------------------------------------------------------
// Relationship wire schemas (derived from descriptors)
// ---------------------------------------------------------------------------

/**
 * The wire schema of a to-one relationship: `{ data: identifier | null, links?, meta? }`.
 *
 * `data` is required — the strongest guarantee for the common "linkage is
 * always present" case, and it satisfies the spec's "a relationship object
 * holds at least one of data / links / meta" invariant by construction.
 */
export interface ToOneSchema<R extends Any> extends
  Schema.Struct<{
    readonly data: Schema.NullOr<Schema.suspend<R["identifier"]>>
    readonly links: Schema.optionalKey<typeof RelationshipLinks>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * The wire schema of a to-many relationship: `{ data: identifier[], links?, meta? }`.
 */
export interface ToManySchema<R extends Any> extends
  Schema.Struct<{
    readonly data: Schema.$Array<Schema.suspend<R["identifier"]>>
    readonly links: Schema.optionalKey<typeof RelationshipLinks>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

const makeToOneSchema = <R extends Any>(descriptor: ToOne<R>): ToOneSchema<R> =>
  Schema.Struct({
    data: Schema.NullOr(Schema.suspend(() => descriptor.ref().identifier as R["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(AnyMeta)
  })

const makeToManySchema = <R extends Any>(descriptor: ToMany<R>): ToManySchema<R> =>
  Schema.Struct({
    data: Schema.Array(Schema.suspend(() => descriptor.ref().identifier as R["identifier"])),
    links: Schema.optionalKey(RelationshipLinks),
    meta: Schema.optionalKey(AnyMeta)
  })

/**
 * Maps a record of relationship descriptors to their wire schemas.
 */
export type RelationshipSchemas<Rels extends Relationships> = {
  readonly [K in keyof Rels]: Rels[K] extends ToOne<infer R> ? ToOneSchema<R>
    : Rels[K] extends ToMany<infer R> ? ToManySchema<R>
    : never
}

const makeRelationshipSchemas = <Rels extends Relationships>(rels: Rels): RelationshipSchemas<Rels> =>
  Object.fromEntries(
    Object.entries(rels).map(([key, descriptor]) => [
      key,
      descriptor.kind === "toOne" ? makeToOneSchema(descriptor) : makeToManySchema(descriptor)
    ])
  ) as RelationshipSchemas<Rels>

// ---------------------------------------------------------------------------
// The resource definition
// ---------------------------------------------------------------------------

/**
 * The field map of a resource object schema.
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
 * The union of resource definitions directly referenced by a relationship
 * record — used as the default `included` member union for compound documents.
 */
export type RelationshipTargets<Rels extends Relationships> = {
  [K in keyof Rels]: Rels[K] extends ToOne<infer R> ? R : Rels[K] extends ToMany<infer R> ? R : never
}[keyof Rels]

/**
 * The request body schema for creating a resource: the client supplies
 * attributes (and optionally relationships and a local id `lid`) but never a
 * server-assigned `id`.
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-creating}
 */
export interface CreatePayload<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships
> extends
  Schema.Struct<{
    readonly data: Schema.Struct<{
      readonly type: Schema.tag<Type>
      readonly lid: Schema.optionalKey<Schema.String>
      readonly attributes: Schema.Struct<Attributes>
      readonly relationships: Schema.optionalKey<Schema.Struct<RelationshipSchemas<Rels>>>
    }>
  }>
{}

/**
 * The partial attributes of an update payload.
 */
export type PartialAttributes<Attributes extends Schema.Struct.Fields> = {
  readonly [K in keyof Attributes]: Schema.optionalKey<Attributes[K]>
}

/**
 * The request body schema for updating a resource: `id` is mandatory,
 * attributes and relationships are partial.
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating}
 */
export interface UpdatePayload<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships
> extends
  Schema.Struct<{
    readonly data: Schema.Struct<{
      readonly type: Schema.tag<Type>
      readonly id: Id<Type>
      readonly attributes: Schema.optionalKey<Schema.Struct<PartialAttributes<Attributes>>>
      readonly relationships: Schema.optionalKey<Schema.Struct<RelationshipSchemas<Rels>>>
    }>
  }>
{}

/**
 * The default `included` union for a resource's compound documents: the
 * resource definitions directly referenced by its relationships.
 */
export interface DefaultIncluded<Rels extends Relationships> extends
  Schema.Union<ReadonlyArray<RelationshipTargets<Rels>>>
{}

/**
 * A JSON:API resource definition: the resource object `Schema.Struct` itself,
 * augmented with every schema derived from it.
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
  /** The relationship descriptors, as declared. */
  readonly relationships: Rels
  /** Request body schema for creating this resource (no `id`, optional `lid`). */
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
   * Single-resource document schema. The compound `included` union defaults to
   * the resources directly referenced by this resource's relationships;
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
 */
export type AttributeKeys<R extends Any> = R extends Any ? keyof R["fields"]["attributes"]["fields"] & string
  : never

// ---------------------------------------------------------------------------
// Include paths (type level)
// ---------------------------------------------------------------------------

/**
 * The resource definition a relationship key points at.
 */
export type Target<R extends Any, K> = R["relationships"][K & keyof R["relationships"]] extends
  { readonly ref: () => infer T } ? T extends Any ? T : never : never

/**
 * The resource definitions directly referenced by a resource's relationships.
 *
 * Distributes over unions of resource definitions.
 */
export type TargetsOf<R extends Any> = R extends Any ? RelationshipTargets<R["relationships"]> : never

/**
 * The legal `include` query parameter paths for a resource, as a union of
 * string literals — every relationship key, plus dotted paths one further hop
 * into the graph (e.g. `"author" | "comments" | "comments.author"`).
 *
 * Mirrors {@link includePaths} (the runtime walk) at depth 2, and distributes
 * over unions of resource definitions.
 */
export type IncludePath<R extends Any> = R extends Any ? {
    [K in keyof R["relationships"] & string]:
      | K
      | `${K}.${keyof Target<R, K>["relationships"] & string}`
  }[keyof R["relationships"] & string]
  : never

/**
 * The resource definitions brought into a compound document by one include
 * path. Dotted paths include the intermediate resources as well as the leaf,
 * per the spec.
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
 */
export type IncludedFor<R extends Any, Paths extends ReadonlyArray<string>> = ResolveIncludePath<
  R,
  Paths[number]
>

/**
 * The attribute keys of a resource definition, at runtime.
 */
export const attributeKeys = <R extends Any>(resource: R): ReadonlyArray<AttributeKeys<R>> =>
  Object.keys(resource.fields.attributes.fields) as unknown as ReadonlyArray<AttributeKeys<R>>

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)]

/**
 * Resource definitions directly referenced by `resource`'s relationships.
 */
export const directTargets = (resource: Any): ReadonlyArray<Any> =>
  dedupe(Object.values(resource.relationships).map((descriptor) => descriptor.ref()))

/**
 * The legal `include` query parameter paths for a resource: every relationship
 * path reachable from it, as dot-separated keys, up to `maxDepth` hops.
 *
 * Cycles in the relationship graph are handled by the depth limit.
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-includes}
 */
export const includePaths = (resource: Any, maxDepth: number = 3): ReadonlyArray<string> => {
  const paths: Array<string> = []
  const visit = (current: Any, prefix: string, depth: number): void => {
    if (depth > maxDepth) return
    for (const [key, descriptor] of Object.entries(current.relationships)) {
      const path = prefix === "" ? key : `${prefix}.${key}`
      paths.push(path)
      visit(descriptor.ref(), path, depth + 1)
    }
  }
  visit(resource, "", 1)
  return paths
}

/**
 * Defines a JSON:API resource — the single source of truth from which the
 * resource object schema, identifier, payloads and documents are derived.
 *
 * The returned value *is* the resource object `Schema.Struct`, augmented with
 * the derived members.
 *
 * **Example**
 *
 * ```ts
 * const Person = Resource("people", {
 *   attributes: {
 *     firstName: Schema.NonEmptyString,
 *     lastName: Schema.NonEmptyString
 *   }
 * })
 *
 * const Article = Resource("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: toOne(() => Person) }
 * })
 * ```
 */
export const Resource = <
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
  const relationshipSchemas = makeRelationshipSchemas(relationships)
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

  const createPayload: CreatePayload<Type, Attributes, Rels> = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      lid: Schema.optionalKey(Schema.String),
      attributes,
      relationships: Schema.optionalKey(relationshipsStruct)
    })
  })

  const updatePayload: UpdatePayload<Type, Attributes, Rels> = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      id,
      attributes: Schema.optionalKey(
        Schema.Struct(
          Struct.map(Schema.optionalKey)(options.attributes) as PartialAttributes<Attributes>
        )
      ),
      relationships: Schema.optionalKey(relationshipsStruct)
    })
  })

  // The default `included` union: resources directly referenced by relationships.
  // Built lazily so out-of-order / mutually recursive definitions resolve.
  const includedUnion = (): DefaultIncluded<Rels> =>
    // The cast is sound: every descriptor's target is, by construction of
    // `Rels`, a member of `RelationshipTargets<Rels>`.
    Schema.Union(
      dedupe(Object.values(relationships).map((descriptor) => descriptor.ref()))
    ) as unknown as DefaultIncluded<Rels>

  const resource: Resource<Type, Attributes, Rels, Meta> = Object.assign(struct, {
    type,
    Id: id,
    identifier,
    relationships,
    createPayload,
    updatePayload,
    ref: (refId: string) => identifier.make({ id: id.make(refId) }),
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
