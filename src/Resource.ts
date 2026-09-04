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
import { Effect, Schema, SchemaAST, SchemaIssue, SchemaTransformation, Struct } from "effect"
import { AnyMeta, CollectionDocument, DataDocument, ResourceLinks } from "./Document.js"
import * as Filter from "./Filter.js"
import { resolveOperators } from "./internal/operators.js"
import * as Relationship from "./Relationship.js"
import type { Relationships, RelationshipSchemas } from "./Relationship.js"
import * as Sort from "./Sort.js"

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
  // Resource definitions are themselves callable (schemas are functions), so
  // `typeof resource === "function"` no longer distinguishes a resource from a
  // lazy thunk. `type` is a resource-only own property (never present on a
  // plain `() => R` thunk), so check for that instead.
  const thunk: () => R =
    typeof resource === "function" && !("type" in resource) ? (resource as () => R) : () => resource as R
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
// Per-attribute projection descriptors
// ---------------------------------------------------------------------------

// The annotation key under which an attribute schema carries its projection
// descriptor at *runtime* — stamped by `attribute`, read back by `make` and the
// Atomic module. Namespaced so it never collides with a consumer's own
// annotations.
const AttributeDescriptorAnnotationId = "@thomasfosterau/effect-jsonapi/attribute"

// The phantom property key carrying the descriptor config at the *type* level.
// It is never present at runtime; it exists only so the create/update
// projections can read an attribute's config from its schema type.
type AttributeConfigKey = "~@thomasfosterau/effect-jsonapi/attribute"

/**
 * Whether attributes appear in a write projection (the create/update payloads
 * and flat inputs):
 *
 *   - `"required"` — a required key (create only);
 *   - `"optional"` — a `Schema.optional` key: absent, or present with a value
 *     or `undefined` (an explicit `undefined` is "not supplied", and collapses
 *     into an absent key on a JSON wire);
 *   - `false` — excluded from the projection entirely.
 *
 * @since 0.5.0
 * @category type-level
 */
export type AttributePresence = "required" | "optional" | false

/**
 * The `filter` option of {@link attribute} / {@link readOnlyAttribute} — sugar
 * for `Filter.able`:
 *
 *   - `true` — every operator in the core (`Filter.operators`);
 *   - an array of operator names — that subset, in the order given;
 *   - `false` (the default) — not filterable.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterDeclaration = boolean | ReadonlyArray<Filter.Operator>

/**
 * The type-level config carried by an {@link Attribute}: the base schema, how
 * the attribute appears in each write projection, and whether it appears on the
 * resource object at all (`resource: false` marks an **input-only** attribute).
 * (The `filter` / `sort` declarations are not here — they ride on the schema
 * itself, as `Filter.able` / `Sort.able` markers.)
 *
 * @since 0.5.0
 * @category type-level
 */
export interface AttributeConfig<
  S extends Schema.Top,
  Create extends AttributePresence,
  Update extends "optional" | false,
  Clearable extends boolean,
  Resource extends boolean | "optional" = true
> {
  readonly schema: S
  readonly resource: Resource
  readonly create: Create
  readonly update: Update
  readonly clearable: Clearable
}

/**
 * Whether a schema is `Schema.NullOr<...>` (nullable) — the default for an
 * attribute's `clearable` flag.
 *
 * @since 0.5.0
 * @category type-level
 */
export type IsNullable<S extends Schema.Top> = S extends Schema.NullOr<Schema.Top> ? true : false

/**
 * The resource-object projection of an {@link Attribute}: the base schema when
 * `Resource` is `true`, or an optional key when `Resource` is `"optional"`.
 * (An input-only attribute — `Resource` `false` — is left as the base schema
 * here; {@link ResourceAttributes} drops it from the resource object.)
 *
 * @since 0.5.0
 * @category type-level
 */
export type AttributeResourceField<
  S extends Schema.Top,
  Resource extends boolean | "optional"
> = Resource extends "optional" ? Schema.optionalKey<S> : S

/**
 * A per-attribute **projection descriptor**: the resource-object schema for an
 * attribute, tagged with a type-level marker describing how the attribute
 * appears in each write projection. Build one with {@link attribute} (or a
 * shorthand such as {@link readOnlyAttribute}).
 *
 * Structurally it *is* the resource-object schema (the base schema, or an
 * `optionalKey` of it when `Resource` is `"optional"`), so the attribute behaves
 * normally everywhere a resource is surfaced — the resource `Schema.Struct`, its
 * `Document`s, {@link attributeKeys}, {@link attributeAnnotations}, sparse
 * `fields`, `include` — and is carried through {@link extend}. The four write
 * projections ({@link CreatePayload}, {@link UpdatePayload}, {@link CreateInput},
 * {@link UpdateInput}) read the marker to include, exclude or re-shape the
 * attribute. An **input-only** attribute (`Resource` `false`) is the exception:
 * {@link ResourceAttributes} drops it from the resource object altogether, so it
 * exists only in the write projections its `create` / `update` settings admit.
 * A `filter` / `sort` declaration is not part of the descriptor: it rides on `S`
 * itself (`Filter.able` / `Sort.able`), and {@link filterable} / {@link sortable}
 * read it through the descriptor.
 *
 * @since 0.5.0
 * @category models
 */
export type Attribute<
  S extends Schema.Top,
  Resource extends boolean | "optional" = true,
  Create extends AttributePresence = "required",
  Update extends "optional" | false = "optional",
  Clearable extends boolean = IsNullable<S>
> = AttributeResourceField<S, Resource> & {
  readonly [K in AttributeConfigKey]: AttributeConfig<S, Create, Update, Clearable, Resource>
}

/**
 * A read-only (server-set) attribute — shorthand for an {@link Attribute} that
 * is excluded from every write projection (`{ create: false, update: false }`).
 *
 * @since 0.5.0
 * @category models
 */
export type ReadOnlyAttribute<S extends Schema.Top> = Attribute<S, true, false, false, IsNullable<S>>

/**
 * Resolves an attribute's `clearable` flag: the explicit option when given,
 * otherwise whether the base schema is nullable.
 */
type ResolveClearable<S extends Schema.Top, Clearable extends boolean | undefined> = [Clearable] extends [boolean]
  ? Clearable
  : IsNullable<S>

// The `filter` / `sort` sugar of `attribute` at the type level: the same markers
// `Filter.able` / `Sort.able` stamp, applied in that order, so both spellings
// produce one type. `false` (the default) leaves the schema untouched.
type WithFilter<S extends Schema.Top, D extends FilterDeclaration, Literal> = [D] extends [false]
  ? S
  : Filter.Declared<S, DeclaredOperators<D, Filter.Operator>, Literal>
type WithSort<S extends Schema.Top, Sortable extends boolean> = [Sortable] extends [true] ? Sort.Declared<S> : S
type Declare<S extends Schema.Top, D extends FilterDeclaration, Sortable extends boolean, Literal> = WithSort<
  WithFilter<S, D, Literal>,
  Sortable
>

// Refuses, at the type level, a schema that already carries the marker the
// sugar would stamp again (`never` makes the `schema` argument unassignable).
type NotAlready<S, Key extends string, Given> = [Given] extends [false]
  ? unknown
  : S extends { readonly [K in Key]: unknown }
    ? never
    : unknown

// Refuses, at the type level, a `resource` option that is not a literal: a
// plain `boolean` would leave the attribute on the resource-object *type* while
// the runtime dropped it (`ResourceAttributes` reads the literal off the
// config), so the option must be `true`, `false` or `"optional"` statically.
type LiteralResource<R> = boolean extends R ? never : unknown

