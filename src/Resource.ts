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
 * `IdSchema` defaults to the auto-derived branded {@link Id}; pass a custom id
 * schema (its `Encoded` side must stay `string` for the wire) to carry a
 * consumer-defined id brand instead.
 *
 * @since 0.1.0
 * @category models
 */
export interface Identifier<
  Type extends string,
  IdSchema extends Schema.Codec<any, string> = Id<Type>
> extends Schema.Struct<{
  readonly type: Schema.tag<Type>
  readonly id: IdSchema
  readonly meta: Schema.optionalKey<typeof AnyMeta>
}> {}

/**
 * Creates the resource-identifier schema for a resource type.
 *
 * Useful standalone — e.g. to validate a `{ type, id }` linkage independently
 * of any resource definition. Pass a custom `id` schema (encoding to `string`)
 * to brand the id with the consumer's own schema instead of the default
 * {@link Id}.
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
export const Identifier = <const Type extends string, IdSchema extends Schema.Codec<any, string> = Id<Type>>(
  type: Type,
  id?: IdSchema
): Identifier<Type, IdSchema> =>
  Schema.Struct({
    type: Schema.tag(type),
    id: (id ?? Id(type)) as IdSchema,
    meta: Schema.optionalKey(AnyMeta)
  }) as Identifier<Type, IdSchema>

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
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>
> = {
  readonly type: Schema.tag<Type>
  readonly id: IdSchema
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

// The relationship-record counterpart of `AsFields`: pins a merged descriptor
// record back to `Relationships` so it satisfies the constraint generically.
type AsRelationships<T> = T extends Relationships ? T : never

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
 * Each attribute becomes `Schema.optional`, which captures the three update
 * states the spec's PATCH semantics require, distinctly:
 *
 *   - **set** — the key is present with a value;
 *   - **unset** — the key is present as `undefined` (clear the attribute);
 *   - **leave unchanged** — the key is absent.
 *
 * (`optional(S)` is `optionalKey(UndefinedOr(S))`: the `optionalKey` part models
 * "leave unchanged", the `UndefinedOr` part models "unset". A nullable attribute
 * — `Schema.NullOr(X)` — therefore accepts `value | null | undefined`.)
 *
 * **On the wire.** JSON cannot carry `undefined`, so over a JSON:API HTTP body
 * the "unset via `undefined`" state collapses into "absent / leave unchanged";
 * the wire-expressible way to clear a value is `null` on a nullable attribute
 * (a non-nullable attribute therefore has no over-the-wire clear). The full
 * three-state distinction is available in-process and for codec-based transports
 * (RPC / remote functions) that preserve `undefined`.
 *
 * @since 0.1.0
 * @category type-level
 */
