/**
 * JSON:API Atomic Operations extension.
 *
 * Models the {@link https://jsonapi.org/ext/atomic/ atomic operations extension}:
 * a single request carrying an ordered list of operations — creating, updating
 * and deleting resources or relationships — that the server processes
 * atomically (all succeed, or none are applied).
 *
 * Everything is derived from {@link Resource} definitions, like the rest of
 * the library. The operations derived for a resource are, exactly:
 *
 * | Operation                                | Wire form                                          |
 * | ---------------------------------------- | -------------------------------------------------- |
 * | `add`                                    | `{ op: "add", data: { type, lid?, attributes, relationships? } }` |
 * | `update`                                 | `{ op: "update", data: { type, id \| lid, attributes?, relationships? } }` |
 * | `remove`                                 | `{ op: "remove", ref: { type, id \| lid } }`       |
 * | per to-one relationship: `update`        | `{ op: "update", ref: { type, id \| lid, relationship }, data: ref \| null }` |
 * | per to-many relationship: `add` / `update` / `remove` | `{ op, ref: { type, id \| lid, relationship }, data: [refs] }` |
 *
 * {@link operationsFor} returns this set as a named, introspectable record of
 * schemas; {@link Operations} / {@link RequestDocument} build the request
 * union from it.
 *
 * ```ts
 * // The endpoint (one per api, conventionally POST /operations):
 * const operations = JsonApi.Group("operations",
 *   JsonApi.Endpoint.operations([Article, Comment])
 * )
 *
 * // A client request: create an article and a comment on it, atomically.
 * // The article doesn't exist yet, so the comment references it by `lid`.
 * yield* client.operations.operations({
 *   payload: Atomic.request(
 *     Atomic.add(Article, { lid: "a1", attributes: { title: "Hello" } }),
 *     Atomic.add(Comment, {
 *       attributes: { body: "First!" },
 *       relationships: { article: { data: Article.lidRef("a1") } }
 *     })
 *   )
 * })
 * ```
 *
 * @see {@link https://jsonapi.org/ext/atomic/}
 */
import { Schema, Struct } from "effect"
import { AnyMeta, JsonApiObject, TopLevelLinks } from "./Document.js"
import type { LinksValue, MetaValue, ResourceValue } from "./Handlers.js"
import { ATOMIC_EXTENSION_URI, ATOMIC_MEDIA_TYPE } from "./internal/media.js"
import type { Any, PartialAttributes, RefValue, Relationships, ToMany, ToOne } from "./Resource.js"
import { Ref } from "./Resource.js"

// ---------------------------------------------------------------------------
// Extension constants
// ---------------------------------------------------------------------------

/**
 * The atomic operations extension URI:
 * `"https://jsonapi.org/ext/atomic"`.
 *
 * Pass it to `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` so
 * content negotiation accepts the extension media type.
 */
export const EXTENSION_URI: string = ATOMIC_EXTENSION_URI

/**
 * The JSON:API media type carrying the atomic operations `ext` parameter:
 * `'application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"'`.
 */
export const MEDIA_TYPE: string = ATOMIC_MEDIA_TYPE

/**
 * A ready-made top-level `jsonapi` member value advertising support for the
 * atomic operations extension.
 */
export const jsonapi: typeof JsonApiObject.Type = { version: "1.1", ext: [ATOMIC_EXTENSION_URI] }

// ---------------------------------------------------------------------------
// Operation refs (atomic-specific: with / without a `relationship` member)
// ---------------------------------------------------------------------------

/**
 * A ref to a resource *as a whole* — the target of resource-level `update` /
 * `remove` operations.
 *
 * Structurally a `Ref` (id- or lid-based, see `Resource.Ref`) whose
 * `relationship` member is forbidden (`optionalKey(Never)`), which is what
 * makes the operation union unambiguous: a ref carrying `relationship` can
 * only decode as a relationship operation.
 */
export interface ResourceRef<R extends Any> extends
  Schema.Union<readonly [
    Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly id: R["Id"]
      readonly meta: Schema.optionalKey<typeof AnyMeta>
      readonly relationship: Schema.optionalKey<typeof Schema.Never>
    }>,
    Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly lid: Schema.String
      readonly meta: Schema.optionalKey<typeof AnyMeta>
      readonly relationship: Schema.optionalKey<typeof Schema.Never>
    }>
  ]>
{}

/**
 * Creates the resource-ref schema for a resource.
 */