// The `filter` / `sort` sugar at runtime: `Filter.able` then `Sort.able` on the
// inner schema — the annotation is the only record of the declaration. A schema
// that already carries the declaration the sugar would stamp is refused: the
// sugar would silently override it (and the type-level markers would clash).
const declare = (
  schema: Schema.Top,
  options:
    | {
        readonly filter?: FilterDeclaration | undefined
        readonly filterLiteral?: Schema.Codec<unknown, string> | undefined
        readonly sort?: boolean | undefined
      }
    | undefined
): Schema.Top => {
  let declared = schema
  const filter = options?.filter
  if (filter !== undefined && filter !== false) {
    if (annotationAt(schema.ast, Filter.AnnotationId) !== undefined) {
      throw new Error(
        "Resource.attribute: the schema is already Filter.able; drop the `filter` option or the pipe, not both"
      )
    }
    declared =
      options?.filterLiteral === undefined
        ? Filter.able(filter)(declared)
        : Filter.able(filter, { literal: options.filterLiteral })(declared)
  } else if (options?.filterLiteral !== undefined) {
    throw new Error(
      "Resource.attribute: `filterLiteral` given without `filter`; declare the operators the literal is for"
    )
  }
  if (options?.sort === true) {
    if (annotationAt(schema.ast, Sort.AnnotationId) !== undefined) {
      throw new Error(
        "Resource.attribute: the schema is already Sort.able; drop the `sort` option or the pipe, not both"
      )
    }
    declared = Sort.able()(declared)
  }
  return declared
}

/**
 * Defines a per-attribute **projection descriptor**, controlling how a single
 * attribute appears in the resource object versus the write projections.
 *
 * Options (all optional; the defaults reproduce a plain `Schema` attribute):
 *
 *   - `resource` — presence in the resource object schema + documents, as a
 *     literal (a non-literal `boolean` is a compile error — the resource-object
 *     type has to be decided statically): `true` (default, required),
 *     `"optional"` (an optional key), or `false`
 *     (**input-only**: absent from the resource object, its documents,
 *     {@link attributeKeys}, sparse `fields` and the {@link filterable} /
 *     {@link sortable} accessors, yet still projected into the write inputs
 *     per `create` / `update` — an upload's file, a password, a one-time
 *     token). An input-only attribute must keep at least one write projection,
 *     and cannot carry a `filter` / `sort` declaration; {@link make} throws
 *     otherwise, naming the attribute.
 *   - `create` — presence in `createPayload` / `createInput`: `"required"`
 *     (default), `"optional"` (a `Schema.optional` key — absent, a value, or an
 *     explicit `undefined`, matching the update projection's shape so the same
 *     `{ x: maybeUndefined }` input fits both; on a JSON wire `undefined` and
 *     absent are the same), or `false` (excluded).
 *   - `update` — presence in `updatePayload` / `updateInput`: `"optional"`
 *     (default, tri-state) or `false` (excluded).
 *   - `clearable` — whether the update projection additionally accepts `null`
 *     to clear the value. Defaults to whether the schema is `Schema.NullOr`;
 *     setting it `true` wraps a non-nullable schema in `Schema.NullOr` for the
 *     update projection only.
 *
 * Whether the attribute may appear in `?filter[...]=` / `?sort=` is declared on
 * the schema itself, by piping it through `Filter.able` / `Sort.able` — see
 * {@link filterable} and {@link sortable}. Three further options are sugar for
 * exactly those calls on the inner schema, and stamp nothing else:
 *
 *   - `filter` — `true` (every operator in `Filter.operators`), an array of
 *     operator names (that subset), or `false` (default); `Filter.able(filter)`.
 *   - `filterLiteral` — an explicit `Codec<Type, string>` for the wire literal,
 *     for the rare attribute whose encoded form is not a JSON scalar;
 *     `Filter.able(filter, { literal })`.
 *   - `sort` — `true` to allow `?sort=`; `Sort.able()`.
 *
 * The descriptor rides on the attribute's schema value, so it is carried through
 * {@link extend} and read by {@link make}, the Atomic operations and the
 * {@link filterable} / {@link sortable} accessors.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     // server-set: on the resource + documents, never a write input
 *     createdAt: Resource.attribute(Schema.Date, { create: false, update: false }),
 *     // set at create, optional thereafter, clearable on update
 *     summary: Resource.attribute(Schema.NullOr(Schema.String), { create: "optional" }),
 *     // input-only: accepted at create, never on the resource object
 *     coverUpload: Resource.attribute(Schema.Uint8Array, { resource: false, update: false }),
 *     // filterable with a subset of operators, and sortable — declared on the schema
 *     priceCents: Resource.attribute(Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt]), Sort.able()), {
 *       create: "optional"
 *     }),
 *     // the same declaration, as sugar: `filter` / `sort` apply Filter.able / Sort.able
 *     status: Resource.attribute(Schema.Literals(["draft", "published"]), { filter: true, sort: true })
 *   }
 * })
 *
 * Resource.attributeKeys(Article) // ["title", "createdAt", "summary", "priceCents", "status"] — no coverUpload
 * Object.keys(Article.createInput.fields) // ["title", "summary", "coverUpload", "priceCents", "status"]
 * Object.keys(Resource.filterable(Article)) // ["priceCents", "status"]
 * Resource.sortable(Article) // ["priceCents", "status"]
 * ```
 *
 * @since 0.5.0
 * @category constructors
 */
export const attribute = <
  S extends Schema.Top,
  const Resource extends boolean | "optional" = true,
  const Create extends AttributePresence = "required",
  const Update extends "optional" | false = "optional",
  const Clearable extends boolean | undefined = undefined,
  const FilterDecl extends FilterDeclaration = false,
  const Sortable extends boolean = false,
  Literal = FilterLiteralType<S>
>(
  // `Literal` is inferred from `filterLiteral` and, as for `Filter.able`, the
  // schema's `Type` must fit it; a schema already `Filter.able` / `Sort.able`
  // is refused when the corresponding sugar option is given.
  schema: S & { readonly Type: NoInfer<Literal> | null } & NotAlready<S, Filter.MarkerKey, FilterDecl> &
    NotAlready<S, Sort.MarkerKey, Sortable>,
  options?: {
    // A literal only: a non-literal `boolean` cannot decide, at the type level,
    // whether the attribute is on the resource object.
    readonly resource?: Resource & LiteralResource<Resource>
    readonly create?: Create
    readonly update?: Update
    readonly clearable?: Clearable
    readonly filter?: FilterDecl
    readonly filterLiteral?: Schema.Codec<Literal, string>
    readonly sort?: Sortable
  }
): Attribute<Declare<S, FilterDecl, Sortable, Literal>, Resource, Create, Update, ResolveClearable<S, Clearable>> => {
  const resource = (options?.resource ?? true) as boolean | "optional"
  const create = (options?.create ?? "required") as AttributePresence
  const update = (options?.update ?? "optional") as "optional" | false
  const clearable = options?.clearable ?? isNullable(schema)
  const declared = declare(schema, options)
  const config: RuntimeAttributeConfig = { schema: declared, resource, create, update, clearable }
  // An input-only attribute (`resource: false`) still has to be *some* schema
  // value in the declared map — `make` drops it from the resource object.
  const resourceField = resource === "optional" ? Schema.optionalKey(declared) : declared
  return resourceField.annotate({ [AttributeDescriptorAnnotationId]: config }) as unknown as Attribute<
    Declare<S, FilterDecl, Sortable, Literal>,
    Resource,
    Create,
    Update,
    ResolveClearable<S, Clearable>
  >
}