export type PartialAttributes<Attributes extends Schema.Struct.Fields> = {
  readonly [K in keyof Attributes]: Schema.optional<Attributes[K]>
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
  Rels extends Relationships,
  IdSchema extends Schema.Codec<any, string> = Id<Type>
> extends Schema.Struct<{
  readonly data: Schema.Struct<{
    readonly type: Schema.tag<Type>
    readonly id: IdSchema
    readonly attributes: Schema.optionalKey<Schema.Struct<PartialAttributes<Attributes>>>
    readonly relationships: Schema.optionalKey<Schema.Struct<AsFields<UpdateRelationshipFields<Rels>>>>
  }>
}> {}

/**
 * The flat ("command-style") create request shape derived from a resource: the
 * attributes struct alone, *without* the nested
 * `{ data: { type, attributes } }` JSON:API envelope.
 *
 * Useful for transports — RPC, remote functions — that carry a flat attribute
 * payload rather than a JSON:API request body. Opt-in: a resource exposes both
 * the spec {@link CreatePayload} and this flat projection.
 *
 * @since 0.3.0
 * @category models
 */
export interface CreateInput<Attributes extends Schema.Struct.Fields> extends Schema.Struct<Attributes> {}

/**
 * The flat ("command-style") update request shape: the resource id plus the
 * tri-state {@link PartialAttributes}, *without* the JSON:API envelope.
 *
 * @since 0.3.0
 * @category models
 */
export interface UpdateInput<
  Attributes extends Schema.Struct.Fields,
  IdSchema extends Schema.Codec<any, string>
> extends Schema.Struct<AsFields<Omit<PartialAttributes<Attributes>, "id"> & { readonly id: IdSchema }>> {}

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
  Meta extends Schema.Top = typeof AnyMeta,
  IdSchema extends Schema.Codec<any, string> = Id<Type>
> extends Schema.Struct<ResourceFields<Type, Attributes, Rels, Meta, IdSchema>> {
  /** The resource type name. */
  readonly type: Type
  /** The id schema for this resource type (the auto branded {@link Id}, or the injected custom id). */
  readonly Id: IdSchema
  /** The `{ type, id }` resource-identifier schema. */
  readonly identifier: Identifier<Type, IdSchema>
  /** The `{ type, lid }` local-identifier schema (for resources not yet assigned an id). */
  readonly localIdentifier: LocalIdentifier<Type>
  /** The relationship descriptors, as declared. */
  readonly relationships: Rels
  /** Request body schema for creating this resource (no `id`, optional `lid`, required `one` relationships). */
  readonly createPayload: CreatePayload<Type, Attributes, Rels>
  /** Request body schema for updating this resource (`id` required, attributes partial). */
  readonly updatePayload: UpdatePayload<Type, Attributes, Rels, IdSchema>
  /**
   * Flat ("command-style") create request schema: the attributes struct alone,
   * without the JSON:API `{ data: { type, attributes } }` envelope — for
   * transports that carry a flat attribute payload (RPC, remote functions).
   */
  readonly createInput: CreateInput<Attributes>
  /**
   * Flat ("command-style") update request schema: the resource id plus the
   * tri-state partial attributes, without the JSON:API envelope.
   */
  readonly updateInput: UpdateInput<Attributes, IdSchema>
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
  ref(id: string): Identifier<Type, IdSchema>["Type"]
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
   * Single-resource document schema with this resource as primary `data`
   * (non-null) — the canonical document for an existing resource. When the data
   * can be absent, build `Document.DataDocument(Schema.NullOr(R))` (for
   * `R | null`) or `Document.DataDocument(R.nullable())` (for `Option<R>`)
   * instead. The compound `included` union defaults to the resources referenced
   * by this resource's non-`paginated` relationships; override it (or the
   * document `meta`) per call.
   */
  document<Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(options?: {
    readonly included?: Included
    readonly meta?: M
  }): DataDocument<Resource<Type, Attributes, Rels, Meta, IdSchema>, Included, M>
  /**
   * Collection document schema (strict array `data`). Same defaults as
   * {@link document}.
   */
  collection<Included extends Schema.Top = DefaultIncluded<Rels>, M extends Schema.Top = Meta>(options?: {
    readonly included?: Included
    readonly meta?: M
  }): CollectionDocument<Resource<Type, Attributes, Rels, Meta, IdSchema>, Included, M>
  /**
   * This resource wrapped for nullable primary `data`:
   * `Schema.OptionFromNullOr<this>`, decoding and encoding `None ⇆ null` on the
   * wire — the spec-clean way to model JSON:API's `null` primary data.
   *
   * Pass it to `Document.DataDocument` for a single-resource document whose
   * `data` is `Option<R>`:
   *
   * ```ts
   * Document.DataDocument(Article.nullable()) // data: Option<Article>, ⇆ null
   * ```
   *
   * Prefer this to effect's *structural* `Schema.Option` (`{ _tag, value }`),
   * which would serialise a non-conformant body. For a plain `data: R | null`
   * (no `Option`), wrap with `Schema.NullOr(R)` instead.
   */
  nullable(): Schema.OptionFromNullOr<Resource<Type, Attributes, Rels, Meta, IdSchema>>
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

/**
 * The attribute field map of a resource definition — the `Schema.Struct.Fields`
 * record it was defined with.
 *
 * The type-level counterpart of {@link attributes}; spread the runtime value
 * into another resource's `attributes` to reuse a resource's attribute schemas.
 *
 * @since 0.2.0
 * @category type-level
 */
export type AttributesOf<R extends Any> = R["fields"]["attributes"]["fields"]

/**
 * The per-attribute annotation bags of a resource definition: for each
 * attribute key, the annotations stamped on its schema (or `undefined` if it
 * carries none).
 *
 * The annotation bag is the open Effect annotation record, so consumers stamp
 * their own metadata — a `dbColumn` mapping, a presentation hint — onto an
 * attribute with `schema.annotate({ ... })` and read it back via
 * {@link attributeAnnotations}.
 *
 * @since 0.3.0
 * @category type-level
 */
export type AttributeAnnotationsOf<R extends Any> = {
  readonly [K in AttributeKeys<R>]: Schema.Annotations.Annotations | undefined
}

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
 * The relationship descriptor record of a resource definition — the
 * `Relationship.Relationships` record it was defined with.
 *
 * The type-level counterpart of {@link relationships}; spread the runtime value
 * into another resource's `relationships` to reuse a resource's relationships.
 *
 * @since 0.2.0
 * @category type-level
 */
export type RelationshipsOf<R extends Any> = R["relationships"]

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

/**
 * The attribute field map of a resource definition — the `Schema.Struct.Fields`
 * record it was defined with.
 *
 * Spread the result into another resource's `attributes` to reuse a resource's
 * attribute schemas (the runtime counterpart of {@link AttributesOf}). To
 * inherit a resource's attributes *and* relationships wholesale, reach for
 * {@link extend} instead.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 *
 * // Reuse Person's attribute schemas, adding one of its own.
 * const Profile = Resource.make("profiles", {
 *   attributes: { ...Resource.attributes(Person), bio: Schema.String }
 * })
 * ```
 *
 * @since 0.2.0
 * @category accessors
 */
export const attributes = <R extends Any>(resource: R): AttributesOf<R> =>
  resource.fields.attributes.fields as AttributesOf<R>

/**
 * The per-attribute annotation bags of a resource definition: a record from
 * each attribute key to the annotations stamped on its schema (or `undefined`).
 *
 * Consumers stamp metadata onto an attribute with Effect's native
 * `schema.annotate({ ... })` and read it back here — e.g. a database column
 * name that rides alongside the attribute schema:
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: {
 *     bio: Schema.NullOr(Schema.String).annotate({ dbColumn: "biography" })
 *   }
 * })
 *
 * Resource.attributeAnnotations(Person).bio?.dbColumn // "biography"
 * ```
 *
 * @since 0.3.0
 * @category accessors
 */
export const attributeAnnotations = <R extends Any>(resource: R): AttributeAnnotationsOf<R> => {
  const fields = resource.fields.attributes.fields as Record<string, Schema.Top>
  const result: Record<string, Schema.Annotations.Annotations | undefined> = {}
  for (const key of Object.keys(fields)) {
    result[key] = Schema.resolveAnnotations(fields[key]!)
  }
  return result as AttributeAnnotationsOf<R>
}

/**
 * The relationship descriptor record of a resource definition — the
 * `Relationship.Relationships` record it was defined with.
 *
 * Spread the result into another resource's `relationships` to reuse a
 * resource's relationships (the runtime counterpart of {@link RelationshipsOf}).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString }
 * })
 *
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * Resource.relationships(Comment).author.kind // "one"
 * ```
 *
 * @since 0.2.0
 * @category accessors
 */
export const relationships = <R extends Any>(resource: R): RelationshipsOf<R> => resource.relationships

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
  Meta extends Schema.Top = typeof AnyMeta,
  IdSchema extends Schema.Codec<any, string> = Id<Type>
>(
  type: Type,
  options: {
    /**
     * The id schema for this resource. Any schema whose `Encoded` side is
     * `string` (so the wire stays spec-compliant); its decoded type becomes the
     * resource's id brand. Defaults to the auto-derived {@link Id} for `type`.
     */
    readonly id?: IdSchema
    readonly attributes: Attributes
    readonly relationships?: Rels
    readonly meta?: Meta
  }
): Resource<Type, Attributes, Rels, Meta, IdSchema> => {
  const relationships = (options.relationships ?? {}) as Rels
  const meta = (options.meta ?? AnyMeta) as Meta
  const id = (options.id ?? Id(type)) as IdSchema
  const identifier = Identifier(type, id)
  const localIdentifier = LocalIdentifier(type)
  const relationshipSchemas = Relationship.makeRelationshipSchemas(relationships)
  const schemaByKey = relationshipSchemas as Record<string, Schema.Top>
  const attributes = Schema.Struct(options.attributes)
  const relationshipsStruct = Schema.Struct(relationshipSchemas)

  const fields: ResourceFields<Type, Attributes, Rels, Meta, IdSchema> = {
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

  // Tri-state partial attributes: `optional` (= `optionalKey(UndefinedOr(...))`)
  // distinguishes set (value), unset (`undefined`), and leave-unchanged (absent).
  const partialAttributes = Schema.Struct(
    Struct.map(Schema.optional)(options.attributes) as PartialAttributes<Attributes>
  )

  const updatePayload = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      id,
      attributes: Schema.optionalKey(partialAttributes),
      relationships: Schema.optionalKey(Schema.Struct(updateRelationshipFields))
    })
  }) as unknown as UpdatePayload<Type, Attributes, Rels, IdSchema>

  // Flat ("command-style") projections of the create/update inputs, without the
  // JSON:API `{ data: { type, ... } }` envelope.
  const createInput = attributes as unknown as CreateInput<Attributes>
  const updateInput = Schema.Struct({
    ...(Struct.map(Schema.optional)(options.attributes) as PartialAttributes<Attributes>),
    // `id` last so the resource id always wins over any (spec-forbidden) `id` attribute.
    id
  }) as unknown as UpdateInput<Attributes, IdSchema>

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

  const resource: Resource<Type, Attributes, Rels, Meta, IdSchema> = Object.assign(struct, {
    type,
    Id: id,
    identifier,
    localIdentifier,
    relationships,
    createPayload,
    updatePayload,
    createInput,
    updateInput,
    // Decode the wire string through the id schema (rather than `id.make`) so
    // `ref` honours whatever decoded type a custom `Codec<_, string>` id carries.
    ref: (refId: string) =>
      identifier.make({ id: Schema.decodeUnknownSync(id)(refId) } as Identifier<Type, IdSchema>["~type.make.in"]),
    lidRef: (lid: string) => localIdentifier.make({ lid }),
    nullable: () => Schema.OptionFromNullOr(resource),
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

// ---------------------------------------------------------------------------
// Extending (subtyping) a resource
// ---------------------------------------------------------------------------

/**
 * The attribute field map of a resource that {@link extend}s `Base` with
 * `Extra`: the base's attributes merged with the extra ones, the extra ones
 * winning on key collisions.
 *
 * @since 0.2.0
 * @category type-level
 */
export type ExtendedAttributes<Base extends Schema.Struct.Fields, Extra extends Schema.Struct.Fields> = AsFields<
  Struct.Assign<Base, Extra>
>

/**
 * The relationship descriptor record of a resource that {@link extend}s `Base`
 * with `Extra`: the base's relationships merged with the extra ones, the extra
 * ones winning on key collisions.
 *
 * @since 0.2.0
 * @category type-level
 */
export type ExtendedRelationships<Base extends Relationships, Extra extends Relationships> = AsRelationships<
  Struct.Assign<Base, Extra>
>

/**
 * The id schema of a resource that {@link extend}s a base whose id is `BaseId`.
 *
 * With `Inherit` false (the default) the child gets a fresh, independent
 * {@link Id} brand. With `Inherit` true the child's id is the base id *branded
 * again* with the child's type — accumulating the base's brand(s), so the child
 * id is assignable wherever the base id is expected (a true subtype), and so on
 * transitively through an `extend` chain.
 *
 * @since 0.3.0
 * @category type-level
 */
export type ExtendedId<
  BaseId extends Schema.Codec<any, string>,
  Type extends string,
  Inherit extends boolean
> = Inherit extends true ? Schema.brand<BaseId, `${Type}Id`> : Id<Type>

/**
 * Defines a new resource that **extends** (subtypes) an existing one: the new
 * resource inherits the base's attributes and relationships, to which `options`
 * adds more — keys present in `options` override the base's.
 *
 * JSON:API has no native subtyping, so the result is a *distinct* resource type
 * (its own `type` tag and branded id, with payloads and documents derived
 * afresh) that happens to share the base's structure — handy when several
 * resources carry a common set of attributes and relationships defined once.
 * `meta` is inherited from the base; pass `meta` to override it.
 *
 * By default the child gets a fresh, independent id brand, unrelated to the
 * base's. Pass `inheritId: true` to instead brand the *base's* id schema with
 * the child's type, so the child id accumulates the base's brand(s) and is
 * assignable wherever the base id is expected — a true subtype relationship,
 * transitive through an `extend` chain (`Admin.Id` ⊂ `Account.Id`, and a further
 * extension's id ⊂ `Admin.Id` ⊂ `Account.Id`).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Organisation = Resource.make("organisations", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * // The shared shape, defined once.
 * const Account = Resource.make("accounts", {
 *   attributes: {
 *     email: Schema.NonEmptyString,
 *     createdAt: Schema.DateFromString
 *   },
 *   relationships: { organisation: Relationship.one(() => Organisation) }
 * })
 *
 * // `Admin` is its own resource type, but inherits Account's email, createdAt
 * // and organisation, adding a `permissions` attribute of its own.
 * const Admin = Resource.extend(Account, "admins", {
 *   attributes: { permissions: Schema.Array(Schema.String) }
 * })
 *
 * Admin.type // "admins"
 * Resource.attributeKeys(Admin) // ["email", "createdAt", "permissions"]
 *
 * // With `inheritId`, an Admin id IS an Account id (subtype):
 * const Manager = Resource.extend(Account, "managers", { inheritId: true })
 * const managerId = Manager.Id.make("1") // also usable wherever an Account id is expected
 * ```
 *
 * @since 0.2.0
 * @category constructors
 */
export const extend = <
  const BaseType extends string,
  const BaseAttributes extends Schema.Struct.Fields,
  const BaseRels extends Relationships,
  BaseMeta extends Schema.Top,
  const Type extends string,
  const ExtraAttributes extends Schema.Struct.Fields = {},
  const ExtraRels extends Relationships = {},
  Meta extends Schema.Top = BaseMeta,
  BaseId extends Schema.Codec<any, string> = Id<BaseType>,
  const InheritId extends boolean = false
>(
  base: Resource<BaseType, BaseAttributes, BaseRels, BaseMeta, BaseId>,
  type: Type,
  options?: {
    readonly attributes?: ExtraAttributes
    readonly relationships?: ExtraRels
    readonly meta?: Meta
    /**
     * Brand the *base's* id schema with this resource's type instead of minting
     * a fresh independent id, so the child id is a subtype of the base id.
     * Defaults to `false`.
     */
    readonly inheritId?: InheritId
  }
): Resource<
  Type,
  ExtendedAttributes<BaseAttributes, ExtraAttributes>,
  ExtendedRelationships<BaseRels, ExtraRels>,
  Meta,
  ExtendedId<BaseId, Type, InheritId>
> =>
  make(type, {
    id: options?.inheritId === true ? base.Id.pipe(Schema.brand(`${type}Id` as `${Type}Id`)) : undefined,
    attributes: { ...base.fields.attributes.fields, ...options?.attributes },
    relationships: { ...base.relationships, ...options?.relationships },
    meta: (options?.meta ?? base.fields.meta.schema) as Meta
  }) as unknown as Resource<
    Type,
    ExtendedAttributes<BaseAttributes, ExtraAttributes>,
    ExtendedRelationships<BaseRels, ExtraRels>,
    Meta,
    ExtendedId<BaseId, Type, InheritId>
  >

// ---------------------------------------------------------------------------
// Polymorphic families (heterogeneous supertypes)
// ---------------------------------------------------------------------------

/**
 * The linkage schema of a {@link Family}: a union of its members' resource
 * identifiers, discriminated by the `type` tag. This is what makes a family a
 * valid relationship target — linkage decodes for *any* member.
 *
 * @since 0.4.0
 * @category type-level
 */
export interface FamilyIdentifier<Members extends ReadonlyArray<Any>> extends Schema.Union<{
  readonly [K in keyof Members]: Members[K]["identifier"]
}> {}

// Distributes `IncludableTargets` over the member union (the non-`paginated`
// targets of any member — what a family's compound `included` admits).
type FamilyIncludableTargets<Members extends ReadonlyArray<Any>> = Members[number] extends infer R
  ? R extends Any
    ? IncludableTargets<R["relationships"]>
    : never
  : never

/**
 * The default `included` union for a family's compound documents: the
 * non-`paginated` relationship targets of every member.
 *
 * @since 0.4.0
 * @category models
 */
export interface FamilyDefaultIncluded<Members extends ReadonlyArray<Any>> extends Schema.Union<
  ReadonlyArray<FamilyIncludableTargets<Members>>
> {}

/**
 * A polymorphic resource family: a synthetic supertype over a set of member
 * resource definitions.
 *
 * A `Family` *is* the discriminated-union schema over its members (so it decodes
 * as primary `data`, discriminated by the `type` tag) and **also** structurally
 * satisfies {@link Any} — exposing a `type` name, a shared `Id`, a union
 * `identifier`, `relationships` and `fields` — so it can be used as a
 * relationship target (`Relationship.one(() => family)`) and flows through the
 * include machinery unchanged.
 *
 * Build one with {@link family}. When a `Base` is given, the shared `Id` /
 * `relationships` / attributes come from the base; otherwise they are
 * synthesised from the members (id-union, and the by-key intersection of the
 * members' relationships / attributes).
 *
 * @since 0.4.0
 * @category models
 */
export interface Family<
  Name extends string,
  Members extends ReadonlyArray<Any>,
  Base extends Any | undefined = undefined
> extends Schema.Union<Members> {
  /** The family name (used to name groups; *not* a wire resource type). */
  readonly type: Name
  /** The member resource definitions. */
  readonly members: Members
  /** The shared id schema: the base's id, or a union of the members' ids. */
  readonly Id: Base extends Any ? Base["Id"] : Schema.Union<{ readonly [K in keyof Members]: Members[K]["Id"] }>
  /** The linkage schema: a union of the members' identifiers. */
  readonly identifier: FamilyIdentifier<Members>
  /** The shared relationships: the base's, or the by-key intersection of the members'. */
  readonly relationships: Base extends Any ? Base["relationships"] : Relationships
  /** The shared attributes: the base's, or the by-key intersection of the members'. */
  readonly fields: {
    readonly attributes: Base extends Any ? Base["fields"]["attributes"] : Schema.Struct<Schema.Struct.Fields>
  }
  /**
   * Single-resource document schema whose primary `data` is the member union
   * (discriminated by `type`); `included` defaults to every member's
   * non-`paginated` targets.
   */
  document<
    Included extends Schema.Top = FamilyDefaultIncluded<Members>,
    M extends Schema.Top = typeof AnyMeta
  >(options?: {
    readonly included?: Included
    readonly meta?: M
  }): DataDocument<Schema.Union<Members>, Included, M>
  /** Collection document schema (array `data`). Same defaults as {@link document}. */
  collection<
    Included extends Schema.Top = FamilyDefaultIncluded<Members>,
    M extends Schema.Top = typeof AnyMeta
  >(options?: {
    readonly included?: Included
    readonly meta?: M
  }): CollectionDocument<Schema.Union<Members>, Included, M>
}

/**
 * The legal `include` query parameter paths for a family — the union of every
 * member's include paths.
 *
 * @since 0.4.0
 * @category type-level
 */
export type FamilyIncludePath<F extends Family<any, ReadonlyArray<Any>, any>> = IncludePath<F["members"][number]>

/**
 * The `included` union for a family brought in by a set of include paths.
 *
 * @since 0.4.0
 * @category type-level
 */
export type FamilyIncluded<
  F extends Family<any, ReadonlyArray<Any>, any>,
  Paths extends ReadonlyArray<string>
> = IncludedFor<F["members"][number], Paths>

// The by-key intersection of the members' relationships: keep a key only when
// every member declares it with the same kind and the same target type.
const intersectRelationships = (members: ReadonlyArray<Any>): Relationships => {
  const [first, ...rest] = members
  if (first === undefined) return {}
  const result: Record<string, Relationship.Descriptor> = {}
  for (const [key, descriptor] of Object.entries(first.relationships)) {
    const shared = rest.every((member) => {
      const other = member.relationships[key]
      return other !== undefined && other.kind === descriptor.kind && other.ref().type === descriptor.ref().type
    })
    if (shared) result[key] = descriptor
  }
  return result
}

// The by-key intersection of the members' attribute fields.
const intersectAttributes = (members: ReadonlyArray<Any>): Schema.Struct.Fields => {
  const [first, ...rest] = members
  if (first === undefined) return {}
  const result: Record<string, Schema.Struct.Fields[string]> = {}
  for (const [key, schema] of Object.entries(first.fields.attributes.fields)) {
    if (rest.every((member) => key in member.fields.attributes.fields)) result[key] = schema
  }
  return result
}

/**
 * Whether a value is a {@link Family} (as opposed to a single {@link Resource}
 * or a plain `Schema.Union`).
 *
 * @since 0.4.0
 * @category guards
 */
export const isFamily = (u: unknown): u is Family<string, ReadonlyArray<Any>, any> =>
  typeof u === "object" &&
  u !== null &&
  Array.isArray((u as { readonly members?: unknown }).members) &&
  "relationships" in u &&
  "identifier" in u

/**
 * Defines a polymorphic resource **family** — a synthetic supertype over a set
 * of member resources, usable as primary `data`, as a compound `included`
 * member, and as a relationship target.
 *
 * Two forms:
 *
 *   - `Resource.family("nodes", [Person, Organisation])` — a named family; the
 *     shared `Id` / `relationships` / attributes are synthesised from the
 *     members (id-union, and the by-key intersection of the members').
 *   - `Resource.family(Base, [Person, Organisation])` — a base-anchored family;
 *     the shared `Id` / `relationships` / attributes come from `Base` (the
 *     recommended form when members are `extend(Base, …, { inheritId: true })`,
 *     so the shared id brand anchors "any member id" and dotted `?include=`
 *     paths through the family are meaningful).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } })
 * const Person = Resource.extend(Node, "people", { inheritId: true })
 * const Organisation = Resource.extend(Node, "organisations", { inheritId: true })
 *
 * // A supertype over the two subtypes.
 * const AnyNode = Resource.family(Node, [Person, Organisation])
 *
 * // Use it as a relationship target — linkage decodes for any member.
 * const Edge = Resource.make("edges", {
 *   attributes: { weight: Schema.Number },
 *   relationships: { to: Relationship.one(() => AnyNode) }
 * })
 *
 * AnyNode.document()   // data: Person | Organisation
 * AnyNode.collection() // data: Array<Person | Organisation>
 * ```
 *
 * @since 0.4.0
 * @category constructors
 */
export function family<const Name extends string, const Members extends ReadonlyArray<Any>>(
  name: Name,
  members: Members
): Family<Name, Members, undefined>
export function family<
  const BaseType extends string,
  const BaseAttributes extends Schema.Struct.Fields,
  const BaseRels extends Relationships,
  BaseMeta extends Schema.Top,
  BaseId extends Schema.Codec<any, string>,
  const Members extends ReadonlyArray<Any>
>(
  base: Resource<BaseType, BaseAttributes, BaseRels, BaseMeta, BaseId>,
  members: Members
): Family<BaseType, Members, Resource<BaseType, BaseAttributes, BaseRels, BaseMeta, BaseId>>
export function family(nameOrBase: string | Any, members: ReadonlyArray<Any>): Family<string, ReadonlyArray<Any>, any> {
  if (members.length === 0) {
    throw new Error("Resource.family requires at least one member")
  }
  const base = typeof nameOrBase === "string" ? undefined : nameOrBase
  const name = base !== undefined ? base.type : (nameOrBase as string)

  const memberUnion = Schema.Union(members)
  const identifier = Schema.Union(members.map((member) => member.identifier))
  const id = base !== undefined ? base.Id : Schema.Union(members.map((member) => member.Id))
  const attributes = base !== undefined ? base.fields.attributes : Schema.Struct(intersectAttributes(members))

  // The default `included` union: every member's non-`paginated` targets.
  const includedUnion = () => Schema.Union(dedupe(members.flatMap(directTargets)))

  const fam = Object.assign(memberUnion, {
    type: name,
    members,
    Id: id,
    identifier,
    fields: { attributes },
    document: (opts?: { readonly included?: Schema.Top; readonly meta?: Schema.Top }) =>
      DataDocument(memberUnion, {
        included: opts?.included ?? includedUnion(),
        meta: opts?.meta ?? AnyMeta
      }),
    collection: (opts?: { readonly included?: Schema.Top; readonly meta?: Schema.Top }) =>
      CollectionDocument(memberUnion, {
        included: opts?.included ?? includedUnion(),
        meta: opts?.meta ?? AnyMeta
      })
  }) as unknown as Family<string, ReadonlyArray<Any>, any>

  // `relationships` is resolved lazily (memoised) so member relationship thunks
  // resolve regardless of declaration order — the no-base intersection walks
  // `descriptor.ref()`, which must not be forced at construction time (the rest
  // of the library is lazy; forcing it here would reintroduce an order dependency).
  let relationships: Relationships | undefined
  Object.defineProperty(fam, "relationships", {
    get: () => (relationships ??= base !== undefined ? base.relationships : intersectRelationships(members)),
    enumerable: true,
    configurable: true
  })

  return fam
}