export const ResourceRef = <R extends Any>(resource: R): ResourceRef<R> =>
  Schema.Union([
    Schema.Struct({
      type: Schema.tag(resource.type),
      id: resource.Id,
      meta: Schema.optionalKey(AnyMeta),
      relationship: Schema.optionalKey(Schema.Never)
    }),
    Schema.Struct({
      type: Schema.tag(resource.type),
      lid: Schema.String,
      meta: Schema.optionalKey(AnyMeta),
      relationship: Schema.optionalKey(Schema.Never)
    })
  ]) as unknown as ResourceRef<R>

/**
 * A ref to one of a resource's relationships — the target of relationship
 * operations: `{ type, id | lid, relationship }`.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-updating-to-one-relationships}
 */
export interface RelationshipRef<R extends Any, K extends string> extends
  Schema.Union<readonly [
    Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly id: R["Id"]
      readonly relationship: Schema.tag<K>
    }>,
    Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly lid: Schema.String
      readonly relationship: Schema.tag<K>
    }>
  ]>
{}

/**
 * Creates the relationship-ref schema for one of a resource's relationships.
 */
export const RelationshipRef = <R extends Any, const K extends keyof R["relationships"] & string>(
  resource: R,
  relationship: K
): RelationshipRef<R, K> =>
  Schema.Union([
    Schema.Struct({
      type: Schema.tag(resource.type),
      id: resource.Id,
      relationship: Schema.tag(relationship)
    }),
    Schema.Struct({
      type: Schema.tag(resource.type),
      lid: Schema.String,
      relationship: Schema.tag(relationship)
    })
  ]) as unknown as RelationshipRef<R, K>

// ---------------------------------------------------------------------------
// Relationship linkage inside operations (refs may be lid-based)
// ---------------------------------------------------------------------------

/**
 * The linkage of a to-one relationship inside an operation: like the
 * resource's own relationship schema, but identifiers may be lid-based.
 */