/**
 * Marks an attribute as **read-only** (server-set): present in the resource
 * object schema and its documents, but excluded from the create/update payloads
 * (`createPayload` / `updatePayload`) and the flat create/update inputs
 * (`createInput` / `updateInput`). Shorthand for
 * `Resource.attribute(schema, { create: false, update: false })`.
 *
 * Use it for attributes the server computes, assigns or derives — version-chain
 * timestamps (`createdAt`, `updatedAt`, `publishedAt`, `deletedAt`), counters,
 * computed state — that appear in responses but must never be accepted as client
 * input. A plain `Schema` attribute stays read-write exactly as before, so this
 * is fully opt-in and non-breaking.
 *
 * The attribute keeps the underlying schema's behaviour everywhere it is
 * surfaced (the resource object, documents, {@link attributeKeys},
 * {@link attributeAnnotations}, sparse `fields`, `include`) and is carried
 * through {@link extend}.
 *
 * Server-set timestamps are the attributes most often filtered and sorted on:
 * declare that on the schema with `Filter.able` / `Sort.able` (or the
 * equivalent `filter` / `filterLiteral` / `sort` sugar of {@link attribute},
 * accepted here too).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     // on the resource + in documents, never a create/update input:
 *     createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Filter.able(["gte", "lt"]), Sort.able()))
 *   }
 * })
 *
 * // Article.Type.attributes                  → { title, createdAt }
 * // Article.createPayload.Type … attributes  → { title }
 * // Article.updatePayload.Type … attributes  → { title? }
 * // Article.createInput.Type                 → { title }
 * // Article.updateInput.Type                 → { id, title? }
 * Resource.filterable(Article).createdAt.operators // ["gte", "lt"]
 * Resource.sortable(Article) // ["createdAt"]
 * ```
 *
 * @since 0.5.0
 * @category constructors
 */
export const readOnlyAttribute = <
  S extends Schema.Top,
  const FilterDecl extends FilterDeclaration = false,
  const Sortable extends boolean = false,
  Literal = FilterLiteralType<S>
>(
  schema: S & { readonly Type: NoInfer<Literal> | null } & NotAlready<S, Filter.MarkerKey, FilterDecl> &
    NotAlready<S, Sort.MarkerKey, Sortable>,
  options?: {
    readonly filter?: FilterDecl
    readonly filterLiteral?: Schema.Codec<Literal, string>
    readonly sort?: Sortable
  }
): ReadOnlyAttribute<Declare<S, FilterDecl, Sortable, Literal>> =>
  attribute(schema as Schema.Top, {
    ...options,
    filterLiteral: options?.filterLiteral as Schema.Codec<unknown, string> | undefined,
    create: false,
    update: false
  }) as unknown as ReadOnlyAttribute<Declare<S, FilterDecl, Sortable, Literal>>

// The runtime shape of an attribute's descriptor, stored under
// `AttributeDescriptorAnnotationId`. `schema` is the inner (declared) schema:
// the `filter` / `sort` declarations are its own `Filter.able` / `Sort.able`
// annotations, not descriptor fields.
interface RuntimeAttributeConfig {
  readonly schema: Schema.Top
  readonly resource: boolean | "optional"
  readonly create: AttributePresence
  readonly update: "optional" | false
  readonly clearable: boolean
}

// The non-null member of a `Schema.NullOr(...)` — a two-member union with a
// `Null` member — at the AST level; `undefined` for anything else. The one
// definition of "nullable" the runtime shares: `isNullable`, `nonNullableBase`
// and the declaration readers all go through it.
const nullableBaseAst = (ast: SchemaAST.AST): SchemaAST.AST | undefined =>
  ast._tag === "Union" && ast.types.length === 2 && ast.types.some((member) => member._tag === "Null")
    ? ast.types.find((member) => member._tag !== "Null")
    : undefined

// Whether a schema is a two-member `Schema.NullOr(...)` union, at runtime.
const isNullable = (schema: Schema.Top): boolean => nullableBaseAst(schema.ast) !== undefined

// The base schema of a `Schema.NullOr(...)` — the member whose AST is the
// non-null one — or the schema itself if it is not a nullable union.
const nonNullableBase = (schema: Schema.Top): Schema.Top => {
  const baseAst = nullableBaseAst(schema.ast)
  if (baseAst === undefined) return schema
  const members = (schema as { readonly members?: ReadonlyArray<Schema.Top> }).members
  return members?.find((member) => member.ast === baseAst) ?? schema
}

// Wraps a schema in `Schema.NullOr` unless it is already nullable.
const ensureNullable = (schema: Schema.Top): Schema.Top => (isNullable(schema) ? schema : Schema.NullOr(schema))

// Reads an attribute's runtime projection descriptor, or `undefined` for a plain
// schema attribute (which projects with the read-write defaults).
const descriptorOf = (schema: Schema.Top): RuntimeAttributeConfig | undefined =>
  Schema.resolveAnnotations(schema)?.[AttributeDescriptorAnnotationId] as RuntimeAttributeConfig | undefined

// Whether an attribute field is input-only (`resource: false`): declared for
// the write projections, absent from the resource object.
const isInputOnly = (field: Schema.Top): boolean => descriptorOf(field)?.resource === false

// Builds the resource-object field map for a resource's declared attribute
// fields: every attribute except the input-only ones (`resource: false`), each
// kept as declared (a plain schema, or the descriptor's resource-object field —
// the base schema, or an `optionalKey` of it for `resource: "optional"`). Used
// by `make` for the resource `Schema.Struct`.
const resourceAttributeFields = (fields: Schema.Struct.Fields): Record<string, Schema.Top> => {
  const result: Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (isInputOnly(field as Schema.Top)) continue
    result[key] = field as Schema.Top
  }
  return result
}

// The schema a bare `Schema.optionalKey(S)` attribute wraps (`S`), or
// `undefined` for anything else — a required field, or a field that already
// admits `undefined` (`Schema.optional(S)` is `optionalKey(UndefinedOr(S))`),
// which needs no widening.
const strictOptionalInner = (field: Schema.Top): Schema.Top | undefined => {
  if (field.ast.context?.isOptional !== true) return undefined
  const wrapped = (field as { readonly schema?: Schema.Top }).schema
  if (wrapped === undefined) return undefined
  const ast = wrapped.ast
  const admitsUndefined = ast._tag === "Union" && ast.types.some((member) => member._tag === "Undefined")
  return admitsUndefined ? undefined : wrapped
}

/**
 * Builds the **create** field map for a resource's attribute fields: each
 * attribute projected by its descriptor (`create: false` excluded, `"optional"`
 * a `Schema.optional` — the key may be absent or its value `undefined`, as in
 * the update projection — `"required"` a required key). A plain schema
 * attribute is required, except a bare `Schema.optionalKey(S)`, which projects
 * as `Schema.optional(S)` too (the update projection already widens it, so the
 * same `{ x: maybeUndefined }` input fits both). Used by `createPayload` /
 * `createInput` and the Atomic `add` operation.
 *
 * @since 0.5.0
 * @category utilities
 */
export const createAttributeFields = (fields: Schema.Struct.Fields): Record<string, Schema.Top> => {
  const result: Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(fields)) {
    const descriptor = descriptorOf(field as Schema.Top)
    if (!descriptor) {
      const inner = strictOptionalInner(field as Schema.Top)
      result[key] = inner === undefined ? (field as Schema.Top) : Schema.optional(inner)
      continue
    }
    if (descriptor.create === false) continue
    result[key] = descriptor.create === "optional" ? Schema.optional(descriptor.schema) : descriptor.schema
  }
  return result
}

/**
 * Builds the **update** field map for a resource's attribute fields: each
 * attribute as a tri-state `Schema.optional` (`update: false` excluded),
 * additionally accepting `null` when the descriptor is `clearable`. A plain
 * schema attribute becomes `Schema.optional(schema)`. Used by `updatePayload` /
 * `updateInput` and the Atomic `update` operation.
 *
 * @since 0.5.0
 * @category utilities
 */
export const updateAttributeFields = (fields: Schema.Struct.Fields): Record<string, Schema.Top> => {
  const result: Record<string, Schema.Top> = {}
  for (const [key, field] of Object.entries(fields)) {
    const descriptor = descriptorOf(field as Schema.Top)
    if (!descriptor) {
      result[key] = Schema.optional(field as Schema.Top)
      continue
    }
    if (descriptor.update === false) continue
    const base = descriptor.clearable ? ensureNullable(descriptor.schema) : nonNullableBase(descriptor.schema)
    result[key] = Schema.optional(base)
  }
  return result
}

// ---------------------------------------------------------------------------
// Type-level write projections
// ---------------------------------------------------------------------------

