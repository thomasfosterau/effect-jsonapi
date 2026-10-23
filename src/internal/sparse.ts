/**
 * The partial resource objects a read endpoint that declares
 * `fields` binds by default (#322).
 *
 * JSON:API 1.1 §Sparse Fieldsets: when a client asks for a restricted set of
 * fields for a type, the response MUST NOT include any other field of that
 * type. So the resource objects of every type `?fields[TYPE]=` can name — the
 * primary resources and each type their `included` union admits, the set
 * `Query.FieldsetResources` computes — may carry any subset of their fields,
 * attributes and relationships alike (#494). Their default document is built
 * here from the strict one: each such resource definition becomes a struct
 * whose `attributes` members and `relationships` members are all optional
 * keys, and everything else (`type`, `id`, `links`, `meta`) stays exactly as
 * declared.
 *
 * A `Resource.family` in `data` or `included` is not a resource object of its
 * own: its `type` is a family name, never a wire type, and what the wire
 * carries are its members, each under its own type. So it becomes the union of
 * its members (a member that is itself a family in turn), and each member is
 * made partial when its type is one `types` names, as any other resource is,
 * and kept strict otherwise. A family's name is never looked up in `types`:
 * `sparseMember` replaces a family by its members unconditionally, as
 * `Query.FieldsetResources` does, recursively, declaring no
 * `fields[<family name>]` (#350).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { isSurface } from "../Include.js";
import type { Any } from "../Resource.js";
import { isFamily } from "../Resource.js";
import { expandFamilies, includedResources, includePathsFor } from "./includeGraph.js";

// Resolves to `T` for every concrete field map; needed because the mapped
// types below can't be proven to satisfy `Struct.Fields` while generic.
type AsFields<T> = T extends Schema.Struct.Fields ? T : never;

// The schema counterpart of `AsFields`, for a union member computed from a
// still-generic resource.
type AsSchema<T> = T extends Schema.Top ? T : never;

// Each member an optional key; one that already is (`Schema.optionalKey`,
// `Schema.optional`) stays exactly as declared.
type OptionalMembers<A extends Schema.Struct.Fields> = {
  readonly [K in keyof A]: A[K] extends { readonly "~type.optionality": "optional" }
    ? A[K]
    : Schema.optionalKey<A[K]>;
};

// A resource object's (optional) `relationships` struct made partial.
type SparseRelationships<S> = S extends {
  readonly schema: { readonly fields: infer RF extends Schema.Struct.Fields };
}
  ? Schema.optionalKey<Schema.Struct<OptionalMembers<RF>>>
  : S;

// A resource object's field map with its `attributes` and `relationships`
// structs made partial.
type SparseFields<F extends Any["fields"]> = {
  readonly [K in keyof F]: K extends "attributes"
    ? Schema.Struct<OptionalMembers<F["attributes"]["fields"]>>
    : K extends "relationships"
      ? SparseRelationships<F[K]>
      : F[K];
};

/**
 * A resource definition's resource object with every attribute and every
 * relationship optional.
 */
export interface SparseResource<R extends Any> extends Schema.Struct<
  AsFields<SparseFields<R["fields"]>>
> {}

/**
 * One member of a default document's `data` or `included` union: the
 * {@link SparseResource} of a resource whose type is in `Types`; a family, the
 * {@link SparseUnion} of its members (so a nested family recurses); anything
 * else (a type no fieldset names) as it stands. Distributes over unions.
 */
export type SparseMember<M, Types extends string> = M extends Any
  ? M extends { readonly members: ReadonlyArray<infer F extends Any> }
    ? SparseUnion<F, Types>
    : [M["type"]] extends [Types]
      ? SparseResource<M>
      : M
  : M;

/**
 * A `Schema.Union` over the {@link SparseMember}s of `Members`.
 */
export interface SparseUnion<Members, Types extends string> extends Schema.Union<
  ReadonlyArray<AsSchema<SparseMember<Members, Types>>>
> {}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

/**
 * What a read endpoint's `include` option is at runtime: off, on, a
 * `Query.IncludeOptions` or a declared `Include.Surface` (whose `paths` it
 * shares).
 */
export type IncludeArgument =
  | boolean
  | { readonly paths?: ReadonlyArray<string>; readonly depth?: number };

/**
 * A resource definition as the struct it is: `Any` declares only the
 * `attributes` member of its fields.
 */
export interface ResourceStruct extends Any {
  readonly fields: Any["fields"] & Schema.Struct.Fields;
}