export interface ToOneRefSchema<R extends Any> extends
  Schema.Struct<{
    readonly data: Schema.NullOr<Ref<R>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * The linkage of a to-many relationship inside an operation.
 */
export interface ToManyRefSchema<R extends Any> extends
  Schema.Struct<{
    readonly data: Schema.$Array<Ref<R>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Maps a record of relationship descriptors to their operation-linkage
 * schemas (id- or lid-based identifiers).
 */
export type RefRelationshipSchemas<Rels extends Relationships> = {
  readonly [K in keyof Rels]: Rels[K] extends ToOne<infer R> ? ToOneRefSchema<R>
    : Rels[K] extends ToMany<infer R> ? ToManyRefSchema<R>
    : never
}

const makeRefRelationshipSchemas = <Rels extends Relationships>(rels: Rels): RefRelationshipSchemas<Rels> =>
  Object.fromEntries(
    Object.entries(rels).map(([key, descriptor]) => [
      key,
      descriptor.kind === "toOne"
        ? Schema.Struct({
          data: Schema.NullOr(Ref(descriptor.ref)),
          meta: Schema.optionalKey(AnyMeta)
        })
        : Schema.Struct({
          data: Schema.Array(Ref(descriptor.ref)),
          meta: Schema.optionalKey(AnyMeta)
        })
    ])
  ) as RefRelationshipSchemas<Rels>

// ---------------------------------------------------------------------------
// Resource operations: add / update / remove
// ---------------------------------------------------------------------------

/**
 * An `add` operation: creates a resource. The operation's `data` is the
 * resource to create — no `id` (the server assigns one), an optional `lid` so
 * later operations in the same request can reference it, and relationship
 * linkage that may itself be lid-based.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-creating-resources}
 */
export interface AddOperation<R extends Any> extends
  Schema.Struct<{
    readonly op: Schema.tag<"add">
    readonly data: Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly lid: Schema.optionalKey<Schema.String>
      readonly attributes: R["fields"]["attributes"]
      readonly relationships: Schema.optionalKey<Schema.Struct<RefRelationshipSchemas<R["relationships"]>>>
    }>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Creates the `add` operation schema for a resource.
 */
export const AddOperation = <R extends Any>(resource: R): AddOperation<R> =>
  Schema.Struct({
    op: Schema.tag("add"),
    data: Schema.Struct({
      type: Schema.tag(resource.type),
      lid: Schema.optionalKey(Schema.String),
      attributes: resource.fields.attributes,
      relationships: Schema.optionalKey(
        Schema.Struct(makeRefRelationshipSchemas(resource.relationships))
      )
    }),
    meta: Schema.optionalKey(AnyMeta)
  }) as unknown as AddOperation<R>

/**
 * An `update` operation: updates a resource. The target is named by the
 * operation's `data` (`type` plus `id` — or `lid`, for resources created
 * earlier in the same request); attributes are partial.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-updating-resources}
 */
export interface UpdateOperation<R extends Any> extends
  Schema.Struct<{
    readonly op: Schema.tag<"update">
    readonly ref: Schema.optionalKey<ResourceRef<R>>
    readonly data: Schema.Struct<{
      readonly type: Schema.tag<R["type"]>
      readonly id: Schema.optionalKey<R["Id"]>
      readonly lid: Schema.optionalKey<Schema.String>
      readonly attributes: Schema.optionalKey<
        Schema.Struct<PartialAttributes<R["fields"]["attributes"]["fields"]>>
      >
      readonly relationships: Schema.optionalKey<Schema.Struct<RefRelationshipSchemas<R["relationships"]>>>
    }>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Creates the `update` operation schema for a resource.
 */
export const UpdateOperation = <R extends Any>(resource: R): UpdateOperation<R> =>
  Schema.Struct({
    op: Schema.tag("update"),
    ref: Schema.optionalKey(ResourceRef(resource)),
    data: Schema.Struct({
      type: Schema.tag(resource.type),
      id: Schema.optionalKey(resource.Id),
      lid: Schema.optionalKey(Schema.String),
      attributes: Schema.optionalKey(
        Schema.Struct(Struct.map(Schema.optionalKey)(resource.fields.attributes.fields))
      ),
      relationships: Schema.optionalKey(
        Schema.Struct(makeRefRelationshipSchemas(resource.relationships))
      )
    }),
    meta: Schema.optionalKey(AnyMeta)
  }) as unknown as UpdateOperation<R>

/**
 * A `remove` operation: deletes the resource targeted by `ref`.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-deleting-resources}
 */
export interface RemoveOperation<R extends Any> extends
  Schema.Struct<{
    readonly op: Schema.tag<"remove">
    readonly ref: ResourceRef<R>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Creates the `remove` operation schema for a resource.
 */
export const RemoveOperation = <R extends Any>(resource: R): RemoveOperation<R> =>
  Schema.Struct({
    op: Schema.tag("remove"),
    ref: ResourceRef(resource),
    meta: Schema.optionalKey(AnyMeta)
  }) as unknown as RemoveOperation<R>

// ---------------------------------------------------------------------------
// Relationship operations
// ---------------------------------------------------------------------------

/**
 * An `update` operation on a to-one relationship: replaces the linkage with
 * the given identifier (or `null` to clear it).
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-updating-to-one-relationships}
 */
export interface UpdateToOneRelationshipOperation<R extends Any, K extends string, T extends Any> extends
  Schema.Struct<{
    readonly op: Schema.tag<"update">
    readonly ref: RelationshipRef<R, K>
    readonly data: Schema.NullOr<Ref<T>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * An operation on a to-many relationship: `add` appends members, `update`
 * replaces all members, `remove` deletes members.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-updating-to-many-relationships}
 */
export interface ToManyRelationshipOperation<
  Op extends "add" | "update" | "remove",
  R extends Any,
  K extends string,
  T extends Any
> extends
  Schema.Struct<{
    readonly op: Schema.tag<Op>
    readonly ref: RelationshipRef<R, K>
    readonly data: Schema.$Array<Ref<T>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

// ---------------------------------------------------------------------------
// The operations derived for a resource, as an introspectable record
// ---------------------------------------------------------------------------

/**
 * The operations derived for one relationship: to-one relationships admit
 * `update`; to-many relationships admit `add`, `update` and `remove`.
 */
export type RelationshipOperationsFor<R extends Any, K extends string, Rel> = Rel extends ToOne<infer T> ? {
    /** Replace the to-one linkage with an identifier, or `null` to clear it. */
    readonly update: UpdateToOneRelationshipOperation<R, K, T>
  }
  : Rel extends ToMany<infer T> ? {
      /** Append members to the to-many linkage. */
      readonly add: ToManyRelationshipOperation<"add", R, K, T>
      /** Replace all members of the to-many linkage. */
      readonly update: ToManyRelationshipOperation<"update", R, K, T>
      /** Delete members from the to-many linkage. */
      readonly remove: ToManyRelationshipOperation<"remove", R, K, T>
    }
  : never

/**
 * Every operation derived for a resource, as a named record of schemas —
 * the single source of truth the request document union is built from, and
 * the answer to "what operations exist for this resource?".
 *
 * ```ts
 * const ops = Atomic.operationsFor(Article)
 * ops.add                              // create an article
 * ops.update                           // update an article
 * ops.remove                           // delete an article
 * ops.relationships.author.update      // replace its author (to-one)
 * ops.relationships.comments.add       // append comments (to-many)
 * ops.relationships.comments.update    // replace all comments
 * ops.relationships.comments.remove    // delete comments from the linkage
 * ```
 */
export interface ResourceOperations<R extends Any> {
  /** `{ op: "add", data: { type, lid?, attributes, relationships? } }` — create the resource. */
  readonly add: AddOperation<R>
  /** `{ op: "update", data: { type, id | lid, attributes?, relationships? } }` — update the resource. */
  readonly update: UpdateOperation<R>
  /** `{ op: "remove", ref: { type, id | lid } }` — delete the resource. */
  readonly remove: RemoveOperation<R>
  /** Operations on each of the resource's relationships, by relationship key. */
  readonly relationships: {
    readonly [K in keyof R["relationships"] & string]: RelationshipOperationsFor<R, K, R["relationships"][K]>
  }
}

/**
 * Derives the full set of operations for a resource: resource-level
 * add / update / remove plus the operations of each of its relationships.
 */
export const operationsFor = <R extends Any>(resource: R): ResourceOperations<R> => {
  const relationships: Record<string, Record<string, Schema.Top>> = {}
  for (const [key, descriptor] of Object.entries(resource.relationships)) {
    const ref = RelationshipRef(resource, key)
    if (descriptor.kind === "toOne") {
      relationships[key] = {
        update: Schema.Struct({
          op: Schema.tag("update"),
          ref,
          data: Schema.NullOr(Ref(descriptor.ref)),
          meta: Schema.optionalKey(AnyMeta)
        })
      }
    } else {
      const data = Schema.Array(Ref(descriptor.ref))
      relationships[key] = Object.fromEntries(
        (["add", "update", "remove"] as const).map((op) => [
          op,
          Schema.Struct({
            op: Schema.tag(op),
            ref,
            data,
            meta: Schema.optionalKey(AnyMeta)
          })
        ])
      )
    }
  }
  return {
    add: AddOperation(resource),
    update: UpdateOperation(resource),
    remove: RemoveOperation(resource),
    relationships
  } as ResourceOperations<R>
}

// ---------------------------------------------------------------------------
// The operation union and the request document
// ---------------------------------------------------------------------------

/**
 * The union of relationship operations legal for a resource, derived from its
 * relationship descriptors.
 */
export type RelationshipOperation<R extends Any> = {
  [K in keyof R["relationships"] & string]: R["relationships"][K] extends ToOne<infer T>
    ? UpdateToOneRelationshipOperation<R, K, T>
    : R["relationships"][K] extends ToMany<infer T> ?
        | ToManyRelationshipOperation<"add", R, K, T>
        | ToManyRelationshipOperation<"update", R, K, T>
        | ToManyRelationshipOperation<"remove", R, K, T>
    : never
}[keyof R["relationships"] & string]

/**
 * Every operation legal for a resource: its relationship operations plus
 * resource-level add / update / remove — the union of everything in
 * {@link operationsFor}.
 *
 * Distributes over unions of resource definitions.
 */
export type Operation<R extends Any> = R extends Any ?
    | RelationshipOperation<R>
    | AddOperation<R>
    | UpdateOperation<R>
    | RemoveOperation<R>
  : never

/**
 * The schema of the operation union across a set of resources.
 */
export interface Operations<R extends Any> extends Schema.Union<ReadonlyArray<Operation<R>>> {}

// Flattens one resource's operations record into union members. Relationship
// operations come before resource operations: their refs carry a
// `relationship` member, which resource-operation refs forbid, so decoding is
// unambiguous.
const flattenOperations = (operations: ResourceOperations<Any>): Array<Schema.Top> => [
  ...Object.values(operations.relationships).flatMap((ops) => Object.values(ops) as Array<Schema.Top>),
  operations.add,
  operations.update,
  operations.remove
]

/**
 * Creates the operation union schema for a set of resources — the union of
 * every schema in each resource's {@link operationsFor} record.
 */
export const Operations = <const Resources extends ReadonlyArray<Any>>(
  resources: Resources
): Operations<Resources[number]> =>
  Schema.Union(
    resources.flatMap((resource) => flattenOperations(operationsFor(resource)))
  ) as unknown as Operations<Resources[number]>

/**
 * The `atomic:operations` request document schema for a set of resources: a
 * non-empty, ordered list of operations.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#operation-objects}
 */
export interface RequestDocument<R extends Any> extends
  Schema.Struct<{
    readonly "atomic:operations": Schema.$Array<Operations<R>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
    readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
  }>
{}

/**
 * Creates the `atomic:operations` request document schema for a set of
 * resources.
 */
export const RequestDocument = <const Resources extends ReadonlyArray<Any>>(
  resources: Resources
): RequestDocument<Resources[number]> =>
  Schema.Struct({
    "atomic:operations": Schema.Array(Operations(resources)).check(Schema.isMinLength(1)),
    meta: Schema.optionalKey(AnyMeta),
    jsonapi: Schema.optionalKey(JsonApiObject)
  }) as unknown as RequestDocument<Resources[number]>

// ---------------------------------------------------------------------------
// The result document
// ---------------------------------------------------------------------------

/**
 * One result object: the outcome of one operation. Operations that return
 * nothing produce an empty object (or `{ data: null }`).
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-result-objects}
 */
export interface Result<R extends Any> extends
  Schema.Struct<{
    readonly data: Schema.optionalKey<Schema.NullOr<Schema.Union<ReadonlyArray<R>>>>
    readonly meta: Schema.optionalKey<typeof AnyMeta>
  }>
{}

/**
 * Creates the result-object schema for a set of resources.
 */
export const Result = <const Resources extends ReadonlyArray<Any>>(
  resources: Resources
): Result<Resources[number]> =>
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(Schema.Union(resources))),
    meta: Schema.optionalKey(AnyMeta)
  }) as unknown as Result<Resources[number]>

/**
 * The `atomic:results` response document schema: one result object per
 * operation, in request order.
 *
 * @see {@link https://jsonapi.org/ext/atomic/#auto-id-responses-4}
 */
export interface ResultDocument<R extends Any, M extends Schema.Top = typeof AnyMeta> extends
  Schema.Struct<{
    readonly "atomic:results": Schema.$Array<Result<R>>
    readonly links: Schema.optionalKey<typeof TopLevelLinks>
    readonly meta: Schema.optionalKey<M>
    readonly jsonapi: Schema.optionalKey<typeof JsonApiObject>
  }>
{}

/**
 * Creates the `atomic:results` response document schema for a set of
 * resources.
 */
export const ResultDocument = <
  const Resources extends ReadonlyArray<Any>,
  M extends Schema.Top = typeof AnyMeta
>(
  resources: Resources,
  options?: {
    readonly meta?: M
  }
): ResultDocument<Resources[number], M> =>
  Schema.Struct({
    "atomic:results": Schema.Array(Result(resources)),
    links: Schema.optionalKey(TopLevelLinks),
    meta: Schema.optionalKey((options?.meta ?? AnyMeta) as M),
    jsonapi: Schema.optionalKey(JsonApiObject)
  }) as unknown as ResultDocument<Resources[number], M>

// ---------------------------------------------------------------------------
// Operation value constructors (client side)
// ---------------------------------------------------------------------------

const targetRef = (type: string, target: string | { readonly lid: string }): RefValue =>
  typeof target === "string" ? { type, id: target } : { type, lid: target.lid }

/**
 * Builds an `add` operation value: creates a resource.
 *
 * ```ts
 * Atomic.add(Article, {
 *   lid: "a1",                          // so later operations can reference it
 *   attributes: { title: "Hello" }
 * })
 * ```
 */
export const add = <R extends Any>(
  resource: R,
  data: Omit<AddOperation<R>["Type"]["data"], "type">,
  options?: { readonly meta?: MetaValue }
): AddOperation<R>["Type"] =>
  ({
    op: "add",
    data: { type: resource.type, ...data },
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as AddOperation<R>["Type"]

/**
 * Builds an `update` operation value: updates a resource (partial attributes).
 *
 * ```ts
 * Atomic.update(Article, {
 *   id: Article.Id.make("1"),
 *   attributes: { title: "Updated" }
 * })
 * ```
 */
export const update = <R extends Any>(
  resource: R,
  data: Omit<UpdateOperation<R>["Type"]["data"], "type">,
  options?: { readonly meta?: MetaValue }
): UpdateOperation<R>["Type"] =>
  ({
    op: "update",
    data: { type: resource.type, ...data },
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as UpdateOperation<R>["Type"]

/**
 * Builds a `remove` operation value: deletes a resource by id — or by lid, for
 * resources created earlier in the same request.
 *
 * ```ts
 * Atomic.remove(Article, "1")
 * Atomic.remove(Article, { lid: "a1" })
 * ```
 */
export const remove = <R extends Any>(
  resource: R,
  target: string | { readonly lid: string },
  options?: { readonly meta?: MetaValue }
): RemoveOperation<R>["Type"] =>
  ({
    op: "remove",
    ref: targetRef(resource.type, target),
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as RemoveOperation<R>["Type"]

/**
 * The relationship keys of a resource.
 */
export type RelationshipKeys<R extends Any> = keyof R["relationships"] & string

/**
 * The to-many relationship keys of a resource.
 */
export type ToManyKeys<R extends Any> = {
  [K in RelationshipKeys<R>]: R["relationships"][K] extends ToMany<Any> ? K : never
}[RelationshipKeys<R>]

/**
 * The ref values accepted for a target resource: its typed identifier or a
 * lid-based local identifier (`Target.ref(id)` / `Target.lidRef(lid)`).
 */
export type RefValueFor<T extends Any> = Ref<T>["Type"]

/**
 * The linkage value of a relationship operation: one ref (or `null`) for
 * to-one relationships, an array of refs for to-many relationships.
 */
export type RelationshipDataValue<R extends Any, K extends RelationshipKeys<R>> = R["relationships"][K] extends
  ToOne<infer T> ? RefValueFor<T> | null
  : R["relationships"][K] extends ToMany<infer T> ? ReadonlyArray<RefValueFor<T>>
  : never

/**
 * The value type of an `update` operation on relationship `K` of `R`.
 */
export type UpdateRelationshipValue<R extends Any, K extends RelationshipKeys<R>> = R["relationships"][K] extends
  ToOne<infer T> ? UpdateToOneRelationshipOperation<R, K, T>["Type"]
  : R["relationships"][K] extends ToMany<infer T> ? ToManyRelationshipOperation<"update", R, K, T>["Type"]
  : never

/**
 * Builds an `update` operation on a relationship: replaces a to-one linkage
 * (identifier or `null`) or all members of a to-many linkage.
 *
 * ```ts
 * Atomic.updateRelationship(Comment, "5", "author", Person.ref("9"))
 * Atomic.updateRelationship(Article, "1", "comments", [Comment.ref("5")])
 * Atomic.updateRelationship(Article, { lid: "a1" }, "author", null)
 * ```
 */
export const updateRelationship = <R extends Any, const K extends RelationshipKeys<R>>(
  resource: R,
  target: string | { readonly lid: string },
  relationship: K,
  data: RelationshipDataValue<R, K>,
  options?: { readonly meta?: MetaValue }
): UpdateRelationshipValue<R, K> =>
  ({
    op: "update",
    ref: { ...targetRef(resource.type, target), relationship },
    data,
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as UpdateRelationshipValue<R, K>

/**
 * The target resource of a to-many relationship key.
 */
export type ToManyTarget<R extends Any, K extends ToManyKeys<R>> = R["relationships"][K] extends ToMany<infer T> ? T
  : never

/**
 * Builds an `add` operation on a to-many relationship: appends members.
 *
 * ```ts
 * Atomic.addToRelationship(Article, "1", "comments", [Comment.ref("5")])
 * ```
 */
export const addToRelationship = <R extends Any, const K extends ToManyKeys<R>>(
  resource: R,
  target: string | { readonly lid: string },
  relationship: K,
  data: ReadonlyArray<RefValueFor<ToManyTarget<R, K>>>,
  options?: { readonly meta?: MetaValue }
): ToManyRelationshipOperation<"add", R, K, ToManyTarget<R, K>>["Type"] =>
  ({
    op: "add",
    ref: { ...targetRef(resource.type, target), relationship },
    data,
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as ToManyRelationshipOperation<"add", R, K, ToManyTarget<R, K>>["Type"]

/**
 * Builds a `remove` operation on a to-many relationship: deletes members.
 *
 * ```ts
 * Atomic.removeFromRelationship(Article, "1", "comments", [Comment.ref("5")])
 * ```
 */
export const removeFromRelationship = <R extends Any, const K extends ToManyKeys<R>>(
  resource: R,
  target: string | { readonly lid: string },
  relationship: K,
  data: ReadonlyArray<RefValueFor<ToManyTarget<R, K>>>,
  options?: { readonly meta?: MetaValue }
): ToManyRelationshipOperation<"remove", R, K, ToManyTarget<R, K>>["Type"] =>
  ({
    op: "remove",
    ref: { ...targetRef(resource.type, target), relationship },
    data,
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }) as ToManyRelationshipOperation<"remove", R, K, ToManyTarget<R, K>>["Type"]

/**
 * Builds an `atomic:operations` request document value from operation values.
 *
 * ```ts
 * client.operations.operations({
 *   payload: Atomic.request(
 *     Atomic.add(Article, { lid: "a1", attributes: { title: "Hello" } }),
 *     Atomic.remove(Comment, "5")
 *   )
 * })
 * ```
 */
export const request = <const Ops extends ReadonlyArray<{ readonly op: "add" | "update" | "remove" }>>(
  ...ops: Ops
): { readonly "atomic:operations": Ops } => ({ "atomic:operations": ops })

// ---------------------------------------------------------------------------
// Handler-side helpers
// ---------------------------------------------------------------------------

/**
 * The minimal runtime shape of one result object value.
 */
export interface ResultValue {
  readonly data?: ResourceValue | null
  readonly meta?: MetaValue
}

/**
 * An empty result object — for operations that complete without returning
 * data (relationship updates, removals).
 */
export const emptyResult: { readonly data?: never } = {}

/**
 * Builds one result object value.
 */
export const result = <const R extends ResourceValue | null, const M extends MetaValue = never>(
  data: R,
  meta?: M
): { readonly data: R; readonly meta?: M } =>
  ({
    data,
    ...(meta !== undefined ? { meta } : {})
  }) as { readonly data: R; readonly meta?: M }

/**
 * Builds an `atomic:results` document value: one entry per operation, in
 * request order.
 *
 * ```ts
 * handlers.handle("operations", ({ payload }) =>
 *   Effect.gen(function*() {
 *     const entries = []
 *     for (const operation of payload["atomic:operations"]) {
 *       entries.push(yield* apply(operation))   // { data: resource } or Atomic.emptyResult
 *     }
 *     return Atomic.results(entries)
 *   }))
 * ```
 */
export const results = <const Entries extends ReadonlyArray<ResultValue>>(
  entries: Entries,
  options?: {
    readonly meta?: MetaValue
    readonly links?: LinksValue
  }
): { readonly "atomic:results": Entries } =>
  ({
    "atomic:results": entries,
    ...(options?.meta !== undefined ? { meta: options.meta } : {}),
    ...(options?.links !== undefined ? { links: options.links } : {})
  }) as { readonly "atomic:results": Entries }

/**
 * The JSON Pointer to the operation at `index` in a request document — for
 * error objects' `source.pointer` member, per the extension's recommendation
 * that errors identify the operation that failed.
 *
 * ```ts
 * Atomic.operationPointer(1)   // "/atomic:operations/1"
 * ```
 */
export const operationPointer = (index: number): string => `/atomic:operations/${index}`

// ---------------------------------------------------------------------------
// Operation discrimination (handler side)
// ---------------------------------------------------------------------------

const isOperationValue = (value: unknown): value is { readonly op: string } =>
  typeof value === "object" && value !== null && typeof (value as { readonly op?: unknown }).op === "string"

/**
 * Type guard: does this operation target a relationship (rather than a
 * resource)? Relationship operations are the ones whose `ref` carries a
 * `relationship` member.
 *
 * ```ts
 * for (const operation of payload["atomic:operations"]) {
 *   if (Atomic.isRelationshipOperation(operation)) {
 *     operation.ref.relationship   // typed relationship key
 *   } else {
 *     operation.op                 // "add" | "update" | "remove" on a resource
 *   }
 * }
 * ```
 */
export const isRelationshipOperation = <Op extends { readonly op: string }>(
  operation: Op
): operation is Extract<Op, { readonly ref: { readonly relationship: string } }> => {
  const ref = (operation as { readonly ref?: unknown }).ref
  return typeof ref === "object" && ref !== null && "relationship" in ref
}

/**
 * The structural shape of operations that target resource `R` itself: `add` /
 * `update` operations carry it in `data.type`; `remove` operations in
 * `ref.type` (with no `relationship` member).
 */
export type ResourceOperationShape<R extends Any> =
  | { readonly data: { readonly type: R["type"] } }
  | { readonly op: "remove"; readonly ref: { readonly type: R["type"]; readonly relationship?: never } }

/**
 * The operations of `Op` that target resource `R` itself (not one of its
 * relationships).
 */
export type TargetsResource<Op, R extends Any> = Extract<Op, ResourceOperationShape<R>>

const targetsResourceImpl = (operation: { readonly op: string }, resource: Any): boolean => {
  if (isRelationshipOperation(operation)) return false
  const data = (operation as { readonly data?: unknown }).data
  if (data !== undefined && data !== null && typeof data === "object" && !Array.isArray(data)) {
    return (data as { readonly type?: unknown }).type === resource.type
  }
  const ref = (operation as { readonly ref?: { readonly type?: unknown } | undefined }).ref
  return ref?.type === resource.type
}

/**
 * Type guard: does this operation target the given resource (an `add` /
 * `update` / `remove` of the resource itself, not of a relationship)?
 *
 * Narrows the operation union to that resource's operations, so handlers can
 * switch on `op` with fully typed `data` / `ref`.
 *
 * Dual API — data-first for `if` statements, data-last (curried) for pattern
 * matching with Effect's `Match` module:
 *
 * ```ts
 * // data-first
 * if (Atomic.targetsResource(operation, Article)) {
 *   switch (operation.op) {
 *     case "add":     operation.data.attributes.title   // typed
 *     case "update":  operation.data.id
 *     case "remove":  operation.ref
 *   }
 * }
 *
 * // data-last, with Match
 * Match.value(operation).pipe(
 *   Match.when(Atomic.targetsResource(Article), (op) => ...),
 *   ...
 * )
 * ```
 */
export const targetsResource: {
  <R extends Any>(
    resource: R
  ): (operation: unknown) => operation is ResourceOperationShape<R>
  <Op extends { readonly op: string }, R extends Any>(
    operation: Op,
    resource: R
  ): operation is TargetsResource<Op, R>
} = ((...args: ReadonlyArray<unknown>) =>
  isOperationValue(args[0])
    // data-first: (operation, resource)
    ? targetsResourceImpl(args[0], args[1] as Any)
    // data-last: (resource) => (operation) => ...
    : (operation: { readonly op: string }) => targetsResourceImpl(operation, args[0] as Any)) as never

/**
 * The structural shape of operations that target relationship `K` of resource
 * `R`: their `ref` names the resource type and the relationship.
 */
export type RelationshipOperationShape<R extends Any, K extends string> = {
  readonly ref: { readonly type: R["type"]; readonly relationship: K }
}

/**
 * The operations of `Op` that target relationship `K` of resource `R`.
 */
export type TargetsRelationship<Op, R extends Any, K extends string> = Extract<
  Op,
  RelationshipOperationShape<R, K>
>

const targetsRelationshipImpl = (
  operation: { readonly op: string },
  resource: Any,
  relationship: string
): boolean => {
  const ref = (operation as {
    readonly ref?: { readonly type?: unknown; readonly relationship?: unknown } | undefined
  }).ref
  return ref !== undefined && ref !== null && ref.type === resource.type && ref.relationship === relationship
}

/**
 * Type guard: does this operation target the given relationship of the given
 * resource?
 *
 * Narrows the operation union to exactly that relationship's operations, so
 * `data` has the right linkage type (one ref or `null` for to-one, an array
 * of refs for to-many).
 *
 * Dual API — data-first for `if` statements, data-last (curried) for pattern
 * matching with Effect's `Match` module:
 *
 * ```ts
 * // data-first
 * if (Atomic.targetsRelationship(operation, Article, "comments")) {
 *   operation.op      // "add" | "update" | "remove"
 *   operation.data    // ReadonlyArray<comment ref>
 * }
 *
 * // data-last, with Match
 * Match.value(operation).pipe(
 *   Match.when(Atomic.targetsRelationship(Comment, "author"), (op) => {
 *     op.data           // person ref | null
 *   }),
 *   ...
 * )
 * ```
 */
export const targetsRelationship: {
  <R extends Any, const K extends RelationshipKeys<R>>(
    resource: R,
    relationship: K
  ): (operation: unknown) => operation is RelationshipOperationShape<R, K>
  <Op extends { readonly op: string }, R extends Any, const K extends RelationshipKeys<R>>(
    operation: Op,
    resource: R,
    relationship: K
  ): operation is TargetsRelationship<Op, R, K>
} = ((...args: ReadonlyArray<unknown>) =>
  isOperationValue(args[0])
    // data-first: (operation, resource, relationship)
    ? targetsRelationshipImpl(args[0], args[1] as Any, args[2] as string)
    // data-last: (resource, relationship) => (operation) => ...
    : (operation: { readonly op: string }) =>
      targetsRelationshipImpl(operation, args[0] as Any, args[1] as string)) as never