// The descriptor config carried by an attribute field, or `undefined` for a
// plain schema attribute.
type ConfigOf<F> = F extends { readonly [K in AttributeConfigKey]: infer C } ? C : undefined

// The update value schema for a descriptor: nullable when `clearable`, the
// non-null base otherwise.
type UpdateValueSchema<S extends Schema.Top, Clearable extends boolean> = Clearable extends true
  ? S extends Schema.NullOr<Schema.Top>
    ? S
    : Schema.NullOr<S>
  : S extends Schema.NullOr<infer X extends Schema.Top>
    ? X
    : S

/**
 * The **resource-object** attribute field map derived from a resource's declared
 * attribute fields: every attribute except the input-only ones (`resource:
 * false`), each as declared. This is what the resource `Schema.Struct` carries
 * under `attributes`, so it is also what {@link AttributeKeys},
 * {@link AttributesOf}, sparse fieldsets and the documents see; the declared map
 * (with the input-only attributes) stays reachable as
 * {@link DeclaredAttributesOf} / `declaredAttributes`.
 *
 * @since 0.14.0
 * @category type-level
 */
export type ResourceAttributes<Attributes extends Schema.Struct.Fields> = AsFields<{
  readonly [K in keyof Attributes as ConfigOf<Attributes[K]> extends { readonly resource: false }
    ? never
    : K]: Attributes[K]
}>

/**
 * The **create** attribute field map derived from a resource's attribute fields:
 * each attribute projected by its descriptor — `create: false` removed,
 * `"optional"` made a `Schema.optional` (the key may be absent, or present as
 * `undefined` — the same shape {@link UpdateAttributes} gives every attribute,
 * so a caller building `{ x: maybeUndefined }` type-checks against both),
 * `"required"` (and plain schema attributes) a required key. A bare
 * `Schema.optionalKey<S>` attribute is widened to `Schema.optional<S>` the same
 * way; a bare `Schema.optional<S>` already is one and stays as declared.
 *
 * **On the wire.** JSON cannot carry `undefined`, so over a JSON:API HTTP body an
 * explicit `undefined` and an absent key are the same thing — the attribute is
 * simply not supplied. The distinction exists in-process and for codec-based
 * transports (RPC / remote functions) that preserve `undefined`, exactly as for
 * {@link PartialAttributes}.
 *
 * @since 0.5.0
 * @category type-level
 */
export type CreateAttributes<Attributes extends Schema.Struct.Fields> = AsFields<{
  readonly [K in keyof Attributes as ConfigOf<Attributes[K]> extends { readonly create: false } ? never : K]: ConfigOf<
    Attributes[K]
  > extends AttributeConfig<infer S, infer C, any, any, any>
    ? C extends "optional"
      ? Schema.optional<S>
      : S
    : Attributes[K] extends Schema.optional<any>
      ? Attributes[K]
      : Attributes[K] extends Schema.optionalKey<infer S extends Schema.Top>
        ? Schema.optional<S>
        : Attributes[K]
}>

/**
 * The **update** attribute field map derived from a resource's attribute fields:
 * each non-excluded attribute as a tri-state {@link PartialAttributes} entry
 * (`update: false` removed), additionally accepting `null` when `clearable`.
 *
 * @since 0.5.0
 * @category type-level
 */
export type UpdateAttributes<Attributes extends Schema.Struct.Fields> = AsFields<{
  readonly [K in keyof Attributes as ConfigOf<Attributes[K]> extends { readonly update: false } ? never : K]: ConfigOf<
    Attributes[K]
  > extends AttributeConfig<infer S, any, "optional", infer Cl, any>
    ? Schema.optional<UpdateValueSchema<S, Cl>>
    : Schema.optional<Attributes[K]>
}>

// ---------------------------------------------------------------------------
// The resource definition
// ---------------------------------------------------------------------------

/**
 * The field map of a resource object schema. `attributes` is the
 * {@link ResourceAttributes} projection of the declared map: input-only
 * attributes (`resource: false`) are not on the resource object.
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
  readonly attributes: Schema.Struct<ResourceAttributes<Attributes>>
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
    readonly attributes: Schema.Struct<CreateAttributes<Attributes>>
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
    readonly attributes: Schema.optionalKey<Schema.Struct<UpdateAttributes<Attributes>>>
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
export interface CreateInput<Attributes extends Schema.Struct.Fields> extends Schema.Struct<
  CreateAttributes<Attributes>
> {}

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
> extends Schema.Struct<AsFields<Omit<UpdateAttributes<Attributes>, "id"> & { readonly id: IdSchema }>> {}

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
  /**
   * The attribute field map **as declared** — including input-only attributes
   * (`resource: false`), which the resource object's `fields.attributes` omits.
   * This is the map the write projections are derived from, and what
   * {@link extend} inherits.
   */
  readonly declaredAttributes: Attributes
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
 * The attribute field map of a resource definition's **resource object** — the
 * `Schema.Struct.Fields` record under its `attributes` member: every declared
 * attribute except the input-only ones (`resource: false`).
 *
 * The type-level counterpart of {@link attributes}; spread the runtime value
 * into another resource's `attributes` to reuse a resource's attribute schemas.
 * For the map *as declared*, input-only attributes included, see
 * {@link DeclaredAttributesOf}.
 *
 * @since 0.2.0
 * @category type-level
 */
export type AttributesOf<R extends Any> = R["fields"]["attributes"]["fields"]

/**
 * The attribute field map of a resource definition **as declared** — the record
 * passed to {@link make}, including input-only attributes (`resource: false`)
 * that {@link AttributesOf} omits. The map the write projections and the Atomic
 * `add` / `update` operations derive from.
 *
 * A {@link Family} declares nothing itself: its declared map is its
 * resource-object map.
 *
 * @since 0.14.0
 * @category type-level
 */
export type DeclaredAttributesOf<R extends Any> = R extends {
  readonly declaredAttributes: infer Declared extends Schema.Struct.Fields
}
  ? Declared
  : AttributesOf<R>

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
 * How many hops into the relationship graph an `include` path may take. The
 * derivation defaults to 2 — the depth {@link IncludePath} models.
 *
 * @since 0.9.0
 * @category type-level
 */
export type IncludeDepth = 1 | 2 | 3

// The depth-3 walk: a relationship key, plus every depth-2 path of its target.
type IncludePathDepth3<R extends Any> = R extends Any
  ? {
      [K in IncludableKeys<R>]: K | `${K}.${IncludePath<Target<R, K>>}`
    }[IncludableKeys<R>]
  : never

/**
 * The legal `include` query parameter paths for a resource, bounded to `Depth`
 * hops into the relationship graph — the type-level mirror of
 * {@link includePaths}' `maxDepth`.
 *
 * `IncludePathsTo<R, 2>` is {@link IncludePath}, the default derivation.
 *
 * @since 0.9.0
 * @category type-level
 */