// A `Schema.Union`, a family among them, carries its members.
const hasMembers = (
  schema: Schema.Top,
): schema is Schema.Top & { readonly members: ReadonlyArray<Schema.Top> } =>
  Predicate.hasProperty(schema, "members") && Arr.isArray(schema.members);

// A plain resource definition: a `type` name and an `attributes` struct, and
// no members (a family has both).
const isResource = (schema: Schema.Top): schema is ResourceStruct =>
  Predicate.hasProperty(schema, "type") &&
  Predicate.isString(schema.type) &&
  Predicate.hasProperty(schema, "fields") &&
  Predicate.hasProperty(schema.fields, "attributes") &&
  !hasMembers(schema);

// One sparse schema per resource definition, so every document that carries a
// resource shares it — as the strict documents share the definition itself.
const sparseCache = new WeakMap<ResourceStruct, Schema.Top>();

// A member as an optional key; one already optional as declared.
const optionalMember = (field: Schema.Struct.Fields[string]) =>
  SchemaAST.isOptional(field.ast) ? field : Schema.optionalKey(field);

// The `relationships` member of a resource object's field map, its struct
// rebuilt with every relationship an optional key; anything else (a
// hand-rolled definition's) as it stands.
const sparseRelationships = (member: Schema.Struct.Fields[string] | undefined) => {
  if (member === undefined) return {};
  const inner: unknown = Predicate.hasProperty(member, "schema") ? member.schema : undefined;
  if (!Predicate.hasProperty(inner, "fields") || !Predicate.isObject(inner.fields))
    return { relationships: member };
  // SAFETY: the `fields` of a `Schema.Struct`, which a definition's
  // `relationships` member wraps (`Resource.make`).
  const fields = inner.fields as Schema.Struct.Fields;
  return { relationships: Schema.optionalKey(Schema.Struct(Rec.map(fields, optionalMember))) };
};

/**
 * The runtime {@link SparseResource}: the definition's own fields, its
 * `attributes` and `relationships` structs rebuilt with every member an
 * optional key. Annotations are carried over except `identifier`, which names
 * the strict definition.
 */
export const sparseResource = (resource: ResourceStruct): Schema.Top => {
  const cached = sparseCache.get(resource);
  if (cached !== undefined) return cached;
  const { identifier: _identifier, ...annotations } = resource.ast.annotations ?? {};
  const sparse = Schema.Struct({
    ...resource.fields,
    attributes: Schema.Struct(Rec.map(resource.fields.attributes.fields, optionalMember)),
    ...sparseRelationships(resource.fields["relationships"]),
  }).annotate(annotations);
  sparseCache.set(resource, sparse);
  return sparse;
};

/**
 * The runtime {@link SparseMember}.
 */
export const sparseMember = (member: Schema.Top, types: ReadonlyArray<string>): Schema.Top =>
  isFamily(member)
    ? Schema.Union(member.members.map((m) => sparseMember(m, types)))
    : isResource(member) && Arr.contains(types, member.type)
      ? sparseResource(member)
      : member;

/**
 * The runtime {@link SparseUnion}, over a `Schema.Union`'s members. Anything
 * other than a union is returned as it stands.
 */
export const sparseUnion = (union: Schema.Top, types: ReadonlyArray<string>): Schema.Top =>
  hasMembers(union) ? Schema.Union(union.members.map((m) => sparseMember(m, types))) : union;

// The include paths an endpoint's `include` option legalises: none while it
// is off.
const includablePaths = (
  resources: ReadonlyArray<Any>,
  include?: IncludeArgument,
): ReadonlyArray<string> =>
  include === true
    ? includePathsFor(resources)
    : Predicate.isObject(include)
      ? includePathsFor(resources, include)
      : [];

/**
 * The runtime mirror of `Query.FieldsetResources`: the resources, then every
 * type their response can carry in `included`, a family replaced by its
 * members (recursively), each once.
 */
export const fieldsetResources = (
  resources: ReadonlyArray<Any>,
  includable: ReadonlyArray<string>,
  include?: IncludeArgument,
): ReadonlyArray<Any> =>
  expandFamilies([...resources, ...includedResources(resources, isSurface(include), includable)]);

/**
 * The wire types `?fields[TYPE]=` can name on an endpoint over `resources`
 * with the `include` option `include`.
 */
export const fieldsetTypes = (
  resources: ReadonlyArray<Any>,
  include?: IncludeArgument,
): ReadonlyArray<string> =>
  fieldsetResources(resources, includablePaths(resources, include), include).map((r) => r.type);