export type IncludePathsTo<R extends Any, Depth extends IncludeDepth> = R extends Any
  ? [Depth] extends [1]
    ? IncludableKeys<R>
    : [Depth] extends [3]
      ? IncludePathDepth3<R>
      : IncludePath<R>
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
 * The attribute field map of a resource definition's **resource object** — the
 * `Schema.Struct.Fields` record under its `attributes` member. Every declared
 * attribute is here except the input-only ones (`resource: false`), which are
 * not on the resource object; {@link declaredAttributes} returns the map as
 * declared, those included.
 *
 * Spread the result into another resource's `attributes` to reuse a resource's
 * attribute schemas (the runtime counterpart of {@link AttributesOf}). To
 * inherit a resource's attributes *and* relationships wholesale — input-only
 * attributes included — reach for {@link extend} instead.
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
 * The attribute field map of a resource definition **as declared** — the record
 * passed to {@link make}, including input-only attributes (`resource: false`)
 * that {@link attributes} omits because they are not on the resource object.
 * The runtime counterpart of {@link DeclaredAttributesOf}; what {@link extend}
 * inherits and the Atomic `add` / `update` operations project from.
 *
 * For a {@link Family}, which declares nothing itself, this is its resource-object
 * map.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Upload = Resource.make("uploads", {
 *   attributes: {
 *     fileName: Schema.NonEmptyString,
 *     // input-only: accepted at create, never on the resource object
 *     file: Resource.attribute(Schema.Uint8Array, { resource: false, update: false })
 *   }
 * })
 *
 * Object.keys(Resource.attributes(Upload)) // ["fileName"]
 * Object.keys(Resource.declaredAttributes(Upload)) // ["fileName", "file"]
 * ```
 *
 * @since 0.14.0
 * @category accessors
 */
export const declaredAttributes = <R extends Any>(resource: R): DeclaredAttributesOf<R> =>
  ((resource as { readonly declaredAttributes?: Schema.Struct.Fields }).declaredAttributes ??
    resource.fields.attributes.fields) as DeclaredAttributesOf<R>

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
// Filterable and sortable attributes
// ---------------------------------------------------------------------------

// The type-level marker `Filter.able` / `Sort.able` leave under `Key`, read off
// an attribute field: on the field itself, through an `optionalKey` wrapper,
// through a `Schema.NullOr` union (the non-null member — NULL is never a literal
// and never a sort key), or through the descriptor's inner schema. `never` when
// the field carries none. (`Schema.suspend` is opaque at the type level; the
// runtime readers below follow its thunk.)
type MarkerOf<F, Key extends string> = F extends { readonly [K in Key]: infer M }
  ? M
  : F extends Schema.optionalKey<infer X>
    ? MarkerOf<X, Key>
    : F extends Schema.NullOr<infer X>
      ? MarkerOf<X, Key>
      : ConfigOf<F> extends { readonly schema: infer X }
        ? MarkerOf<X, Key>
        : never

// The `Filter.able` declaration of an attribute field (`never` when undeclared)
// and whether the field is `Sort.able`.
type FilterMarkerOf<F> =
  MarkerOf<F, Filter.MarkerKey> extends infer M extends Filter.Marker<Filter.Operator, unknown> ? M : never
// (`never` — no marker — must be caught first: it satisfies any `extends`.)
type SortDeclarationOf<F> = [MarkerOf<F, Sort.MarkerKey>] extends [never]
  ? false
  : MarkerOf<F, Sort.MarkerKey> extends true
    ? true
    : false

// The `filter` declaration of a to-one relationship descriptor; `false` for
// to-many descriptors, which cannot be filter fields.
type RelationshipFilterDeclarationOf<D> = D extends {
  readonly kind: "one" | "optional"
  readonly filter: infer F extends Relationship.FilterDeclaration
}
  ? F
  : false

// The relationship keys declared filterable. A resource whose relationship
// names are not statically known (`Relationships` itself, as on a name-only
// family) declares none.
type FilterableRelationshipKeys<R extends Any> =
  string extends RelationshipName<R>
    ? never
    : {
        [K in RelationshipName<R>]: RelationshipFilterDeclarationOf<R["relationships"][K]> extends false ? never : K
      }[RelationshipName<R>]

// The operators a declaration admits: the whole set for `true`, the subset
// otherwise.
type DeclaredOperators<D, All extends string> = D extends true
  ? All
  : D extends ReadonlyArray<infer Op extends All>
    ? Op
    : never

/**
 * The keys of a resource declared filterable, as a union of string literals:
 * attributes whose schema is `Filter.able` (piped, or via the `filter` sugar of
 * `Resource.attribute`) and to-one relationships declared with
 * `Relationship.one(ref, { filter })` / `Relationship.optional(ref, { filter })`.
 * A plain schema attribute, a to-many relationship, or anything declared
 * without `filter`, is not filterable — the declaration fails closed, like
 * `include` / `fields` / `sort`.
 *
 * Resolved from the `Filter.able` marker alone, looked for on the attribute
 * schema itself and through `Schema.optionalKey` / `Schema.NullOr` around it.
 *
 * Distributes over unions of resource definitions.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterableKeys<R extends Any> = R extends Any
  ?
      | {
          [K in AttributeKeys<R>]: [FilterMarkerOf<AttributesOf<R>[K]>] extends [never] ? never : K
        }[AttributeKeys<R>]
      | FilterableRelationshipKeys<R>
  : never

/**
 * The operators a filterable key admits, as a union of string literals: for
 * `Filter.able()` / `filter: true`, every `Filter.Operator` on an attribute or
 * every `Relationship.FilterOperator` on a to-one relationship; otherwise
 * exactly the declared subset.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterOperators<R extends Any, K extends FilterableKeys<R>> =
  K extends AttributeKeys<R>
    ? FilterMarkerOf<AttributesOf<R>[K]>["operators"]
    : K extends RelationshipName<R>
      ? DeclaredOperators<RelationshipFilterDeclarationOf<R["relationships"][K]>, Relationship.FilterOperator>
      : never

/**
 * The attribute keys of a resource declared sortable — whose schema is
 * `Sort.able` (piped, or via the `sort: true` sugar of `Resource.attribute`) —
 * as a union of string literals. A plain schema attribute is not sortable.
 *
 * Distributes over unions of resource definitions.
 *
 * @since 0.13.0
 * @category type-level
 */
export type SortableKeys<R extends Any> = R extends Any
  ? {
      [K in AttributeKeys<R>]: SortDeclarationOf<AttributesOf<R>[K]> extends true ? K : never
    }[AttributeKeys<R>]
  : never

/**
 * The decoded type of a filter literal for an attribute schema: the schema's
 * own `Type`, minus `null` — `NULL` is never a literal (`isnull` names it), so
 * a `Schema.NullOr(X)` attribute's literals are `X`. An alias of
 * `Filter.LiteralType`.
 *
 * @since 0.13.0
 * @category type-level
 */
export type FilterLiteralType<S extends { readonly Type: unknown }> = Filter.LiteralType<S>

/**
 * One entry of {@link Filterable}: the operators a filterable key admits and
 * the codec between the wire literal (a string) and its decoded type — the
 * attribute's `Type` for an attribute, the target's id `Type` for a to-one
 * relationship.
 *
 * @since 0.13.0
 * @category models
 */
export interface FilterableField<Op extends Filter.Operator, Literal, RD = never, RE = never> {
  /** The declared operators, in declaration order (the whole set for `filter: true`). */
  readonly operators: ReadonlyArray<Op>
  /**
   * The literal codec: decodes a wire string to the field's `Type` (through the
   * attribute schema, so refinements and brands apply — or through the target's
   * `Id` schema for a relationship) and encodes it back.
   */
  readonly literal: Schema.Codec<Literal, string, RD, RE>
}

/**
 * The filterable fields of a resource definition: a record from each declared
 * key — attributes and to-one relationships alike — to its
 * {@link FilterableField}. Undeclared keys are absent, so the keys are exactly
 * {@link FilterableKeys}.
 *
 * @since 0.13.0
 * @category type-level
 */
export type Filterable<R extends Any> = {
  readonly [K in FilterableKeys<R>]: K extends AttributeKeys<R>
    ? FilterableField<
        FilterOperators<R, K>,
        FilterMarkerOf<AttributesOf<R>[K]>["literal"],
        AttributesOf<R>[K]["DecodingServices"],
        AttributesOf<R>[K]["EncodingServices"]
      >
    : FilterableField<FilterOperators<R, K>, Target<R, K>["Id"]["Type"]>
}

// The JSON scalar kinds a filter literal can take on the wire.
type ScalarKind = "string" | "number" | "boolean"

// Classifies the encoded (wire) form of an attribute schema as one JSON scalar
// kind, looking through `NullOr` unions (NULL is never a literal), literal
// unions and suspensions. `undefined` when the form is not a scalar (a struct,
// an array, a `Date` declaration, …) or mixes kinds.
const scalarKindOf = (ast: SchemaAST.AST): ScalarKind | undefined => {
  const kinds = new Set<ScalarKind>()
  const visit = (node: SchemaAST.AST): boolean => {
    switch (node._tag) {
      case "String":
        kinds.add("string")
        return true
      case "Number":
        kinds.add("number")
        return true
      case "Boolean":
        kinds.add("boolean")
        return true
      case "Null":
        return true
      case "Literal": {
        const kind = typeof node.literal
        if (kind !== "string" && kind !== "number" && kind !== "boolean") return false
        kinds.add(kind)
        return true
      }
      case "TemplateLiteral":
        // Encodes as a plain string; the template's own check applies on decode.
        kinds.add("string")
        return true
      case "Union":
        return node.types.every(visit)
      case "Suspend":
        return visit(node.thunk())
      default:
        return false
    }
  }
  if (!visit(ast) || kinds.size !== 1) return undefined
  return [...kinds][0]
}

// A strict decimal: an optional sign, digits with an optional fraction (or a
// bare fraction), an optional exponent. Deliberately narrower than `Number()`,
// which also accepts `""`, whitespace, hex, binary and octal forms.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

// Parses a wire literal as one scalar kind; `undefined` when it is not one.
const parseScalar = (kind: ScalarKind, input: string): string | number | boolean | undefined => {
  switch (kind) {
    case "string":
      return input
    case "number": {
      if (!DECIMAL.test(input)) return undefined
      const value = Number(input)
      return Number.isFinite(value) ? value : undefined
    }
    case "boolean":
      return input === "true" ? true : input === "false" ? false : undefined
  }
}

// The literal codec for an attribute whose encoded form is `kind`: wire string
// → scalar (strictly) → the attribute schema's own decoder, and the reverse on
// encode. `target` is the attribute schema with any `NullOr` stripped, so the
// codec's `Type` never includes `null`.
const scalarLiteral = (kind: ScalarKind, target: Schema.Top): Schema.Codec<unknown, string> =>
  Schema.String.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformOrFail<unknown, string>({
        decode: (input, options) => {
          const value = parseScalar(kind, input)
          return value === undefined
            ? Effect.fail(
                new SchemaIssue.InvalidValue(
                  { message: `Expected a ${kind} filter literal, got ${JSON.stringify(input)}` },
                  input,
                  options
                )
              )
            : Effect.succeed(value)
        },
        // `NaN` / `Infinity` are numbers `Schema.Number` admits but the decoder
        // above rejects; refusing them here keeps `decode ∘ encode` total.
        encode: (value, options) =>
          typeof value === kind && (kind !== "number" || Number.isFinite(value))
            ? Effect.succeed(String(value))
            : Effect.fail(
                new SchemaIssue.InvalidValue(
                  {
                    message:
                      value === null
                        ? "NULL is not a filter literal (use the isnull operator)"
                        : `Expected a ${kind} to encode as a filter literal, got ${JSON.stringify(value)}`
                  },
                  value,
                  options
                )
              )
      })
    )
  ) as unknown as Schema.Codec<unknown, string>

// Derives the literal codec for a filterable attribute from its schema, or
// throws when the schema's encoded form is not a JSON scalar. Called from
// `make`, so a bad declaration fails at definition time, naming the attribute.
const deriveFilterLiteral = (type: string, key: string, schema: Schema.Top): Schema.Codec<unknown, string> => {
  const base = nonNullableBase(schema)
  const kind = scalarKindOf(SchemaAST.toEncoded(base.ast))
  if (kind === undefined) {
    throw new Error(
      `Resource.make("${type}"): attribute "${key}" is declared filterable but its encoded form is not a JSON scalar ` +
        "(string, number, boolean, or Schema.NullOr of one); pass `filterLiteral` to supply the literal codec explicitly"
    )
  }
  return scalarLiteral(kind, base)
}

// The annotation under `id` on a schema node itself. Effect's `annotate` stamps
// the node's *last* check when it has checks (the node otherwise), and a later
// `.check(...)` appends a new last check without touching the earlier ones — so
// the declaration may sit on any check or on the node. Scan them all, most
// recent first, rather than only what `Schema.resolveAnnotations` reads.
const ownAnnotationAt = (ast: SchemaAST.AST, id: string): unknown => {
  if (ast.checks) {
    for (let index = ast.checks.length - 1; index >= 0; index--) {
      const found = ast.checks[index]?.annotations?.[id]
      if (found !== undefined) return found
    }
  }
  return ast.annotations?.[id]
}

// Resolves the annotation under `id` from an AST, looking through the wrappers
// an attribute schema may carry: a `Schema.suspend` (its thunk) and a
// `Schema.NullOr` union (the non-null member — NULL is never a literal and never
// a sort key). `optionalKey` needs no case: it keeps the wrapped schema's
// annotations.
const annotationAt = (ast: SchemaAST.AST, id: string): unknown => {
  const own = ownAnnotationAt(ast, id)
  if (own !== undefined) return own
  if (ast._tag === "Suspend") return annotationAt(ast.thunk(), id)
  const base = nullableBaseAst(ast)
  return base === undefined ? undefined : annotationAt(base, id)
}

// Reads a declaration (`Filter.able` / `Sort.able`) off an attribute field via
// its annotations — on the field itself (the descriptor's `annotate` merges
// with, never replaces, the declaration's), else through the wrappers above,
// else on the descriptor's inner schema (a descriptor stamped by hand).
const declarationOf = (field: Schema.Top, id: string): unknown => {
  const found = annotationAt(field.ast, id)
  if (found !== undefined) return found
  const inner = descriptorOf(field)?.schema
  return inner === undefined ? undefined : annotationAt(inner.ast, id)
}

// The schema an attribute field wraps, for deriving its literal codec: the
// descriptor's inner schema for a field built by `attribute`, the wrapped
// schema of a bare `Schema.optionalKey`, otherwise the field itself.
const attributeSchemaOf = (field: Schema.Top): Schema.Top => {
  const descriptor = descriptorOf(field)
  if (descriptor !== undefined) return descriptor.schema
  const wrapped = (field as { readonly schema?: Schema.Top }).schema
  return wrapped !== undefined && field.ast.context?.isOptional === true ? wrapped : field
}

// Whether a value read from under `Filter.AnnotationId` is a well-formed
// declaration: a non-empty list of operators from the closed core, and a
// literal that is absent or a schema.
const isFilterAnnotation = (u: unknown): u is Filter.Annotation => {
  if (typeof u !== "object" || u === null) return false
  const { operators, literal } = u as { readonly operators?: unknown; readonly literal?: unknown }
  return (
    Array.isArray(operators) &&
    operators.length > 0 &&
    operators.every(Filter.isOperator) &&
    (literal === undefined || Schema.isSchema(literal))
  )
}

// The sortable keys of a resource's attribute fields, in declaration order. A
// present-but-malformed sort annotation (anything but `true`) is a definition
// error naming the attribute, as a malformed filter annotation is.
const sortableKeys = (type: string, fields: Schema.Struct.Fields): ReadonlyArray<string> => {
  const keys: Array<string> = []
  for (const [key, field] of Object.entries(fields)) {
    const declaration = declarationOf(field as Schema.Top, Sort.AnnotationId)
    if (declaration === undefined) continue
    if (declaration !== true) {
      throw new Error(
        `Resource.make("${type}"): attribute "${key}" carries a malformed sort declaration under ` +
          `"${Sort.AnnotationId}"; declare it with Sort.able`
      )
    }
    keys.push(key)
  }
  return keys
}

// The sortable keys of each resource, built once by `make` (where a malformed
// declaration throws) and shared by the accessor; keyed like `filterableCache`.
const sortableCache = new WeakMap<object, ReadonlyArray<string>>()

// The runtime shape of one `filterable` entry.
interface RuntimeFilterable {
  readonly operators: ReadonlyArray<Filter.Operator>
  readonly literal: Schema.Codec<unknown, string>
}

// Builds the filterable record for a resource: each attribute carrying a
// `Filter.able` annotation with its derived (or explicit `literal`) codec, then
// each declared to-one relationship with the target's `Id` schema as its
// literal codec. The target is resolved lazily (`Schema.suspend` over the
// descriptor's thunk), never here: definitions can be mutually recursive and
// out of order.
const filterableFields = (
  type: string,
  fields: Schema.Struct.Fields,
  relationships: Relationships
): Record<string, RuntimeFilterable> => {
  const result: Record<string, RuntimeFilterable> = {}
  for (const [key, field] of Object.entries(fields)) {
    const declaration = declarationOf(field as Schema.Top, Filter.AnnotationId)
    if (declaration === undefined) continue
    if (!isFilterAnnotation(declaration)) {
      throw new Error(
        `Resource.make("${type}"): attribute "${key}" carries a malformed filter declaration under ` +
          `"${Filter.AnnotationId}"; declare it with Filter.able`
      )
    }
    result[key] = {
      operators: declaration.operators,
      literal: declaration.literal ?? deriveFilterLiteral(type, key, attributeSchemaOf(field as Schema.Top))
    }
  }
  for (const [key, descriptor] of Object.entries(relationships)) {
    if (!Relationship.isToOne(descriptor) || !descriptor.filter) continue
    result[key] = {
      operators: resolveOperators(
        descriptor.filter,
        Relationship.FilterOperator,
        `Resource.make("${type}"): relationship "${key}"`
      ),
      literal: Schema.suspend(() => descriptor.ref().Id) as unknown as Schema.Codec<unknown, string>
    }
  }
  return result
}

// The filterable record of each resource, built once by `make` (which is where
// a bad declaration throws) and shared by the accessor. Keyed by the attribute
// struct so a base-anchored family (whose attributes *are* its base's, as are
// its relationships) reads the base's declaration.
const filterableCache = new WeakMap<object, Record<string, RuntimeFilterable>>()

// The attribute structs of name-only families: synthesised by intersection, so
// they carry no declaration of their own — nothing is filterable or sortable.
const nameOnlyFamilyAttributes = new WeakSet<object>()

/**
 * The filterable fields of a resource definition, at runtime: a read-only
 * record from each key declared filterable — an attribute whose schema is
 * `Filter.able` (piped, or via the `filter` sugar of {@link attribute}), a
 * to-one relationship via `Relationship.one(ref, { filter })` /
 * `Relationship.optional(ref, { filter })` — to its operator list and literal
 * codec. Undeclared keys are absent, so `Object.keys` is the filterable set —
 * empty when nothing is declared.
 *
 * The declaration is read from the attribute schema's `Filter.AnnotationId`
 * annotation, the single source of truth: on the schema itself (its node and
 * every check, so a `.check(...)` applied after `Filter.able` does not hide it),
 * and through a `Schema.optionalKey` wrapper, a `Schema.NullOr` union (its
 * non-null member), a `Schema.suspend`, or the descriptor an {@link attribute}
 * carries. Annotate last for the types: any rebuild drops the type-level marker
 * (see `Filter.able`).
 *
 * An attribute's literal codec is derived from its schema's encoded form: a wire
 * string is parsed strictly as that scalar (`number` accepts only a finite
 * decimal, `boolean` only `true` / `false`) and then decoded through the
 * attribute schema itself, so refinements, brands, literal unions and
 * `DateFromString` all apply, and `filter[priceCents][gt]=abc` fails decoding.
 * Encoding runs the reverse. A `Schema.NullOr` attribute's literals are the
 * non-null member's (`NULL` is never a literal).
 *
 * A relationship's literal codec is the related resource's `Id` schema, so
 * `filter[author]=9` decodes to the target's branded id. The target is resolved
 * lazily, so declaration order does not matter.
 *
 * Downstream consumers read this to validate and plan filters; the `filter`
 * URL codec over the declaration lands in a follow-up.
 *
 * For a base-anchored {@link family} the base's declaration is reported; a
 * name-only family declares nothing.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Supplier = Resource.make("suppliers", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * const Product = Resource.make("products", {
 *   attributes: {
 *     name: Schema.NonEmptyString,
 *     priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt])),
 *     discontinued: Schema.Boolean.pipe(Filter.able()),
 *     // the same declaration as sugar on a projection descriptor
 *     sku: Resource.attribute(Schema.String, { create: "required", update: false, filter: ["eq"] })
 *   },
 *   relationships: {
 *     supplier: Relationship.one(() => Supplier, { filter: ["eq", "in"] })
 *   }
 * })
 *
 * const filterable = Resource.filterable(Product)
 * Object.keys(filterable) // ["priceCents", "discontinued", "sku", "supplier"]
 * filterable.priceCents.operators // ["eq", "gt", "lt"]
 * Schema.decodeUnknownSync(filterable.priceCents.literal)("1250") // 1250
 * Schema.encodeUnknownSync(filterable.discontinued.literal)(true) // "true"
 * Schema.decodeUnknownSync(filterable.supplier.literal)("9") // "9", branded as a Supplier id
 * ```
 *
 * @since 0.13.0
 * @category accessors
 */
export const filterable = <R extends Any>(resource: R): Filterable<R> => {
  const attributes = resource.fields.attributes
  if (nameOnlyFamilyAttributes.has(attributes)) return {} as Filterable<R>
  let result = filterableCache.get(attributes)
  if (result === undefined) {
    result = filterableFields(resource.type, attributes.fields, resource.relationships)
    filterableCache.set(attributes, result)
  }
  return { ...result } as unknown as Filterable<R>
}

/**
 * The sortable attributes of a resource definition, at runtime: the keys whose
 * schema is `Sort.able` (piped, or via the `sort: true` sugar of
 * {@link attribute}), in declaration order — empty when nothing is declared.
 *
 * The declaration is read from the attribute schema's `Sort.AnnotationId`
 * annotation, through the same wrappers as {@link filterable} (`optionalKey`,
 * `NullOr`, `suspend`, the descriptor; a later `.check(...)` does not hide it).
 * Annotate last for the types (see `Sort.able`).
 *
 * The result is typed as the literal key union, so it drops straight into the
 * `sort` allow-list of `Query.schema` / `Endpoint.list`:
 * `Endpoint.list(R, { sort: Resource.sortable(R) })`. (`sort: true` keeps
 * meaning "every attribute".)
 *
 * For a base-anchored {@link family} the base's declaration is reported; a
 * name-only family declares nothing.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString.pipe(Sort.able()),
 *     body: Schema.String,
 *     createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able())),
 *     // the same declaration as sugar
 *     updatedAt: Resource.attribute(Schema.DateFromString, { create: false, sort: true })
 *   }
 * })
 *
 * Resource.sortable(Article) // ["title", "createdAt", "updatedAt"]
 *
 * // the declared set as the endpoint's sort allow-list
 * const query = Query.schema(Article, { sort: Resource.sortable(Article) })
 * Schema.decodeUnknownSync(query)({ sort: "-createdAt" })
 * // → { sort: [{ field: "createdAt", direction: "desc" }] }
 * ```
 *
 * @since 0.13.0
 * @category accessors
 */
export const sortable = <R extends Any>(resource: R): ReadonlyArray<SortableKeys<R>> => {
  const attributes = resource.fields.attributes
  if (nameOnlyFamilyAttributes.has(attributes)) return []
  let keys = sortableCache.get(attributes)
  if (keys === undefined) {
    keys = sortableKeys(resource.type, attributes.fields)
    sortableCache.set(attributes, keys)
  }
  return [...keys] as unknown as ReadonlyArray<SortableKeys<R>>
}

// Refuses, at definition time and naming the attribute, an input-only
// descriptor (`resource: false`) that declares nothing — excluded from the
// resource object *and* every write projection — or that declares a `filter` /
// `sort`: an attribute absent from the resource object cannot be filtered or
// sorted on.
const validateDescriptors = (type: string, fields: Schema.Struct.Fields): void => {
  for (const [key, field] of Object.entries(fields)) {
    const descriptor = descriptorOf(field as Schema.Top)
    if (descriptor === undefined || descriptor.resource !== false) continue
    if (descriptor.create === false && descriptor.update === false) {
      throw new Error(
        `Resource.make("${type}"): attribute "${key}" declares resource: false with create: false and update: false, ` +
          "so it would appear nowhere; keep a create or update projection, or drop the attribute"
      )
    }
    if (declarationOf(field as Schema.Top, Filter.AnnotationId) !== undefined) {
      throw new Error(
        `Resource.make("${type}"): attribute "${key}" is input-only (resource: false) but declared filterable; ` +
          "an attribute absent from the resource object cannot be filtered on"
      )
    }
    if (declarationOf(field as Schema.Top, Sort.AnnotationId) !== undefined) {
      throw new Error(
        `Resource.make("${type}"): attribute "${key}" is input-only (resource: false) but declared sortable; ` +
          "an attribute absent from the resource object cannot be sorted on"
      )
    }
  }
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
  // The resource object carries the declared attributes minus the input-only
  // ones (`resource: false`); a descriptor that declares nothing anywhere, or
  // declares an input-only attribute filterable / sortable, is refused here.
  validateDescriptors(type, options.attributes)
  const attributes = Schema.Struct(resourceAttributeFields(options.attributes)) as unknown as Schema.Struct<
    ResourceAttributes<Attributes>
  >
  const relationshipsStruct = Schema.Struct(relationshipSchemas)

  // Per-attribute projections: each attribute may carry a descriptor (from
  // `attribute` / `readOnlyAttribute`) controlling how it appears in the write
  // projections. A plain schema attribute projects with the read-write defaults.
  // They derive from the *declared* map, so input-only attributes project too.
  const createAttributes = Schema.Struct(createAttributeFields(options.attributes))
  const updateAttributes = Schema.Struct(updateAttributeFields(options.attributes))

  // Filter declarations are checked now, not on first use: an attribute declared
  // filterable whose encoded form has no literal codec, or a relationship
  // declaring an operator it cannot admit, throws here, naming the key.
  filterableCache.set(attributes, filterableFields(type, attributes.fields, relationships))
  sortableCache.set(attributes, sortableKeys(type, attributes.fields))

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
      attributes: createAttributes,
      relationships: hasRequiredRelationship ? createRelationshipsStruct : Schema.optionalKey(createRelationshipsStruct)
    })
  }) as unknown as CreatePayload<Type, Attributes, Rels>

  // Update payload relationships: every non-`paginated` relationship, optional.
  const updateRelationshipFields: Record<string, Schema.Top> = {}
  for (const [key, descriptor] of Object.entries(relationships)) {
    if (descriptor.kind === "paginated") continue
    updateRelationshipFields[key] = Schema.optionalKey(schemaByKey[key]!)
  }

  // The update payload's attributes are the tri-state `Schema.optional`
  // projection (set / unset / leave-unchanged), with per-attribute descriptors
  // applied (excluded / clearability) — built once as `updateAttributes`.
  const updatePayload = Schema.Struct({
    data: Schema.Struct({
      type: Schema.tag(type),
      id,
      attributes: Schema.optionalKey(updateAttributes),
      relationships: Schema.optionalKey(Schema.Struct(updateRelationshipFields))
    })
  }) as unknown as UpdatePayload<Type, Attributes, Rels, IdSchema>

  // Flat ("command-style") projections of the create/update inputs, without the
  // JSON:API `{ data: { type, ... } }` envelope. They mirror the enveloped
  // payloads' attribute projections.
  const createInput = createAttributes as unknown as CreateInput<Attributes>
  const updateInput = Schema.Struct({
    ...(updateAttributeFields(options.attributes) as Record<string, Schema.Top>),
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
    declaredAttributes: options.attributes,
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
 * With `Custom` given (the `id` option of {@link extend}) the child's id is
 * exactly that schema — the consumer's own brand, with no package brand added —
 * taking precedence over both of the above.
 *
 * @since 0.3.0
 * @category type-level
 */
export type ExtendedId<
  BaseId extends Schema.Codec<any, string>,
  Type extends string,
  Inherit extends boolean,
  Custom extends Schema.Codec<any, string> | undefined = undefined
> =
  Custom extends Schema.Codec<any, string>
    ? Custom
    : Inherit extends true
      ? Schema.brand<BaseId, `${Type}Id`>
      : Id<Type>

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
 * Alternatively pass your own `id` schema — exactly as {@link make}'s `id`
 * option — and the child's id is that schema and nothing else: no package brand
 * is added, so a consumer that keys its subtypes with its own brand catalogue
 * (branding at the row-mapping seam via `AdminId.make(row.id)`) can use
 * `extend` for subtype chains too. `id` and `inheritId: true` are contradictory
 * (one names the id schema outright, the other derives it from the base), so
 * passing both is a type error and throws at definition time.
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
 *
 * // With `id`, the subtype carries the consumer's own brand and nothing else:
 * const AuditorId = Schema.String.pipe(Schema.brand("AuditorId"))
 * const Auditor = Resource.extend(Account, "auditors", { id: AuditorId })
 * const auditorId = Auditor.Id.make("1") // string & Brand<"AuditorId">
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
  const InheritId extends boolean = false,
  IdSchema extends Schema.Codec<any, string> | undefined = undefined
>(
  base: Resource<BaseType, BaseAttributes, BaseRels, BaseMeta, BaseId>,
  type: Type,
  options?: {
    readonly attributes?: ExtraAttributes
    readonly relationships?: ExtraRels
    readonly meta?: Meta
    /**
     * The id schema for this resource, exactly as {@link make}'s `id` option:
     * any schema whose `Encoded` side is `string`, whose decoded type becomes
     * the resource's id brand with no package brand added. Contradicts
     * `inheritId: true`. Defaults to the id {@link ExtendedId} derives.
     *
     * @since 0.14.0
     */
    readonly id?: IdSchema
    /**
     * Brand the *base's* id schema with this resource's type instead of minting
     * a fresh independent id, so the child id is a subtype of the base id.
     * Defaults to `false`. Not admitted alongside `id`.
     */
    readonly inheritId?: [IdSchema] extends [undefined] ? InheritId : false
  }
): Resource<
  Type,
  ExtendedAttributes<BaseAttributes, ExtraAttributes>,
  ExtendedRelationships<BaseRels, ExtraRels>,
  Meta,
  ExtendedId<BaseId, Type, InheritId, IdSchema>
> => {
  if (options?.id !== undefined && options.inheritId === true) {
    throw new Error(
      "Resource.extend: `id` and `inheritId: true` are contradictory; pass a custom `id` schema or `inheritId: true`, not both"
    )
  }
  // A custom id wins (the same rule `make` applies); otherwise inherit the
  // base's brand, or leave it to `make` to mint a fresh one.
  const id =
    options?.id ?? (options?.inheritId === true ? base.Id.pipe(Schema.brand(`${type}Id` as `${Type}Id`)) : undefined)
  return make(type, {
    id,
    // The *declared* map, so the base's input-only attributes are inherited too
    // (the resource-object fields would have dropped them).
    attributes: { ...base.declaredAttributes, ...options?.attributes },
    relationships: { ...base.relationships, ...options?.relationships },
    meta: (options?.meta ?? base.fields.meta.schema) as Meta
  }) as unknown as Resource<
    Type,
    ExtendedAttributes<BaseAttributes, ExtraAttributes>,
    ExtendedRelationships<BaseRels, ExtraRels>,
    Meta,
    ExtendedId<BaseId, Type, InheritId, IdSchema>
  >
}

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
  (typeof u === "object" || typeof u === "function") &&
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
  // A name-only family's attributes are synthesised, not declared: nothing is
  // filterable or sortable through it (a base-anchored family reads its base's).
  if (base === undefined) nameOnlyFamilyAttributes.add(attributes)

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
