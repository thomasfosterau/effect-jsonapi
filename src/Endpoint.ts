/**
 * JSON:API endpoint constructors.
 *
 * Thin, convention-baking constructors over `HttpApiEndpoint`, one per
 * JSON:API operation:
 *
 * | Constructor          | Method & path                             | Payload                  | Success                              |
 * | -------------------- | ----------------------------------------- | ------------------------ | ------------------------------------ |
 * | `get`                | `GET /<type>/:id`                         | —                        | 200, single-resource doc (`success`) |
 * | `list`               | `GET /<type>`                             | —                        | 200, collection doc (`success`)      |
 * | `create`             | `POST /<type>`                            | `createPayload` (lid ok) | 201, single-resource doc (`success`) |
 * | `update`             | `PATCH /<type>/:id`                       | `updatePayload`          | 200, single-resource doc (`success`) |
 * | `delete`             | `DELETE /<type>/:id`                      | —                        | 204, no content (`success`)          |
 * | `collection`         | `GET <path>`                              | —                        | 200, heterogeneous doc               |
 * | `related`            | `GET /<type>/:id/<name>`                  | —                        | 200, related resource(s)             |
 * | `getRelationship`    | `GET /<type>/:id/relationships/<name>`    | —                        | 200, linkage doc                     |
 * | `updateRelationship` | `PATCH /<type>/:id/relationships/<name>`  | linkage                  | 200, linkage doc                     |
 * | `addRelationship`    | `POST /<type>/:id/relationships/<name>`   | linkage (to-many only)   | 200, linkage doc                     |
 * | `removeRelationship` | `DELETE /<type>/:id/relationships/<name>` | linkage (to-many only)   | 204, no content                      |
 *
 * Every endpoint automatically:
 *   - serves and accepts `application/vnd.api+json`
 *   - carries the {@link Middleware} content-negotiation and schema-error
 *     middlewares, so 400/406/415 are spec-compliant JSON:API error documents
 *     and the api cannot be built without providing them
 *   - declares its errors as JSON:API error documents (pass `ApiError`
 *     classes via `errors`)
 *   - exposes typed query parameters (`include`, `fields`, `sort`, `page`,
 *     `filter`) when enabled
 *
 * Names and paths follow the conventions above but can be overridden, as can
 * the write payloads: `create` / `update` default to the enveloped
 * `createPayload` / `updatePayload`, and take a `payload` option for apis whose
 * write contract is a flat command input (e.g. the resource's own
 * `createInput` / `updateInput`) rather than a JSON:API document. `delete`
 * likewise takes a `success` option for apis whose deletion answers with a
 * body — a soft delete returning the tombstone resource — instead of 204, and
 * `get` / `list` a `query` option replacing the composed query schema
 * wholesale, for apis whose read contract is a struct of their own.
 *
 * The write endpoints take a `status` option alongside, for apis whose
 * creations answer with a status other than the spec's recommended 201 — the
 * counterpart to the one `delete` already carries — and a `payloadMediaType`,
 * for hosts that negotiate §6 themselves and dispatch writes to the router
 * under a different content type than the one the api advertises.
 *
 * They also take an `idempotency` option (`create` / `update` / `delete` /
 * `operations`, and the whole set `resource` generates): `true` declares the
 * `Idempotency-Key` request header and honours it, `"required"` insists on one.
 * It attaches `Idempotency.Middleware`, so an api carrying an idempotent
 * endpoint cannot be built without a store — see {@link Idempotency} and
 * `docs/idempotency.md`.
 *
 * The primary-data endpoints take the same `success` option: `get` / `create` /
 * `update` default to the resource's `document()` and `list` to its
 * `collection()`, and any schema can replace that — most usefully a *wire*
 * variant of the resource, for an api whose assembler emits a narrower shape
 * than the resource's own decoded types (plain-string link members rather than
 * `URL`, say) and whose clients must consume that shape.
 *
 * A resource carrying an injected id — `Resource.make`'s `id` option, for an
 * api whose ids are its own branded vocabulary rather than the derived
 * `Id<Type>` — is taken by every constructor as it stands, with no cast: the id
 * schema is a type parameter of each, inferred from the resource it is given
 * and threaded into the `:id` path parameter and the documents the endpoint
 * declares.
 *
 * For the common case, {@link resource} derives an entire endpoint set — the
 * CRUD surface plus every relationship's endpoints, with query parameters
 * derived from the resource graph — from a single resource definition (and
 * `Group.resource` wraps it into a whole `HttpApiGroup`).
 *
 * The constructors return plain `HttpApiEndpoint` values: everything composes
 * with vanilla `HttpApiGroup` / `HttpApi` / `HttpApiBuilder` / `HttpApiClient`
 * / `HttpApiTest` / `OpenApi`.
 *
 * @since 0.1.0
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpApiEndpoint, HttpApiSchema } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import { AnyMeta, CollectionDocument, DataDocument, LinkageDocument, wire } from "./Document.js";
import type { WireSchema } from "./Document.js";
import * as FlatQuery from "./FlatQuery.js";
import * as Idempotency from "./Idempotency.js";
import { isSurface } from "./Include.js";
import type { AnySurface, SurfaceFor } from "./Include.js";
import { asJsonApi, asJsonApiAtomic, asMediaType } from "./internal/httpMedia.js";
import { closedStruct, defaultMaxUndeclaredMemberErrors } from "./internal/schemaExt.js";
import { MEDIA_TYPE } from "./internal/media.js";
import { ServedTypes } from "./internal/servedTypes.js";
import { ContentNegotiation, CreatedLocation, SchemaErrors } from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import type { Relationships } from "./Relationship.js";
import type {
  DeclaresSurface,
  IncludedResources,
  IncludeEnabled,
} from "./internal/includeGraph.js";
import { includedResources, includePathsFor } from "./internal/includeGraph.js";
import type {
  IncludeArgument,
  ResourceStruct,
  SparseMember,
  SparseResource,
  SparseUnion,
} from "./internal/sparse.js";
import { fieldsetTypes, sparseMember, sparseResource, sparseUnion } from "./internal/sparse.js";
import type {
  Any,
  AttributeKeys,
  DefaultIncluded,
  Family,
  FamilyDefaultIncluded,
  Id,
  IncludeDepth,
  IncludePathsTo,
  Parameter,
  RelationshipName,
  ResolveIncludePath,
  Resource,
  Target,
  ToManyName,
} from "./Resource.js";
import { directTargets } from "./Resource.js";

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

/**
 * The constraint satisfied by every `ApiError.make` class: something with a
 * derived wire schema.
 *
 * @since 0.1.0
 * @category models
 */
export interface ErrorClass {
  readonly wire: Schema.Top;
  readonly status: number;
}

/**
 * The wire schemas of a tuple of error classes.
 *
 * @since 0.1.0
 * @category type-level
 */
export type Wires<Errors extends ReadonlyArray<ErrorClass>> = {
  readonly [K in keyof Errors]: Errors[K]["wire"];
};

const wires = <const Errors extends ReadonlyArray<ErrorClass>>(
  errors: Errors | undefined,
): Wires<Errors> => ((errors ?? []) as Errors).map((error) => error.wire) as Wires<Errors>;

// ---------------------------------------------------------------------------
// Shared option types
// ---------------------------------------------------------------------------

/**
 * Options common to all endpoint constructors.
 *
 * @since 0.1.0
 * @category models
 */
export interface CommonOptions<Name extends string, Path extends `/${string}`, Errors> {
  /** Endpoint name within its group. Defaults to the operation name (`"get"`, `"list"`, …). */
  readonly name?: Name;
  /** Route path. Defaults to the conventional JSON:API path for the operation. */
  readonly path?: Path;
  /** `ApiError` classes this endpoint can fail with. */
  readonly errors?: Errors;
}

const queryConfig = (options?: {
  readonly include?:
    | boolean
    | { readonly paths?: ReadonlyArray<string>; readonly depth?: number }
    | undefined;
  readonly fields?: boolean | undefined;
  readonly sort?: boolean | ReadonlyArray<string> | undefined;
  readonly page?: Schema.Struct.Fields | undefined;
  readonly filter?: Query.FilterOption | undefined;
}) => ({
  include: options?.include ?? false,
  fields: options?.fields === true,
  sort: options?.sort ?? false,
  page: options?.page,
  filter: options?.filter,
});

// The `included` union a read endpoint's default document carries: the union a
// declared `Include.Surface` derives, so the paths the endpoint advertises and
// the resources its document admits come from one declaration; else, when the
// `include` option turns the parameter on, every resource its legal paths
// reach beside the direct targets (#320), so each advertised path can be
// answered; else the relationship graph's own default.
type IncludedOf<R extends Any, Include> = Include extends {
  readonly included: infer U;
}
  ? U extends Schema.Top
    ? U
    : DefaultIncluded<R["relationships"]>
  : IncludeEnabled<Include> extends true
    ? ReachableIncluded<R, Include>
    : DefaultIncluded<R["relationships"]>;

/**
 * The `included` union of a read endpoint over `R` whose `include` option is
 * `true` or a `Query.IncludeOptions`: the direct targets and every resource a
 * legal include path reaches (#320). The default success document of `get`,
 * `list` and `related` carries it, so it is part of their inferred types —
 * and exported so a consumer that emits declarations can name it (#348).
 *
 * @since 0.17.0
 * @category schemas
 */
export interface ReachableIncluded<R extends Any, Include> extends Schema.Union<
  ReadonlyArray<IncludedResources<R, Include>>
> {}

// What a read endpoint's `include` option is at runtime: a boolean, a
// `Query.IncludeOptions`, or a declared `Include.Surface` (whose `paths` it
// shares).

// The runtime mirror of `ReachableIncluded`: `None` when the `include` option
// is off (the default union stands) or a declared surface (whose own union
// each caller binds).
const reachableIncluded = (
  resources: ReadonlyArray<Any>,
  include?: IncludeArgument,
): Option.Option<Schema.Top> =>
  include === true || (Predicate.isObject(include) && !isSurface(include))
    ? Option.some(
        Schema.Union(
          includedResources(
            resources,
            false,
            include === true ? includePathsFor(resources) : includePathsFor(resources, include),
          ),
        ),
      )
    : Option.none();

// The wire types `?fields[TYPE]=` can name on an endpoint over `R` with the
// `include` option `Include`: the types its default document makes partial
// when it declares `fields` (#322).
type FieldsetTypes<R extends Any, Include> = Query.FieldsetResources<R, Include>["type"];

// The members of a read endpoint's default `included` union (`IncludedOf`): a
// declared surface's own, else `IncludedResources` — the direct targets and,
// when `include` is on, every resource a legal path reaches.
type IncludedMembers<R extends Any, Include> = Include extends {
  readonly included: { readonly members: ReadonlyArray<infer M> };
}
  ? M
  : IncludedResources<R, Include>;

// `IncludedOf` with every member whose type a fieldset names made partial.
type SparseIncluded<R extends Any, Include> = SparseUnion<
  IncludedMembers<R, Include>,
  FieldsetTypes<R, Include>
>;

// The success document the single-resource endpoints (`get`, `create`,
// `update`) bind by default — the resource's own `document()` at the effective
// document `meta`. The default their `success` option replaces. When the
// endpoint declares `fields` (only `get` can), its resource objects — primary
// and `included` alike — admit any subset of their attributes (#322).
type DefaultDocument<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  DocMeta extends Schema.Top,
  Include = false,
  Fields = false,
> = [Fields] extends [true]
  ? DataDocument<
      SparseResource<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
      SparseIncluded<Resource<Type, Attributes, Rels, Meta, IdSchema>, Include>,
      DocMeta
    >
  : DataDocument<
      Resource<Type, Attributes, Rels, Meta, IdSchema>,
      IncludedOf<Resource<Type, Attributes, Rels, Meta, IdSchema>, Include>,
      DocMeta
    >;

// The collection counterpart, for `list` — the resource's `collection()`.
type DefaultCollection<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  DocMeta extends Schema.Top,
  Include = false,
  Fields = false,
> = [Fields] extends [true]
  ? CollectionDocument<
      SparseResource<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
      SparseIncluded<Resource<Type, Attributes, Rels, Meta, IdSchema>, Include>,
      DocMeta
    >
  : CollectionDocument<
      Resource<Type, Attributes, Rels, Meta, IdSchema>,
      IncludedOf<Resource<Type, Attributes, Rels, Meta, IdSchema>, Include>,
      DocMeta
    >;

// The document options a read endpoint's default document is built with: the
// `meta` override, plus the `included` union when the `include` option is a
// declared surface or turns the parameter on (`IncludedOf`). Absent keys stay
// absent so each default stands.
const documentOptions = (
  resource: Any,
  options:
    | {
        readonly meta?: Schema.Top;
        readonly include?: IncludeArgument;
      }
    | undefined,
): { readonly meta?: Schema.Top; readonly included?: Schema.Top } => {
  const out: { meta?: Schema.Top; included?: Schema.Top } = {};
  if (options?.meta !== undefined) out.meta = options.meta;
  if (isSurface(options?.include)) out.included = options.include.included;
  const reachable = reachableIncluded([resource], options?.include);
  if (Option.isSome(reachable)) out.included = reachable.value;
  return out;
};

// The default document of `get` (`document()`) or `list` (`collection()`).
// When the endpoint declares `fields`, the resource and every `included`
// member whose type a fieldset names become partial (#322); otherwise it is
// the resource's own document, exactly as before.
const defaultDocument = (
  resource: DocumentSource,
  kind: "document" | "collection",
  options?: {
    readonly meta?: Schema.Top;
    readonly include?: IncludeArgument;
    readonly fields?: boolean;
  },
): Schema.Top => {
  const document = documentOptions(resource, options);
  if (options?.fields !== true) {
    return kind === "document" ? resource.document(document) : resource.collection(document);
  }
  const types = fieldsetTypes([resource], options.include);
  const sparse = {
    included: sparseUnion(document.included ?? Schema.Union(directTargets(resource)), types),
    meta: document.meta ?? resource.fields.meta.schema,
  };
  return kind === "document"
    ? DataDocument(sparseResource(resource), sparse)
    : CollectionDocument(sparseResource(resource), sparse);
};

// What `get` / `list` read of their resource at runtime: its document
// constructors, and the `meta` schema those default to.
interface DocumentSource extends ResourceStruct {
  readonly fields: ResourceStruct["fields"] & { readonly meta: Schema.optionalKey<Schema.Top> };
  document(options: { readonly meta?: Schema.Top; readonly included?: Schema.Top }): Schema.Top;
  collection(options: { readonly meta?: Schema.Top; readonly included?: Schema.Top }): Schema.Top;
}

// ---------------------------------------------------------------------------
// get — GET /<type>/:id
// ---------------------------------------------------------------------------

// The query schema `get` composes from its own feature options — the default
// its `query` option overrides. A single-resource fetch carries no `sort` /
// `page` / `filter`, so only `include` and `fields` vary.
type DefaultGetQuery<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Fields extends boolean,
> = Query.QuerySchema<
  Resource<Type, Attributes, Rels, Meta, IdSchema>,
  {
    readonly include: Include;
    readonly fields: Fields;
    readonly sort: false;
    readonly page: undefined;
    readonly filter: undefined;
  }
>;

/**
 * `GET /<type>/:id` — fetch a single resource.
 *
 * Success is a 200 single-resource document whose primary `data` is the
 * resource itself (non-null — a missing resource is a `404`, not
 * `200 { data: null }`); the compound `included` union is derived from the
 * resource's relationships — its non-`paginated` targets and, when `include`
 * is `true` or a `Query.IncludeOptions`, every resource a legal include path
 * reaches (`comments.author` admits the `people` behind each comment), so each
 * advertised path can be answered — or, when `include` is a declared
 * `Include.Surface`, from that same declaration, so the paths this endpoint
 * advertises and the resources its document admits cannot drift apart.
 *
 * Pass `success` to override that document with any schema — most usefully a
 * *wire* variant of the resource, for an api whose assembler emits a narrower
 * shape than the resource's own decoded types. Only the response changes; the
 * `:id` path param, query parameters, errors and middleware are unaffected.
 *
 * Pass `query` to replace the composed `include` / `fields` parameters with any
 * schema, exactly as {@link list} takes one — for an api whose read contract
 * carries parameters JSON:API has no family for, or whose `?include=` grammar
 * is its own. Only the query changes.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Document, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id?include=author&fields[articles]=title
 *   Endpoint.get(Article, {
 *     include: true,
 *     fields: true,
 *     errors: [ArticleNotFound]
 *   })
 * )
 *
 * // …or answering with a wire variant of the resource: the shape the assembler
 * // emits and the generated client consumes — `links.self` a plain string
 * const WireArticle = Schema.Struct({
 *   ...Article.fields,
 *   links: Schema.optionalKey(Schema.Struct({ self: Schema.optionalKey(Schema.String) }))
 * })
 * const wireArticles = Group.make(
 *   Article,
 *   Endpoint.get(Article, { success: Document.DataDocument(WireArticle) })
 * )
 *
 * // …or with a read query of your own, replacing the composed parameters
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.get(Article, {
 *     query: Schema.Struct({
 *       include: Schema.optionalKey(Schema.String),
 *       includeDeleted: Schema.optionalKey(Schema.Literals(["true", "false"]))
 *     })
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const get = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "get",
  const Path extends `/${string}` = `/${Type}/:id`,
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>> =
    false,
  const Fields extends boolean = false,
  DocMeta extends Schema.Top = Meta,
  QuerySchema extends Schema.Top = DefaultGetQuery<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    Include,
    Fields
  >,
  Success extends Schema.Top = DefaultDocument<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    DocMeta,
    Include,
    Fields
  >,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: CommonOptions<Name, Path, Errors> & {
    /**
     * Enable the `?include=` query parameter: `true` for the resource's graph
     * at depth 2, a `Query.IncludeOptions` object to constrain it, or an
     * `Include.Surface` — a declared surface, which also derives this
     * endpoint's `included` union.
     */
    readonly include?: Include;
    /**
     * Enable `?fields[TYPE]=` sparse fieldsets. The default success document
     * then admits any subset of the attributes of every resource type a
     * fieldset can name, primary and `included` alike, so a handler can answer
     * with `Handlers.project(query.fields)` (§Sparse Fieldsets) — and a client
     * decodes those attributes as optional. Pass `fields: false` to keep
     * strict attributes. A `success` override replaces the whole default
     * document: with `include` on or `meta` overridden, it must admit every
     * reachable type in `included` and carry the `meta` itself
     * (`R.document({ included: Include.included(R, { include }), meta })`).
     */
    readonly fields?: Fields;
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta;
    /**
     * Override the whole query schema. Defaults to the `Query.schema`
     * composition of the `include` / `fields` options above (which those
     * options are then ignored by); pass any schema for a read contract of your
     * own — the counterpart to `list`'s `query`.
     *
     * @since 0.11.0
     */
    readonly query?: QuerySchema;
    /**
     * Override the success document schema. Defaults to the resource's
     * `document()` (which `meta` then tunes); pass a wire variant of the
     * resource, or any schema of your own — it is served as
     * `application/vnd.api+json`.
     *
     * @since 0.10.0
     */
    readonly success?: Success;
  },
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "get") as Name,
    (options?.path ?? `/${resource.type}/:id`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      query: (options?.query ??
        Query.schema(
          resource,
          queryConfig(options) as {
            readonly include: Include;
            readonly fields: Fields;
            readonly sort: false;
            readonly page: undefined;
            readonly filter: undefined;
          },
        )) as QuerySchema,
      success: asJsonApi(
        (options?.success ?? defaultDocument(resource, "document", options)) as Success,
      ),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);

// ---------------------------------------------------------------------------
// list — GET /<type>
// ---------------------------------------------------------------------------

// The query schema `list` composes from its own feature options — the default
// its `query` option overrides.
type DefaultListQuery<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Fields extends boolean,
  Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>>,
  PageFields extends Schema.Struct.Fields | undefined,
  FilterFields extends Query.FilterOption | undefined,
> = Query.QuerySchema<
  Resource<Type, Attributes, Rels, Meta, IdSchema>,
  {
    readonly include: Include;
    readonly fields: Fields;
    readonly sort: Sort;
    readonly page: PageFields;
    readonly filter: FilterFields;
  }
>;

/**
 * `GET /<type>` — list a collection of resources.
 *
 * Success is a 200 collection document (strict array `data`), whose
 * `included` union is derived as {@link get}'s is. Enable `sort`, `page` and
 * `filter` for the spec's collection query parameters.
 *
 * Those options compose the whole query schema — a flat, bracket-keyed string
 * record on the wire that decodes to the spec's nested shape (`page: { offset,
 * limit }`, `filter: …`). `filter: true` turns on the filter grammar
 * (`docs/filter-grammar.md`) over the resource's declared filterable fields
 * (`Resource.attribute(schema, { filter })`, `Relationship.one(ref, { filter })`):
 * `?filter[status]=open&filter[age][gt]=18` decodes to a `Filter.Ast` root
 * node, and an unknown field, undeclared operator or bad literal is a 400
 * whose `source.parameter` names the key. A field map (`filter: { q:
 * Schema.String }`) is the open per-key escape hatch for flags JSON:API has no
 * family for. Pass `query` to replace the composition with any schema, for apis
 * whose list contract is a flat struct their own operations layer consumes.
 * Only the query changes; the success document, path, errors and middleware
 * are unaffected.
 *
 * Pass `success` to override the collection document itself with any schema —
 * most usefully a *wire* variant of the resource, for an api whose assembler
 * emits a narrower shape than the resource's own decoded types. The document
 * envelope is unchanged, so `Handlers.offsetPaginationLinks` and friends still
 * populate its top-level `links`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString,
 *     body: Schema.String,
 *     createdAt: Schema.DateFromString
 *   }
 * })
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
 *   Endpoint.list(Article, {
 *     include: true,
 *     sort: ["createdAt", "title"],
 *     page: Query.Page.Offset,
 *     filter: { author: Schema.optionalKey(Schema.String) }
 *   })
 * )
 *
 * // …or the filter grammar over a declared resource
 * const Product = Resource.make("products", {
 *   attributes: {
 *     name: Schema.NonEmptyString,
 *     priceCents: Resource.attribute(Schema.Int, { filter: ["eq", "gt", "lt"], sort: true })
 *   }
 * })
 * const products = Group.make(
 *   Product,
 *   // GET /products?filter[priceCents][lt]=1000 → query.filter is
 *   //   { _tag: "Compare", op: "lt", field: "priceCents", value: 1000 }
 *   Endpoint.list(Product, { filter: true, sort: Resource.sortable(Product), page: Query.Page.Offset })
 * )
 *
 * // …or with a query schema of your own: a flat struct, page cursor bracketed
 * // on the wire but decoded flat, alongside parameters JSON:API has no family for
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.list(Article, {
 *     query: Query.bracketPageKeys(
 *       Schema.Struct({
 *         ...Query.Page.offset({ maxLimit: 100 }),
 *         authorId: Schema.optionalKey(Schema.String)
 *       })
 *     )
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const list = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "list",
  const Path extends `/${string}` = `/${Type}`,
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>> =
    false,
  const Fields extends boolean = false,
  const Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Query.FilterOption | undefined = undefined,
  DocMeta extends Schema.Top = Meta,
  QuerySchema extends Schema.Top = DefaultListQuery<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    Include,
    Fields,
    Sort,
    PageFields,
    FilterFields
  >,
  Success extends Schema.Top = DefaultCollection<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    DocMeta,
    Include,
    Fields
  >,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: CommonOptions<Name, Path, Errors> & {
    /**
     * Enable the `?include=` query parameter: `true` for the resource's graph
     * at depth 2, a `Query.IncludeOptions` object to constrain it, or an
     * `Include.Surface` — a declared surface, which also derives this
     * endpoint's `included` union.
     */
    readonly include?: Include;
    /**
     * Enable `?fields[TYPE]=` sparse fieldsets. The default success document
     * then admits any subset of the attributes of every resource type a
     * fieldset can name, primary and `included` alike, so a handler can answer
     * with `Handlers.project(query.fields)` (§Sparse Fieldsets) — and a client
     * decodes those attributes as optional. Pass `fields: false` to keep
     * strict attributes. A `success` override replaces the whole default
     * document: with `include` on or `meta` overridden, it must admit every
     * reachable type in `included` and carry the `meta` itself
     * (`R.collection({ included: Include.included(R, { include }), meta })`).
     */
    readonly fields?: Fields;
    /** Enable `?sort=`: `true` for all attributes, or an array of sortable attribute names. */
    readonly sort?: Sort;
    /** Enable `?page[*]=` pagination (see `Query.Page` for ready-made strategies). */
    readonly page?: PageFields;
    /**
     * Enable `?filter[*]=` filtering. `true` turns on the filter grammar
     * (`docs/filter-grammar.md`) over the resource's declared filterable
     * fields, decoding to a `Filter.Ast`; a field map (`{ q: Schema.String }`)
     * is the open per-key escape hatch, each key becoming `filter[<key>]`.
     */
    readonly filter?: FilterFields;
    /** Override the collection document's `meta` schema (e.g. pagination totals). */
    readonly meta?: DocMeta;
    /**
     * Override the whole query schema. Defaults to the `Query.schema`
     * composition of the `include` / `fields` / `sort` / `page` / `filter`
     * options above (which those options are then ignored by); pass any schema
     * for a list contract of your own — e.g. a flat struct whose page cursor is
     * bracketed on the wire by `Query.bracketPageKeys` but decoded flat.
     */
    readonly query?: QuerySchema;
    /**
     * Override the success document schema. Defaults to the resource's
     * `collection()` (which `meta` then tunes); pass a collection document over
     * a wire variant of the resource, or any schema of your own — it is served
     * as `application/vnd.api+json`.
     *
     * @since 0.10.0
     */
    readonly success?: Success;
  },
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "list") as Name,
    (options?.path ?? `/${resource.type}`) as Path,
    {
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      query: (options?.query ??
        Query.schema(
          resource,
          queryConfig(options) as {
            readonly include: Include;
            readonly fields: Fields;
            readonly sort: Sort;
            readonly page: PageFields;
            readonly filter: FilterFields;
          },
        )) as QuerySchema,
      success: asJsonApi(
        (options?.success ?? defaultDocument(resource, "collection", options)) as Success,
      ),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);

// ---------------------------------------------------------------------------
// create — POST /<type>
// ---------------------------------------------------------------------------

/**
 * `POST /<type>` — create a resource.
 *
 * The request payload defaults to the resource's `createPayload` — the nested
 * JSON:API envelope (`{ data: { type, lid?, attributes, relationships } }`);
 * success is a 201 single-resource document containing the created resource.
 *
 * Pass `payload` to override that envelope with any schema — most usefully the
 * resource's own flat `createInput` projection, for a write contract that is a
 * flat command input rather than a JSON:API document. Only the request body
 * changes; the success document, path, errors and middleware are unaffected.
 *
 * Pass `success` to override the response document the same way — most usefully
 * a *wire* variant of the resource, for an api whose assembler emits a narrower
 * shape than the resource's own decoded types. The two are independent.
 *
 * Pass `status` for a creation that answers with a status other than 201 — an
 * api whose whole write surface answers 200, say. It defaults to the spec's
 * recommended 201, including when `success` is given.
 *
 * Pass `payloadMediaType` to register the request body under a media type other
 * than `application/vnd.api+json`. The router matches a request's
 * `Content-Type` against the registration and answers 415 on a mismatch, so a
 * host that enforces §6 itself and hands the router a relabelled request needs
 * to say which label it dispatches. It changes the registration only — pair it
 * with `Middleware.layerHostNegotiated` so the package's own §6 check doesn't
 * then reject what the host admitted.
 *
 * Pass `idempotency` for the creation a client can safely retry: `true`
 * declares the `Idempotency-Key` header, `"required"` insists on it. A retry
 * carrying the same key replays the original 201 verbatim rather than creating
 * a second resource; the same key with a different body is a 422. It attaches
 * `Idempotency.Middleware`, so the api needs an `Idempotency.layer(store)` —
 * see `docs/idempotency.md`.
 *
 * A 201 answers with a `Location` header (§Creating Resources → 201 Created),
 * copied verbatim from the created resource's `data.links.self` — or, when it
 * has none, the document's top-level `links.self` — by the attached
 * `Middleware.CreatedLocation`, so the two match by construction. Give the
 * created resource a `links.self` (as the example's document does) and both
 * the header and the match follow; with neither link the header is omitted,
 * and a create answering another `status` is left untouched. The middleware
 * sits inside `Idempotency.Middleware`, so a replay keeps the header.
 *
 * A resource object whose `data.type` names a type other than the resource's
 * is answered with 409 Conflict, `source.pointer` `/data/type` (§Creating
 * Resources → 409 Conflict), by the attached `Middleware.SchemaErrors`; a
 * `type` that is missing or not a string is the 400 of any malformed payload.
 *
 * The default payload does not support client-generated ids: a `data.id` is
 * answered with 403 Forbidden, `source.pointer` `/data/id`, and the handler
 * never runs (§Client-Generated IDs). To support them, pass a `payload` whose
 * resource object declares an `id` — `createPayload`'s own fields plus one,
 * `Schema.Struct({ data: Schema.Struct({ ...Article.createPayload.fields.data.fields,
 * id: Schema.optionalKey(Schema.String) }) })` — and the handler receives it;
 * answering a duplicate with 409 is then the handler's to do.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Handlers, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
 *   status: 409,
 *   fields: { title: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // POST /articles → 201, body { data: { type, attributes } }
 *   Endpoint.create(Article, { errors: [TitleTaken] })
 * )
 *
 * // The handler answers with the created resource carrying its own `self`
 * // link; the 201's `Location` header is copied from it: `/articles/1`.
 * const createdDocument = Handlers.data(
 *   Article.make({
 *     id: Article.Id.make("1"),
 *     attributes: { title: "Hello", body: "World" },
 *     links: { self: "/articles/1" }
 *   }),
 *   { self: "/articles/1" }
 * )
 *
 * // …or with a flat command-input body: { title, body }
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.create(Article, { payload: Article.createInput })
 * )
 *
 * // …or answering 200 rather than 201, for an api whose writes are uniform
 * const okArticles = Group.make(
 *   Article,
 *   Endpoint.create(Article, { status: 200 })
 * )
 *
 * // …or accepting an Idempotency-Key, so a retried POST replays rather than
 * // creating a second article (provide `Idempotency.layer(store)`)
 * const idempotentArticles = Group.make(
 *   Article,
 *   Endpoint.create(Article, { idempotency: true })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const create = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "create",
  const Path extends `/${string}` = `/${Type}`,
  DocMeta extends Schema.Top = Meta,
  Payload extends Schema.Top = Resource<Type, Attributes, Rels, Meta, IdSchema>["createPayload"],
  Success extends Schema.Top = DefaultDocument<Type, Attributes, Rels, Meta, IdSchema, DocMeta>,
  const Idem extends Idempotency.Option = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta;
    /**
     * Override the request payload schema. Defaults to the resource's
     * `createPayload` (the JSON:API envelope); pass `resource.createInput` for
     * the flat command-input shape, or any schema of your own.
     */
    readonly payload?: Payload;
    /**
     * The media type the request payload is registered under, which the router
     * matches a request's `Content-Type` against. Defaults to
     * `application/vnd.api+json`; pass `"application/json"` for a host that
     * negotiates §6 upstream and relabels dispatched writes.
     *
     * @since 0.11.0
     */
    readonly payloadMediaType?: string;
    /**
     * Override the success document schema. Defaults to the resource's
     * `document()` (which `meta` then tunes); pass a wire variant of the
     * resource, or any schema of your own — it is served as
     * `application/vnd.api+json`, at the same status as the default.
     *
     * @since 0.10.0
     */
    readonly success?: Success;
    /**
     * The success status. Defaults to 201 — the spec's recommendation for a
     * creation answering with the created resource — whether or not `success`
     * is given. Pass 200 for an api whose creations answer with it.
     *
     * @since 0.11.0
     */
    readonly status?: number;
    /**
     * Declare the `Idempotency-Key` request header and honour it: `true` to
     * accept a key, `"required"` to insist on one. Off by default. Opting in
     * attaches `Idempotency.Middleware`, so the api cannot be built without an
     * `Idempotency.layer(store)`.
     *
     * @since 0.15.0
     */
    readonly idempotency?: Idem;
  },
) =>
  Idempotency.applied(
    HttpApiEndpoint.post(
      (options?.name ?? "create") as Name,
      (options?.path ?? `/${resource.type}`) as Path,
      {
        headers: Idempotency.headersFor(options?.idempotency) as Idempotency.HeadersFor<Idem>,
        payload: asMediaType(
          (options?.payload ?? resource.createPayload) as Payload,
          options?.payloadMediaType ?? MEDIA_TYPE,
        ),
        success: asJsonApi(
          (options?.success ??
            resource.document(
              (options?.meta !== undefined ? { meta: options.meta } : {}) as {
                readonly meta?: DocMeta;
              },
            )) as Success,
          options?.status ?? 201,
        ),
        // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
        error: wires(options?.errors),
      },
    )
      .middleware(ContentNegotiation)
      .middleware(SchemaErrors)
      // Before `Idempotency.applied`, so inside its middleware: the recorded
      // 201 carries `Location`, and a replay returns it.
      .middleware(CreatedLocation)
      // `SchemaErrors` answers a `data.type` of another type with 409 (#428).
      .annotate(ServedTypes, [resource.type]),
    options?.idempotency,
  );

// ---------------------------------------------------------------------------
// update — PATCH /<type>/:id
// ---------------------------------------------------------------------------

/**
 * `PATCH /<type>/:id` — update a resource.
 *
 * The request payload defaults to the resource's `updatePayload` — the nested
 * JSON:API envelope with `id` required and attributes partial; success is a
 * 200 single-resource document containing the updated resource.
 *
 * Pass `payload` to override that envelope with any schema — most usefully the
 * resource's own flat `updateInput` projection, for a write contract that is a
 * flat command input rather than a JSON:API document. Only the request body
 * changes; the `:id` path param, success document, errors and middleware are
 * unaffected.
 *
 * Pass `success` to override the response document the same way — most usefully
 * a *wire* variant of the resource, for an api whose assembler emits a narrower
 * shape than the resource's own decoded types. The two are independent.
 *
 * Pass `status` for an update answering with something other than 200 — `202`
 * for an update accepted but not yet applied, say. It defaults to today's 200.
 *
 * Pass `payloadMediaType` to register the request body under a media type other
 * than `application/vnd.api+json`, for a host that enforces §6 itself and hands
 * the router a relabelled request — see {@link create}.
 *
 * A resource object whose `data.type` names a type other than the resource's
 * is answered with 409 Conflict naming `/data/type` (§Updating Resources → 409
 * Conflict), as {@link create} describes. A `data.id` that differs from `:id`
 * is the handler's to refuse with `ApiError.Conflict`, as
 * `ResourceHandlers.make` does.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // PATCH /articles/:id (partial attributes), body { data: { type, id, attributes } }
 *   Endpoint.update(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or with a flat command-input body: { id, title?, body? }
 * const flatArticles = Group.make(
 *   Article,
 *   Endpoint.update(Article, { payload: Article.updateInput })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const update = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "update",
  const Path extends `/${string}` = `/${Type}/:id`,
  DocMeta extends Schema.Top = Meta,
  Payload extends Schema.Top = Resource<Type, Attributes, Rels, Meta, IdSchema>["updatePayload"],
  Success extends Schema.Top = DefaultDocument<Type, Attributes, Rels, Meta, IdSchema, DocMeta>,
  const Idem extends Idempotency.Option = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta;
    /**
     * Override the request payload schema. Defaults to the resource's
     * `updatePayload` (the JSON:API envelope); pass `resource.updateInput` for
     * the flat command-input shape, or any schema of your own.
     */
    readonly payload?: Payload;
    /**
     * The media type the request payload is registered under, which the router
     * matches a request's `Content-Type` against. Defaults to
     * `application/vnd.api+json`; pass `"application/json"` for a host that
     * negotiates §6 upstream and relabels dispatched writes.
     *
     * @since 0.11.0
     */
    readonly payloadMediaType?: string;
    /**
     * Override the success document schema. Defaults to the resource's
     * `document()` (which `meta` then tunes); pass a wire variant of the
     * resource, or any schema of your own — it is served as
     * `application/vnd.api+json`.
     *
     * @since 0.10.0
     */
    readonly success?: Success;
    /**
     * The success status. Defaults to 200 — the status `HttpApi` gives a
     * success schema carrying a body — whether or not `success` is given.
     *
     * @since 0.11.0
     */
    readonly status?: number;
    /**
     * Declare the `Idempotency-Key` request header and honour it: `true` to
     * accept a key, `"required"` to insist on one. Off by default. Opting in
     * attaches `Idempotency.Middleware`, so the api cannot be built without an
     * `Idempotency.layer(store)`.
     *
     * @since 0.15.0
     */
    readonly idempotency?: Idem;
  },
) =>
  Idempotency.applied(
    HttpApiEndpoint.patch(
      (options?.name ?? "update") as Name,
      (options?.path ?? `/${resource.type}/:id`) as Path,
      {
        params: Schema.Struct({ id: resource.Id }),
        headers: Idempotency.headersFor(options?.idempotency) as Idempotency.HeadersFor<Idem>,
        payload: asMediaType(
          (options?.payload ?? resource.updatePayload) as Payload,
          options?.payloadMediaType ?? MEDIA_TYPE,
        ),
        success: asJsonApi(
          (options?.success ??
            resource.document(
              (options?.meta !== undefined ? { meta: options.meta } : {}) as {
                readonly meta?: DocMeta;
              },
            )) as Success,
          options?.status,
        ),
        // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
        error: wires(options?.errors),
      },
    )
      .middleware(ContentNegotiation)
      .middleware(SchemaErrors)
      // `SchemaErrors` answers a `data.type` of another type with 409 (#428).
      .annotate(ServedTypes, [resource.type]),
    options?.idempotency,
  );

// ---------------------------------------------------------------------------
// delete — DELETE /<type>/:id
// ---------------------------------------------------------------------------

// The success response of a `delete` endpoint. Without an override it is the
// spec's 204 no-content default; an override is served as a JSON:API body,
// defaulting to 200 (the status HttpApi gives a success schema that carries
// one).
const deleteSuccess = (success: Schema.Top | undefined, status: number | undefined): Schema.Top =>
  success === undefined
    ? status === undefined
      ? HttpApiSchema.NoContent
      : HttpApiSchema.NoContent.pipe(HttpApiSchema.status(status))
    : asJsonApi(success, status);

/**
 * `DELETE /<type>/:id` — delete a resource.
 *
 * Success defaults to a 204 No Content response, per the spec's recommendation
 * for deletions with no additional information to return.
 *
 * Pass `success` to answer with a body instead — most usefully the resource's
 * own document, for apis whose delete is a soft delete that returns the
 * tombstone resource. The schema is served as `application/vnd.api+json` like
 * every other body in the package, at 200 unless `status` says otherwise. Only
 * the response changes; the `:id` path param, errors and middleware are
 * unaffected.
 *
 * Exported as `Endpoint.delete`. Because `delete` is a reserved word it cannot
 * be a bare `const` binding, so it is re-exported from the internal
 * `deleteEndpoint` implementation — `Endpoint.delete(...)` is the public name.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // DELETE /articles/:id → 204
 *   Endpoint.delete(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or, for a soft delete answering with the tombstone document (200)
 * const softDeleted = Group.make(
 *   Article,
 *   Endpoint.delete(Article, { success: Article.document(), errors: [ArticleNotFound] })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
const deleteEndpoint = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "delete",
  const Path extends `/${string}` = `/${Type}/:id`,
  Success extends Schema.Top = HttpApiSchema.NoContent,
  const Idem extends Idempotency.Option = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: CommonOptions<Name, Path, Errors> & {
    /**
     * Override the success response schema. Defaults to
     * `HttpApiSchema.NoContent` (204, empty body); pass the resource's
     * `document()` for a soft delete that answers with the tombstone
     * resource, or any schema of your own — it is served as
     * `application/vnd.api+json`.
     */
    readonly success?: Success;
    /**
     * The success status. Defaults to 204 for the no-content default, 200 for
     * a `success` override.
     */
    readonly status?: number;
    /**
     * Declare the `Idempotency-Key` request header and honour it: `true` to
     * accept a key, `"required"` to insist on one. Off by default. Opting in
     * attaches `Idempotency.Middleware`, so the api cannot be built without an
     * `Idempotency.layer(store)`.
     *
     * @since 0.15.0
     */
    readonly idempotency?: Idem;
  },
) =>
  Idempotency.applied(
    HttpApiEndpoint.delete(
      (options?.name ?? "delete") as Name,
      (options?.path ?? `/${resource.type}/:id`) as Path,
      {
        params: Schema.Struct({ id: resource.Id }),
        headers: Idempotency.headersFor(options?.idempotency) as Idempotency.HeadersFor<Idem>,
        success: deleteSuccess(options?.success, options?.status) as Success,
        // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
        error: wires(options?.errors),
      },
    )
      .middleware(ContentNegotiation)
      .middleware(SchemaErrors),
    options?.idempotency,
  );

export type {
  /**
   * The resource definitions a response of an endpoint over `R` with the
   * `include` option `I` can carry in `included`: the non-`paginated` direct
   * targets and, when `I` turns `include` on, every resource a legal include
   * path reaches. The `included` union of a read endpoint that declares
   * `fields` is computed over it, so it is part of that endpoint's inferred
   * type and exported for declaration emit (#348).
   *
   * @since 0.17.0
   * @category type-level
   */
  IncludedResources,
  /**
   * The resource object of `R` with every attribute optional: what the default
   * success document of a read endpoint that declares `fields` admits for each
   * resource type a fieldset can name (#322). Part of those endpoints'
   * inferred types, so exported for declaration emit (#348).
   *
   * @since 0.17.0
   * @category schemas
   */
  SparseResource,
  /**
   * A `Schema.Union` of the sparse forms of `Members`: a family's members, or
   * the resources of a heterogeneous endpoint, each a {@link SparseResource}
   * when a fieldset can name its type. Part of the inferred types of
   * endpoints that declare `fields`, so exported for declaration emit (#348).
   *
   * @since 0.17.0
   * @category schemas
   */
  SparseUnion,
};

export {
  /**
   * `DELETE /<type>/:id` — delete a resource. See {@link deleteEndpoint}.
   *
   * @since 0.1.0
   * @category constructors
   */
  deleteEndpoint as delete,
};

// ---------------------------------------------------------------------------
// collection — GET <path>, heterogeneous collection
// ---------------------------------------------------------------------------

const dedupe = <A>(values: ReadonlyArray<A>): ReadonlyArray<A> => [...new Set(values)];

/**
 * The default compound `included` union of a heterogeneous collection
 * endpoint: the non-`paginated` relationship targets of every member
 * resource, as `Resource.FamilyDefaultIncluded` is for a family. A
 * `paginated` relationship's target never appears in `included`.
 *
 * @since 0.1.0
 * @category models
 */
export interface CollectionIncluded<Resources extends ReadonlyArray<Any>> extends Schema.Union<
  ReadonlyArray<IncludedResources<Resources[number], false>>
> {}

// The `included` union of a heterogeneous collection or a polymorphic
// endpoint: a declared surface's own union, exactly as on `get` / `list` /
// `related` (#336); else its `Default` union, whose members are
// `DefaultMembers` — widened, when the `include` option is `true` or a
// `Query.IncludeOptions`, by every resource a legal include path reaches from
// any of `Members` (#320). Distributes over a widened `include`, as
// `IncludedOf` does (#382): under `include: boolean` it admits what either
// value admits, since the endpoint built from that value may have turned
// `include` on.
type MembersIncludedOf<
  Members extends Any,
  Include,
  Default extends Schema.Top,
  DefaultMembers extends Any,
> = Include extends unknown
  ? IncludeEnabled<Include> extends true
    ? DeclaresSurface<Include> extends true
      ? Include extends { readonly included: infer U extends Schema.Top }
        ? U
        : Default
      : MembersReachableIncluded<Members, Include, DefaultMembers>
    : Default
  : never;

/**
 * The `included` union of a heterogeneous endpoint (`collection`,
 * `polymorphic`) whose `include` option is `true` or a `Query.IncludeOptions`:
 * its default members widened by every resource a legal include path reaches
 * from any of `Members` (#320). Exported, like {@link ReachableIncluded}, so a
 * consumer that emits declarations can name it (#348).
 *
 * @since 0.17.0
 * @category schemas
 */
export interface MembersReachableIncluded<
  Members extends Any,
  Include,
  DefaultMembers extends Any,
> extends Schema.Union<ReadonlyArray<DefaultMembers | IncludedResources<Members, Include>>> {}

// The members of `MembersIncludedOf`'s union, distributed as it is.
type MembersIncludedMembers<
  Members extends Any,
  Include,
  DefaultMembers extends Any,
> = Include extends unknown
  ? IncludeEnabled<Include> extends true
    ? DeclaresSurface<Include> extends true
      ? Include extends { readonly included: { readonly members: ReadonlyArray<infer M> } }
        ? M
        : DefaultMembers
      : DefaultMembers | IncludedResources<Members, Include>
    : DefaultMembers
  : never;

// The success document of a heterogeneous endpoint (`collection`,
// `polymorphic`) over `Members`: its `Default` document, or — when the
// endpoint declares `fields` — the same document with every member of `data`
// and `included` whose type a fieldset names made partial (#322).
type MembersDocument<
  Kind extends "document" | "collection",
  Members extends Any,
  Data extends Schema.Top,
  Include,
  Fields,
  Default extends Schema.Top,
  DefaultMembers extends Any,
  DocMeta extends Schema.Top,
> = [Fields] extends [true]
  ? Kind extends "document"
    ? DataDocument<
        SparseUnion<Members, FieldsetTypes<Members, Include>>,
        SparseUnion<
          MembersIncludedMembers<Members, Include, DefaultMembers>,
          FieldsetTypes<Members, Include>
        >,
        DocMeta
      >
    : CollectionDocument<
        SparseUnion<Members, FieldsetTypes<Members, Include>>,
        SparseUnion<
          MembersIncludedMembers<Members, Include, DefaultMembers>,
          FieldsetTypes<Members, Include>
        >,
        DocMeta
      >
  : Kind extends "document"
    ? DataDocument<Data, MembersIncludedOf<Members, Include, Default, DefaultMembers>, DocMeta>
    : CollectionDocument<
        Data,
        MembersIncludedOf<Members, Include, Default, DefaultMembers>,
        DocMeta
      >;

// The `data` and `included` members of a heterogeneous endpoint's document.
interface DocumentParts {
  readonly data: Schema.Top;
  readonly included: Schema.Top;
}

// The runtime `data` and `included` of a heterogeneous endpoint's document:
// as given, or with every member whose type a fieldset names made partial
// when the endpoint declares `fields`.
const membersDocumentParts = (
  members: ReadonlyArray<Any>,
  options: { readonly include?: IncludeArgument; readonly fields?: boolean },
  data: Schema.Top,
  included: Schema.Top,
): DocumentParts => {
  if (options.fields !== true) return { data, included };
  const types = fieldsetTypes(members, options.include);
  return {
    data: Schema.Union(members.map((member) => sparseMember(member, types))),
    included: sparseUnion(included, types),
  };
};

// The runtime document of `collection`. The cast at its use is sound: every
// non-`paginated` direct target of every member of `Resources` (what
// `directTargets` returns) is, by construction, a member of
// `IncludedResources<..., false>`, every resource an include path reaches one of
// `IncludedResources`, a declared surface's `included` is the union
// `MembersIncludedOf` names for it, and `membersDocumentParts` makes partial
// exactly the members `MembersDocument` does.
const collectionDocument = (
  resources: ReadonlyArray<Any>,
  options: {
    readonly include?: IncludeArgument;
    readonly fields?: boolean;
    readonly meta?: Schema.Top;
  },
): Schema.Top => {
  const { data, included } = membersDocumentParts(
    resources,
    options,
    Schema.Union(resources),
    isSurface(options.include)
      ? options.include.included
      : Option.getOrElse(reachableIncluded(resources, options.include), () =>
          Schema.Union(dedupe(resources.flatMap((resource) => directTargets(resource)))),
        ),
  );
  return CollectionDocument(data, { included, meta: options.meta ?? AnyMeta });
};

/**
 * A heterogeneous collection endpoint: `data` is a mixed array of several
 * resource types, discriminated by their `type` tags. The natural fit for
 * search results, feeds and timelines.
 *
 * A polymorphic collection has no single owning resource and thus no
 * conventional route, so `name` and `path` are required rather than defaulted.
 *
 * Success is a 200 collection document whose `data` member is the union of
 * the given resources and whose `included` union spans all of their
 * non-`paginated` relationship targets and, when `include` is `true` or a
 * `Query.IncludeOptions`, every resource a legal include path reaches. A
 * declared `Include.Surface` derives the union instead, exactly as it does on
 * `get` / `list`: the `included` admits what the surface names, and nothing
 * else.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person)
 *   }
 * })
 *
 * const search = Group.make(
 *   "search",
 *   // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
 *   Endpoint.collection([Article, Person], {
 *     name: "search",
 *     path: "/search",
 *     filter: { q: Schema.String },
 *     include: true,
 *     fields: true,
 *     page: Query.Page.Offset
 *   })
 * )
 * // handler returns { data: ReadonlyArray<Article | Person>, ... }
 * // query.include spans both resources' relationship graphs
 * // ?fields[articles]= and ?fields[people]= are both available
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const collection = <
  const Resources extends ReadonlyArray<Any>,
  const Name extends string,
  const Path extends `/${string}`,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Include extends Query.IncludeOption<Resources[number]> = false,
  const Fields extends boolean = false,
  const Sort extends boolean | ReadonlyArray<AttributeKeys<Resources[number]>> = false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta,
>(
  resources: Resources,
  options: {
    /** Endpoint name within its group (required — a polymorphic collection has no conventional name). */
    readonly name: Name;
    /** Route path, e.g. `/search` or `/feed` (required — a polymorphic collection has no conventional path). */
    readonly path: Path;
    /** `ApiError` classes this endpoint can fail with. */
    readonly errors?: Errors;
    /**
     * Enable the `?include=` query parameter (paths span all resources'
     * graphs), or an `Include.Surface` over one of them — a declared surface,
     * which also derives this endpoint's `included` union.
     */
    readonly include?: Include;
    /**
     * Enable `?fields[TYPE]=` sparse fieldsets for all resources, their
     * non-`paginated` targets (unless `include` is a declared
     * `Include.Surface`) and every type an `include` path reaches. The
     * document's resource objects of those types then admit any subset of
     * their attributes, so a handler can answer with
     * `Handlers.project(query.fields)` — and a client decodes those
     * attributes as optional.
     */
    readonly fields?: Fields;
    /** Enable `?sort=`: `true` for every attribute of every resource, or an explicit list. */
    readonly sort?: Sort;
    /** Enable `?page[*]=` pagination (see `Query.Page` for ready-made strategies). */
    readonly page?: PageFields;
    /** Enable `?filter[*]=` filtering (user-defined fields, e.g. the search term). */
    readonly filter?: FilterFields;
    /** Override the collection document's `meta` schema (e.g. result totals). */
    readonly meta?: DocMeta;
  },
) =>
  HttpApiEndpoint.get(options.name as Name, options.path as Path, {
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
    query: Query.schema(
      resources as ReadonlyArray<Resources[number]>,
      queryConfig(options) as {
        readonly include: Include;
        readonly fields: Fields;
        readonly sort: Sort;
        readonly page: PageFields;
        readonly filter: FilterFields;
      },
    ),
    success: asJsonApi(
      collectionDocument(resources, options) as unknown as MembersDocument<
        "collection",
        Resources[number],
        Schema.Union<Resources>,
        Include,
        Fields,
        CollectionIncluded<Resources>,
        IncludedResources<Resources[number], false>,
        DocMeta
      >,
    ),
    // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
    error: wires(options.errors),
  })
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);

// ---------------------------------------------------------------------------
// polymorphic — GET /<family>/:id (single resource, any family member)
// ---------------------------------------------------------------------------

// The runtime document of `polymorphic`: the family's own `document()`, its
// default `included` union unless `include` is a declared surface (whose own
// union it binds) or reaches further — with every
// member whose type a fieldset names made partial when the endpoint declares
// `fields`. The cast at its use is sound as `collectionDocument`'s is.
const polymorphicDocument = (
  family: Family<string, ReadonlyArray<Any>, any>,
  options?: {
    readonly include?: IncludeArgument;
    readonly fields?: boolean;
    readonly meta?: Schema.Top;
  },
): Schema.Top => {
  // A declared surface's own union (#336), else the walk when `include` is on.
  const reachable = isSurface(options?.include)
    ? Option.some(options.include.included)
    : reachableIncluded(family.members, options?.include);
  if (options?.fields !== true) {
    return family.document({
      ...(options?.meta !== undefined ? { meta: options.meta } : {}),
      // The family's own default union unless `include` declares a surface
      // or reaches further.
      ...Option.match(reachable, {
        onNone: () => ({}),
        onSome: (included) => ({ included }),
      }),
    });
  }
  const { data, included } = membersDocumentParts(
    family.members,
    options,
    family,
    Option.getOrElse(reachable, () => Schema.Union(dedupe(family.members.flatMap(directTargets)))),
  );
  return DataDocument(data, { included, meta: options.meta ?? AnyMeta });
};

/**
 * `GET /<family>/:id` — fetch a single resource that may be any member of a
 * {@link Resource.family} (e.g. `GET /nodes/:id` returning a person or an
 * organisation).
 *
 * Success is a 200 single-resource document whose primary `data` is the family's
 * member union (discriminated by `type`) and whose `included` spans every
 * member's non-`paginated` targets and, when `include` is `true` or a `Query.IncludeOptions`,
 * every resource a legal include path reaches. A declared `Include.Surface`
 * derives the union instead, as on `get`: exactly what the surface names. The `:id` param is the family's
 * shared id, and `?include=` / `?fields[TYPE]=` span all members' graphs.
 *
 * For the collection case (`GET /nodes`) use {@link collection} with
 * `family.members`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Node = Resource.make("nodes", { attributes: { name: Schema.NonEmptyString } })
 * const Person = Resource.extend(Node, "people", { inheritId: true })
 * const Organisation = Resource.extend(Node, "organisations", { inheritId: true })
 * const AnyNode = Resource.family(Node, [Person, Organisation])
 *
 * const nodes = Group.make(
 *   AnyNode,
 *   Endpoint.polymorphic(AnyNode, { include: true }) // GET /nodes/:id → person | organisation
 * )
 * ```
 *
 * @since 0.4.0
 * @category constructors
 */
export const polymorphic = <
  FamilyName extends string,
  Members extends ReadonlyArray<Any>,
  Base extends Any | undefined,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "get",
  const Path extends `/${string}` = `/${FamilyName}/:id`,
  const Include extends Query.IncludeOption<Members[number]> = false,
  const Fields extends boolean = false,
  DocMeta extends Schema.Top = typeof AnyMeta,
>(
  family: Family<FamilyName, Members, Base>,
  options?: CommonOptions<Name, Path, Errors> & {
    /**
     * Enable the `?include=` query parameter (paths span all members'
     * graphs), or an `Include.Surface` over one of them — a declared surface,
     * which also derives this endpoint's `included` union.
     */
    readonly include?: Include;
    /**
     * Enable `?fields[TYPE]=` sparse fieldsets for all members, their
     * non-`paginated` targets (unless `include` is a declared
     * `Include.Surface`) and every type an `include` path reaches. The
     * document's resource objects of those types then admit any subset of
     * their attributes, so a handler can answer with
     * `Handlers.project(query.fields)` — and a client decodes those
     * attributes as optional.
     */
    readonly fields?: Fields;
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta;
  },
) =>
  HttpApiEndpoint.get(
    (options?.name ?? "get") as Name,
    (options?.path ?? `/${family.type}/:id`) as Path,
    {
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      params: Schema.Struct({ id: family.Id }),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      query: Query.schema(
        family.members as ReadonlyArray<Members[number]>,
        queryConfig(options) as {
          readonly include: Include;
          readonly fields: Fields;
          readonly sort: false;
          readonly page: undefined;
          readonly filter: undefined;
        },
      ),
      success: asJsonApi(
        polymorphicDocument(family, options) as unknown as MembersDocument<
          "document",
          Members[number],
          Schema.Union<Members>,
          Include,
          Fields,
          FamilyDefaultIncluded<Members>,
          IncludedResources<Members[number], false>,
          DocMeta
        >,
      ),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);

// ---------------------------------------------------------------------------
// Relationship endpoints — shared type machinery
// ---------------------------------------------------------------------------

// Resolves to `T` for every concrete relationship; needed because conditional
// types over a still-generic resource can't be proven to satisfy `Schema.Top`.
type AsSchema<T> = T extends Schema.Top ? T : never;

/**
 * The descriptor of a named relationship.
 */
type DescriptorOf<R extends Any, Name extends string> = R["relationships"][Name &
  keyof R["relationships"]];

/**
 * The linkage (`data`) schema of a relationship, by kind:
 *
 *   - `one` → the target's identifier (never null)
 *   - `optional` → the target's identifier or null
 *   - `many` / `paginated` → an array of the target's identifiers
 *
 * @since 0.1.0
 * @category type-level
 */
export type LinkageData<R extends Any, Name extends string> =
  DescriptorOf<R, Name> extends Relationship.One<infer T extends Any>
    ? T["identifier"]
    : DescriptorOf<R, Name> extends Relationship.Optional<infer T extends Any>
      ? Schema.NullOr<AsSchema<T["identifier"]>>
      : DescriptorOf<R, Name> extends Relationship.ToMany<infer T extends Any>
        ? Schema.$Array<AsSchema<T["identifier"]>>
        : never;

/**
 * The success document schema of a relationship endpoint: a linkage document
 * whose `data` member matches the relationship's kind. When `Include` turns
 * `?include=` on ({@link getRelationship}), it is a compound document whose
 * optional `included` admits {@link RelationshipIncludedOf}; otherwise it has
 * no `included` member.
 *
 * @since 0.1.0 (`Include` since 0.18.0)
 * @category type-level
 */
export type RelationshipSuccess<
  R extends Any,
  Name extends string,
  DocMeta extends Schema.Top,
  Include = false,
> = LinkageDocument<
  AsSchema<LinkageData<R, Name>>,
  DocMeta,
  AsSchema<RelationshipIncludedOf<R, Name, Include>>
>;

// The paths of `P` rooted at the relationship `Name`: `Name` itself and every
// dotted path whose first segment it is.
type RootedAt<P, Name extends string> = Extract<P, Name | `${Name}.${string}`>;

/**
 * Constrains the `?include=` paths {@link getRelationship} advertises, as
 * `Query.IncludeOptions` does for the other read endpoints. The paths are the
 * parent resource's, rooted at the relationship (JSON:API 1.1: `GET
 * /articles/1/relationships/comments?include=comments.author`), so each one's
 * first segment is the relationship's name.
 *
 * Pass `paths` for an explicit allow-list — every one rooted at the
 * relationship — or `depth` to bound the derivation, counted from the parent
 * (`1` — the relationship itself, `2` — the default, one hop further, `3`).
 *
 * @since 0.18.0
 * @category models
 */
export interface RelationshipIncludeOptions<R extends Any, Name extends string> {
  /** The exact set of legal paths, each rooted at the relationship. Anything else fails decoding (→ 400). */
  readonly paths?: ReadonlyArray<RootedAt<IncludePathsTo<R, 3>, Name>>;
  /** How many hops from the parent resource to derive. Defaults to 2. */
  readonly depth?: IncludeDepth;
  /**
   * Declared `never` so that a declared `Include.Surface` never satisfies
   * this arm of {@link RelationshipIncludeOption}, as on `Query.IncludeOptions`.
   *
   * @internal
   */
  readonly "~@thomasfosterau/effect-jsonapi/include"?: never;
}

/**
 * The `include` option of {@link getRelationship}: `false` (the default, no
 * `?include=` parameter), `true` (the parent resource's include paths rooted
 * at the relationship, to a depth of 2 from the parent), a
 * {@link RelationshipIncludeOptions} constraining that derivation, or a
 * declared `Include.Surface` over the parent resource whose every path is
 * rooted at the relationship (`Include.make(Article, { comments: … })`), which
 * also derives the document's `included` union.
 *
 * @since 0.18.0
 * @category models
 */
export type RelationshipIncludeOption<R extends Any, Name extends string> =
  | boolean
  | RelationshipIncludeOptions<R, Name>
  | (SurfaceFor<R> & { readonly paths: ReadonlyArray<Name | `${Name}.${string}`> });

/**
 * The `?include=` paths a {@link getRelationship} over `R`'s relationship
 * `Name` with the `include` option `Include` legalises: the parent resource's
 * legal include paths (`Query.IncludePathsOf`) rooted at the relationship —
 * `never` while `include` is off. Under `include: true` on a `comments`
 * relationship whose target has an `author`: `"comments" | "comments.author"`.
 *
 * A `paginated` relationship is never an include path of its parent, so its
 * relationship endpoint legalises none.
 *
 * @since 0.18.0
 * @category type-level
 */
export type RelationshipIncludePaths<R extends Any, Name extends string, Include> =
  IncludeEnabled<Include> extends true ? RootedAt<Query.IncludePathsOf<R, Include>, Name> : never;

/**
 * The `included` union of a compound relationship document: every resource
 * a legal {@link RelationshipIncludePaths} path reaches from the parent — the
 * relationship's target and every resource further along each path.
 * Exported so a consumer that emits declarations can name it (#348).
 *
 * @since 0.18.0
 * @category schemas
 */
export interface RelationshipIncluded<
  R extends Any,
  Name extends string,
  Include,
> extends Schema.Union<
  ReadonlyArray<ResolveIncludePath<R, RelationshipIncludePaths<R, Name, Include>>>
> {}

/**
 * The `included` union {@link getRelationship}'s document carries: a declared
 * surface's own union; else, while `include` is on,
 * {@link RelationshipIncluded}; else `Schema.Never`, and the document has no
 * `included` member.
 *
 * @since 0.18.0
 * @category type-level
 */
export type RelationshipIncludedOf<R extends Any, Name extends string, Include> =
  IncludeEnabled<Include> extends true
    ? Include extends { readonly included: infer U extends Schema.Top }
      ? U
      : RelationshipIncluded<R, Name, Include>
    : typeof Schema.Never;

// The `include` option `getRelationship` hands `Query.schema` over the parent
// resource: a declared surface as it stands (its paths are all rooted at the
// relationship), else the rooted paths as an explicit allow-list, else off.
type RelationshipQueryInclude<R extends Any, Name extends string, Include> = [Include] extends [
  AnySurface,
]
  ? Include
  : IncludeEnabled<Include> extends true
    ? {
        readonly paths: ReadonlyArray<
          Extract<RelationshipIncludePaths<R, Name, Include>, IncludePathsTo<R, 3>>
        >;
      }
    : false;

// Whether an include path is rooted at the relationship `name`.
const rootedAt =
  (name: string) =>
  (path: string): boolean =>
    path === name || path.startsWith(`${name}.`);

// The runtime `RelationshipIncludePaths`: `None` while `include` is off, else
// the parent's legal paths rooted at the relationship. An explicit allow-list
// or a surface naming a path outside the relationship is a programmer error
// (also a compile error at the call site), so it throws.
const relationshipIncludePaths = (
  resource: Any,
  name: string,
  include: IncludeArgument | undefined,
): Option.Option<ReadonlyArray<string>> => {
  if (include === undefined || include === false) return Option.none();
  if (include !== true && include.paths !== undefined) {
    const outside = include.paths.filter((path) => !rootedAt(name)(path));
    if (Arr.isReadonlyArrayNonEmpty(outside)) {
      throw new Error(
        `Endpoint.getRelationship: include path(s) ${outside.map((path) => `"${path}"`).join(", ")} ` +
          `are not rooted at the relationship "${name}" of "${resource.type}"`,
      );
    }
    return Option.some(includePathsFor([resource], include));
  }
  return Option.some(
    includePathsFor([resource], include === true ? undefined : include).filter(rootedAt(name)),
  );
};

/**
 * The request payload schema of a relationship mutation: `{ data: linkage }`.
 *
 * @since 0.1.0
 * @category models
 */
export interface LinkagePayload<R extends Any, Name extends string> extends Schema.Struct<{
  readonly data: AsSchema<LinkageData<R, Name>>;
}> {}

/**
 * The success document schema of a related-resource endpoint:
 *
 *   - to-one relationships → a single-resource document of the target with
 *     *nullable* primary `data` (`data: target | null`) — the spec permits an
 *     empty-linkage `data: null` for a to-one related URL
 *   - to-many relationships → a collection document of the target
 *
 * When `Fields` is `true` (the endpoint declares `fields`), the target and
 * every `included` member whose type a fieldset names admit any subset of
 * their attributes, so a projected answer encodes (§Sparse Fieldsets).
 *
 * @since 0.1.0 (`Fields` since 0.17.0)
 * @category type-level
 */
export type RelatedSuccess<
  R extends Any,
  Name extends string,
  DocMeta extends Schema.Top,
  Include = false,
  Fields = false,
> =
  DescriptorOf<R, Name> extends Relationship.ToOne<infer T extends Any>
    ? [Fields] extends [true]
      ? DataDocument<
          Schema.NullOr<AsSchema<SparseMember<T, FieldsetTypes<T, Include>>>>,
          SparseIncluded<T, Include>,
          DocMeta
        >
      : DataDocument<Schema.NullOr<T>, IncludedOf<T, Include>, DocMeta>
    : DescriptorOf<R, Name> extends Relationship.ToMany<infer T extends Any>
      ? [Fields] extends [true]
        ? CollectionDocument<
            AsSchema<SparseMember<T, FieldsetTypes<T, Include>>>,
            SparseIncluded<T, Include>,
            DocMeta
          >
        : CollectionDocument<T, IncludedOf<T, Include>, DocMeta>
      : never;

const capitalize = (value: string): string => value.charAt(0).toUpperCase() + value.slice(1);

// Looks up a relationship descriptor by name; an unknown name is a programmer
// error (it is also a compile error at the constructor's call site).
const descriptorFor = (resource: Any, name: string): Relationship.Descriptor => {
  const descriptor = (resource.relationships as Record<string, Relationship.Descriptor>)[name];
  if (descriptor === undefined) {
    throw new Error(`Unknown relationship "${name}" on resource "${resource.type}"`);
  }
  return descriptor;
};

// The runtime linkage (`data`) schema for a relationship descriptor.
const linkageData = (descriptor: Relationship.Descriptor, target: Any): Schema.Top =>
  descriptor.kind === "one"
    ? target.identifier
    : descriptor.kind === "optional"
      ? Schema.NullOr(target.identifier)
      : Schema.Array(target.identifier);

// ---------------------------------------------------------------------------
// related — GET /<type>/:id/<name>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id/<name>` — fetch the resource(s) a relationship points at.
 *
 * This is the endpoint a relationship's `related` link refers to. For to-one
 * relationships success is a single-resource document of the target; for
 * to-many relationships it is a collection document, with the full set of
 * collection query parameters (`include`, `fields`, `sort`, `page`, `filter`)
 * available. The `included` union is derived from the *target's* graph as
 * {@link get} derives it from the resource's.
 *
 * For `paginated` relationships this *is* the collection their required
 * `links.related` member points at — enable `page` here.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id/author — the author, as a full resource
 *   Endpoint.related(Article, "author", { errors: [ArticleNotFound] }),
 *   // GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author
 *   Endpoint.related(Article, "comments", {
 *     include: true,
 *     page: Query.Page.Offset,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const related = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = Name,
  const Path extends `/${string}` = `/${Type}/:id/${Name}`,
  const Include extends Query.IncludeOption<
    Target<Resource<Type, Attributes, Rels, Meta, IdSchema>, Name>
  > = false,
  const Fields extends boolean = false,
  const Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Target<Resource<Type, Attributes, Rels, Meta, IdSchema>, Name>>> =
    false,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  const FilterFields extends Query.FilterOption | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /**
     * Enable the `?include=` query parameter (paths span the *target's*
     * graph). A declared `Include.Surface` over the target also derives this
     * endpoint's `included` union.
     */
    readonly include?: Include;
    /**
     * Enable `?fields[TYPE]=` sparse fieldsets for the target, its
     * non-`paginated` targets (unless `include` is a declared
     * `Include.Surface`) and every type an `include` path reaches. The
     * document's resource objects of those types then admit any subset of
     * their attributes, so a handler can answer with
     * `Handlers.project(query.fields)` — and a client decodes those
     * attributes as optional.
     */
    readonly fields?: Fields;
    /** Enable `?sort=` over the target's attributes (to-many relationships). */
    readonly sort?: Sort;
    /** Enable `?page[*]=` pagination (to-many relationships; see `Query.Page`). */
    readonly page?: PageFields;
    /** Enable `?filter[*]=` filtering: `true` for the grammar over the *target's* declaration, or a field map. */
    readonly filter?: FilterFields;
    /** Override the success document's `meta` schema. */
    readonly meta?: DocMeta;
  },
) => {
  type R = Resource<Type, Attributes, Rels, Meta, IdSchema>;
  const descriptor = descriptorFor(resource, name);
  const target = descriptor.ref();
  // A declared surface over the *target* derives the union its document
  // carries, exactly as it does for `get` / `list`; otherwise the target's own
  // relationship graph does — every resource its legal include paths reach
  // when `include` is on (#320).
  const included = isSurface(options?.include)
    ? options.include.included
    : Option.getOrElse(reachableIncluded([target], options?.include), () =>
        Schema.Union(directTargets(target)),
      );
  const docMeta = (options?.meta ?? AnyMeta) as DocMeta;
  // Declaring `fields` makes the target and every `included` member whose type
  // a fieldset names partial (#322).
  const types = options?.fields === true ? fieldsetTypes([target], options.include) : undefined;
  const data = types === undefined ? target : sparseMember(target, types);
  const includedUnion = types === undefined ? included : sparseUnion(included, types);
  // The cast is sound: the runtime schema mirrors `RelatedSuccess` exactly — a
  // nullable single-resource document for to-one descriptors (`data: null` is
  // the empty-linkage case), a collection document otherwise. `included` keys
  // off the target's relationship graph, independent of the `data` wrapper.
  const success = (Relationship.isToOne(descriptor)
    ? DataDocument(Schema.NullOr(data), { included: includedUnion, meta: docMeta })
    : CollectionDocument(data, { included: includedUnion, meta: docMeta })) as unknown as AsSchema<
    RelatedSuccess<R, Name, DocMeta, Include, Fields>
  >;

  return HttpApiEndpoint.get(
    (options?.name ?? name) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/${name}`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      query: Query.schema(
        target as Target<R, Name>,
        queryConfig(options) as {
          readonly include: Include;
          readonly fields: Fields;
          readonly sort: Sort;
          readonly page: PageFields;
          readonly filter: FilterFields;
        },
      ),
      success: asJsonApi(success),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);
};

// ---------------------------------------------------------------------------
// getRelationship — GET /<type>/:id/relationships/<name>
// ---------------------------------------------------------------------------

/**
 * `GET /<type>/:id/relationships/<name>` — get a relationship's linkage.
 *
 * Success is a 200 linkage document: `data` is a single identifier (`one`),
 * an identifier or null (`optional`), or an identifier array (`many` /
 * `paginated`) — never full resource objects.
 *
 * For `paginated` relationships the identifier collection itself can be
 * paginated — enable `page`.
 *
 * Enable `include` to serve a compound relationship document (JSON:API 1.1
 * §Inclusion of Related Resources): `GET
 * /articles/1/relationships/comments?include=comments.author` answers the
 * comment identifiers as `data`, and the comments and their authors in
 * `included`. Include paths are the *parent* resource's, rooted at the
 * relationship, so each one's first segment is the relationship's name; the
 * legal set is the parent's include paths that start with it (see
 * {@link RelationshipIncludeOption}), and any other path is a 400. The
 * document's `included` union is every resource those paths reach. Full
 * linkage applies: each `included` member must be reachable from the
 * identifiers (`Handlers.linkage`'s `included` option checks it). A
 * `paginated` relationship is never an include path, so it has none to
 * legalise.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment),
 *     replies: Relationship.many(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // GET /articles/:id/relationships/comments?page[offset]=0&page[limit]=10
 *   Endpoint.getRelationship(Article, "comments", {
 *     page: Query.Page.Offset,
 *     errors: [ArticleNotFound]
 *   }),
 *   // GET /articles/:id/relationships/replies?include=replies.author — a
 *   // compound relationship document: `replies` and `replies.author` are legal
 *   Endpoint.getRelationship(Article, "replies", {
 *     include: true,
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-relationships}
 * @see {@link https://jsonapi.org/format/1.1/#fetching-includes}
 * @since 0.1.0 (`include` since 0.18.0)
 * @category constructors
 */
export const getRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `${Name}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  const PageFields extends Schema.Struct.Fields | undefined = undefined,
  DocMeta extends Schema.Top = typeof AnyMeta,
  const Include extends RelationshipIncludeOption<
    Resource<Type, Attributes, Rels, Meta, IdSchema>,
    Name
  > = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Enable `?page[*]=` pagination of the identifier collection (to-many linkage). */
    readonly page?: PageFields;
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta;
    /**
     * Enable the `?include=` query parameter, making the success document a
     * compound relationship document: `true` for the parent's include paths
     * rooted at the relationship (depth 2 from the parent), a
     * {@link RelationshipIncludeOptions} object to constrain them, or a
     * declared `Include.Surface` over the parent whose paths are all rooted
     * at the relationship, which also derives the `included` union.
     *
     * @since 0.18.0
     */
    readonly include?: Include;
  },
) => {
  type R = Resource<Type, Attributes, Rels, Meta, IdSchema>;
  const descriptor = descriptorFor(resource, name);
  const target = descriptor.ref();
  // SAFETY: every `RelationshipIncludeOption` is an `IncludeArgument` at
  // runtime — a boolean, a `{ paths?, depth? }` object, or a surface.
  const include = options?.include as IncludeArgument | undefined;
  const includable = relationshipIncludePaths(resource, name, include);
  // A declared surface's own union, else every resource the rooted paths
  // reach from the parent — the target first. Absent while `include` is off,
  // so the document has no `included` member.
  const included = Option.map(includable, (paths) =>
    isSurface(include)
      ? include.included
      : Schema.Union(includedResources([resource], true, paths)),
  );
  // SAFETY: `linkageData` mirrors `LinkageData` kind by kind, and `included`
  // mirrors `RelationshipIncludedOf`.
  const success = LinkageDocument(linkageData(descriptor, target), {
    meta: (options?.meta ?? AnyMeta) as DocMeta,
    included: Option.getOrUndefined(included),
  }) as unknown as RelationshipSuccess<R, Name, DocMeta, Include>;

  return HttpApiEndpoint.get(
    (options?.name ?? `${name}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream); TS7 anchors the overload failure here
      query: Query.schema(
        // SAFETY: `Parameter` is the resource definition `R` names. The query
        // is the parent's: its include paths are rooted at the relationship,
        // and nothing else it declares depends on the resource it is built over.
        resource as R,
        {
          include: Option.match(includable, {
            onNone: () => false,
            onSome: (paths) => (isSurface(include) ? include : { paths }),
          }),
          fields: false,
          sort: false,
          page: options?.page,
          filter: undefined,
        } as {
          readonly include: RelationshipQueryInclude<R, Name, Include>;
          readonly fields: false;
          readonly sort: false;
          readonly page: PageFields;
          readonly filter: undefined;
        },
      ),
      success: asJsonApi(success),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);
};

// ---------------------------------------------------------------------------
// updateRelationship — PATCH /<type>/:id/relationships/<name>
// ---------------------------------------------------------------------------

/**
 * `PATCH /<type>/:id/relationships/<name>` — replace a relationship's linkage.
 *
 * The payload is the full replacement linkage:
 *
 *   - `one` → `{ data: identifier }` (a required relationship can't be cleared)
 *   - `optional` → `{ data: identifier | null }`
 *   - `many` / `paginated` → `{ data: identifier[] }` (full replacement)
 *
 * Success is a 200 linkage document with the updated linkage.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // PATCH /articles/:id/relationships/author — replace the author
 *   Endpoint.updateRelationship(Article, "author", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const updateRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  const Name extends keyof Rels & string,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `update${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  DocMeta extends Schema.Top = typeof AnyMeta,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta;
  },
) => {
  type R = Resource<Type, Attributes, Rels, Meta, IdSchema>;
  const descriptor = descriptorFor(resource, name);
  const target = descriptor.ref();
  const data = linkageData(descriptor, target);
  // The casts are sound: the runtime schemas mirror the conditional types kind by kind.
  const payload = Schema.Struct({ data }) as unknown as LinkagePayload<R, Name>;
  const success = LinkageDocument(data, {
    meta: (options?.meta ?? AnyMeta) as DocMeta,
  }) as unknown as RelationshipSuccess<R, Name, DocMeta>;

  return HttpApiEndpoint.patch(
    (options?.name ?? `update${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      payload: asJsonApi(payload),
      success: asJsonApi(success),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);
};

// ---------------------------------------------------------------------------
// addRelationship — POST /<type>/:id/relationships/<name> (to-many only)
// ---------------------------------------------------------------------------

/**
 * `POST /<type>/:id/relationships/<name>` — add members to a to-many
 * relationship.
 *
 * Only `many` / `paginated` relationships have this endpoint (the spec defines
 * POST only for to-many relationship URLs). The payload is the identifiers to
 * add; members already present are ignored. Success is a 200 linkage document
 * with the resulting linkage.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // POST /articles/:id/relationships/comments — attach existing comments
 *   Endpoint.addRelationship(Article, "comments", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-to-many-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const addRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  const Name extends ToManyName<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `add${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
  DocMeta extends Schema.Top = typeof AnyMeta,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors> & {
    /** Override the linkage document's `meta` schema. */
    readonly meta?: DocMeta;
  },
) => {
  type R = Resource<Type, Attributes, Rels, Meta, IdSchema>;
  const descriptor = descriptorFor(resource, name);
  const target = descriptor.ref();
  const data = Schema.Array(target.identifier);
  // The casts are sound: to-many linkage is always an identifier array.
  const payload = Schema.Struct({ data }) as unknown as LinkagePayload<R, Name>;
  const success = LinkageDocument(data, {
    meta: (options?.meta ?? AnyMeta) as DocMeta,
  }) as unknown as RelationshipSuccess<R, Name, DocMeta>;

  return HttpApiEndpoint.post(
    (options?.name ?? `add${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      payload: asJsonApi(payload),
      success: asJsonApi(success),
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);
};

// ---------------------------------------------------------------------------
// removeRelationship — DELETE /<type>/:id/relationships/<name> (to-many only)
// ---------------------------------------------------------------------------

/**
 * `DELETE /<type>/:id/relationships/<name>` — remove members from a to-many
 * relationship.
 *
 * Only `many` / `paginated` relationships have this endpoint. The payload is
 * the identifiers to remove; members not present are ignored. Success is a
 * 204 No Content response.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   // DELETE /articles/:id/relationships/comments → 204 — detach comments
 *   Endpoint.removeRelationship(Article, "comments", {
 *     errors: [ArticleNotFound]
 *   })
 * )
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#crud-updating-to-many-relationships}
 * @since 0.1.0
 * @category constructors
 */
export const removeRelationship = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  const Name extends ToManyName<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const EndpointName extends string = `remove${Capitalize<Name>}Relationship`,
  const Path extends `/${string}` = `/${Type}/:id/relationships/${Name}`,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  name: Name,
  options?: CommonOptions<EndpointName, Path, Errors>,
) => {
  type R = Resource<Type, Attributes, Rels, Meta, IdSchema>;
  const descriptor = descriptorFor(resource, name);
  const target = descriptor.ref();
  // The cast is sound: to-many linkage is always an identifier array.
  const payload = Schema.Struct({
    data: Schema.Array(target.identifier),
  }) as unknown as LinkagePayload<R, Name>;

  return HttpApiEndpoint.delete(
    (options?.name ?? `remove${capitalize(name)}Relationship`) as EndpointName,
    (options?.path ?? `/${resource.type}/:id/relationships/${name}`) as Path,
    {
      params: Schema.Struct({ id: resource.Id }),
      payload: asJsonApi(payload),
      success: HttpApiSchema.NoContent,
      // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
      error: wires(options?.errors),
    },
  )
    .middleware(ContentNegotiation)
    .middleware(SchemaErrors);
};

// ---------------------------------------------------------------------------
// operations — POST /operations, atomic operations extension
// ---------------------------------------------------------------------------

/**
 * `POST /operations` (path configurable) — the
 * {@link https://jsonapi.org/ext/atomic/ atomic operations extension}: a
 * single request carrying an ordered list of operations — creating, updating
 * and deleting resources or their relationships — that the handler processes
 * atomically.
 *
 * The request payload is an `atomic:operations` document whose operation union
 * spans every operation legal for the given resources (including relationship
 * operations and lid-based refs); success is a 200 `atomic:results` document
 * whose entries correspond to the operations, in order.
 *
 * Spec-compliant clients send the JSON:API media type with the
 * `ext="https://jsonapi.org/ext/atomic"` parameter — provide the
 * content-negotiation middleware via
 * `Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })` so those
 * requests are accepted.
 *
 * The default request document does not support client-generated ids: an
 * `add` operation carrying a `data.id` is answered with 403 Forbidden,
 * `source.pointer` `/atomic:operations/N/data/id`, and the handler never
 * runs, so no operation is performed (§Client-Generated IDs, which the
 * extension's §Processing Errors applies to an operation; #464). To support
 * them, pass a `payload` whose `add` declares an `id` — the default `add`'s
 * fields with one more in `data`, placed ahead of the default operations:
 * `Schema.Struct({ "atomic:operations": Schema.Array(Schema.Union([AddWithId,
 * ...Atomic.Operations(resources).members])).check(Schema.isMinLength(1)) })`
 * — and the handler receives it; answering a duplicate with 409 is then the
 * handler's to do.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { ApiError, Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     editor: Relationship.optional(() => Person),
 *     tags: Relationship.many(() => Tag),
 *     comments: Relationship.paginated(() => Comment)
 *   }
 * })
 *
 * class OperationFailed extends ApiError.make<OperationFailed>()("OperationFailed", {
 *   status: 422,
 *   fields: { operation: Schema.Int, reason: Schema.String }
 * }) {}
 *
 * const operations = Group.make(
 *   "operations",
 *   // POST /operations with an atomic:operations document
 *   Endpoint.operations([Article, Comment], {
 *     errors: [OperationFailed]
 *   })
 * )
 * // payload:  { "atomic:operations": [{ op: "add", data: {...} }, ...] }
 * // success:  { "atomic:results": [{ data: {...} }, ...] }   (200)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const operations = <
  const Resources extends ReadonlyArray<Any>,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Name extends string = "operations",
  const Path extends `/${string}` = "/operations",
  DocMeta extends Schema.Top = typeof AnyMeta,
  const Idem extends Idempotency.Option = false,
  Payload extends Schema.Top = Atomic.RequestDocument<Resources[number]>,
>(
  resources: Resources,
  options?: CommonOptions<Name, Path, Errors> & {
    /** Override the result document's `meta` schema. */
    readonly meta?: DocMeta;
    /**
     * Override the request payload schema. Defaults to
     * `Atomic.RequestDocument(resources)`, whose `add` operations refuse a
     * client-generated `data.id` with 403; pass a request document of your
     * own — one whose `add` declares an `id`, say — to accept what it
     * declares.
     *
     * @since 0.18.0
     */
    readonly payload?: Payload;
    /**
     * Declare the `Idempotency-Key` request header and honour it. One key
     * covers the **whole** request — the extension's own unit of atomicity —
     * and replays the whole `atomic:results` document.
     *
     * @since 0.15.0
     */
    readonly idempotency?: Idem;
  },
) =>
  Idempotency.applied(
    HttpApiEndpoint.post(
      (options?.name ?? "operations") as Name,
      (options?.path ?? "/operations") as Path,
      {
        headers: Idempotency.headersFor(options?.idempotency) as Idempotency.HeadersFor<Idem>,
        // SAFETY: `Payload` is inferred from `options.payload` when one is
        // passed, and otherwise defaults to the `Atomic.RequestDocument` built here.
        payload: asJsonApi((options?.payload ?? Atomic.RequestDocument(resources)) as Payload),
        success: asJsonApiAtomic(
          Atomic.ResultDocument(
            resources,
            (options?.meta !== undefined ? { meta: options.meta } : {}) as {
              readonly meta?: DocMeta;
            },
          ),
        ),
        // @ts-expect-error effect ErrorNoStream guard is unprovable for a generic Errors (our error wires never stream)
        error: wires(options?.errors),
      },
    )
      .middleware(ContentNegotiation)
      .middleware(SchemaErrors),
    options?.idempotency,
  );

// ---------------------------------------------------------------------------
// resource — generate an entire endpoint set from a resource definition
// ---------------------------------------------------------------------------

/**
 * The CRUD operation names {@link resource} can emit.
 *
 * @since 0.1.0
 * @category models
 */
export type CrudOperation = "get" | "list" | "create" | "update" | "delete";

/**
 * A `meta` option for a generated document: a `Schema` (overriding the meta
 * schema) or a function that builds one from the resource's base meta schema
 * (extending rather than replacing it).
 *
 * @since 0.1.0
 * @category models
 */
export type MetaOption<Meta extends Schema.Top> = Schema.Top | ((base: Meta) => Schema.Top);

/**
 * Per-endpoint configuration for the read-one (`get`) endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface GetConfig<Meta extends Schema.Top, R extends Any = Any> {
  readonly name?: string;
  readonly path?: `/${string}`;
  readonly errors?: ReadonlyArray<ErrorClass>;
  /**
   * Enable `?include=`. `true` legalises the resource's whole relationship
   * graph to a depth of 2; a `Query.IncludeOptions` object constrains that to
   * an explicit `paths` allow-list and/or a `depth` bound; an
   * `Include.Surface` legalises exactly a declared surface and derives the
   * matching `included` union for this endpoint's document.
   */
  readonly include?: Query.IncludeOption<R>;
  readonly fields?: boolean;
  readonly meta?: MetaOption<Meta>;
  /**
   * Override the whole query schema. Defaults to the `Query.schema`
   * composition of `include` / `fields`; pass any schema for a read contract of
   * your own. `ListConfig` documents the collection counterpart.
   *
   * @since 0.11.0
   */
  readonly query?: Schema.Top;
  /**
   * Override the success document schema. Defaults to the resource's
   * `document()` (which `meta` then tunes); pass a wire variant of the
   * resource, or any schema of your own.
   *
   * @since 0.10.0
   */
  readonly success?: Schema.Top;
}

/**
 * Per-endpoint configuration for the collection (`list`) endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface ListConfig<R extends Any, Meta extends Schema.Top> extends GetConfig<Meta, R> {
  readonly sort?: boolean | ReadonlyArray<AttributeKeys<R>>;
  readonly page?: Schema.Struct.Fields;
  /** `true` for the filter grammar over the resource's declaration, or a per-key field map. */
  readonly filter?: Query.FilterOption;
  /**
   * Override the whole query schema. Defaults to the `Query.schema`
   * composition of `include` / `fields` / `sort` / `page` / `filter`; pass any
   * schema for a list contract of your own.
   */
  readonly query?: Schema.Top;
  /**
   * Override the success document schema. Defaults to the resource's
   * `collection()` (which `meta` then tunes); pass a collection document over a
   * wire variant of the resource, or any schema of your own.
   *
   * @since 0.10.0
   */
  readonly success?: Schema.Top;
}

/**
 * Per-endpoint configuration for the `create` / `update` endpoints.
 *
 * @since 0.1.0
 * @category models
 */
export interface WriteConfig<Meta extends Schema.Top> {
  readonly name?: string;
  readonly path?: `/${string}`;
  readonly errors?: ReadonlyArray<ErrorClass>;
  readonly meta?: MetaOption<Meta>;
  /**
   * Override the request payload schema. Defaults to the resource's
   * `createPayload` / `updatePayload` (the JSON:API envelope); pass the
   * resource's flat `createInput` / `updateInput`, or any schema of your own.
   */
  readonly payload?: Schema.Top;
  /**
   * The media type the request payload is registered under, which the router
   * matches a request's `Content-Type` against. Defaults to
   * `application/vnd.api+json`; pass `"application/json"` for a host that
   * negotiates §6 upstream and relabels dispatched writes.
   *
   * @since 0.11.0
   */
  readonly payloadMediaType?: string;
  /**
   * Override the success document schema. Defaults to the resource's
   * `document()` (which `meta` then tunes); pass a wire variant of the
   * resource, or any schema of your own.
   *
   * @since 0.10.0
   */
  readonly success?: Schema.Top;
  /**
   * The success status. Defaults to 201 for `create` (the spec's
   * recommendation) and 200 for `update`, whether or not `success` is given.
   *
   * @since 0.11.0
   */
  readonly status?: number;
  /**
   * Declare the `Idempotency-Key` request header on this endpoint and honour
   * it: `true` to accept a key, `"required"` to insist on one.
   *
   * @since 0.15.0
   */
  readonly idempotency?: Idempotency.Option;
}

/**
 * Per-endpoint configuration for the `delete` endpoint.
 *
 * @since 0.1.0
 * @category models
 */
export interface DeleteConfig {
  readonly name?: string;
  readonly path?: `/${string}`;
  readonly errors?: ReadonlyArray<ErrorClass>;
  /**
   * Override the success response schema. Defaults to `HttpApiSchema.NoContent`
   * (204, empty body); pass the resource's `document()` for a soft delete that
   * answers with the tombstone resource, or any schema of your own.
   */
  readonly success?: Schema.Top;
  /**
   * The success status. Defaults to 204 for the no-content default, 200 for a
   * `success` override.
   */
  readonly status?: number;
  /**
   * Declare the `Idempotency-Key` request header on this endpoint and honour
   * it: `true` to accept a key, `"required"` to insist on one.
   *
   * @since 0.15.0
   */
  readonly idempotency?: Idempotency.Option;
}

/**
 * The `endpoints` option: an object keyed by CRUD operation. Each value is
 * `true` (emit with the top-level defaults), `false` (omit), or an object
 * configuring that endpoint (overriding the top-level defaults). Operations
 * not mentioned are emitted with the defaults.
 *
 * @since 0.1.0
 * @category models
 */
export interface EndpointsOption<R extends Any, Meta extends Schema.Top> {
  readonly get?: boolean | GetConfig<Meta, R>;
  readonly list?: boolean | ListConfig<R, Meta>;
  readonly create?: boolean | WriteConfig<Meta>;
  readonly update?: boolean | WriteConfig<Meta>;
  readonly delete?: boolean | DeleteConfig;
}

/**
 * Per-relationship configuration for a relationship's generated endpoints.
 *
 * @since 0.1.0
 * @category models
 */
export interface RelationshipConfig {
  readonly errors?: ReadonlyArray<ErrorClass>;
  readonly include?: boolean;
  readonly fields?: boolean;
  readonly sort?: boolean;
  readonly page?: Schema.Struct.Fields;
}

/**
 * The `relationships` option: `true` (all relationships, the default) or
 * `false` (none) as a shorthand, or an object keyed by relationship name —
 * each `false` to exclude that relationship, or an object to configure its
 * endpoints. Relationships not mentioned are emitted with the top-level
 * defaults.
 *
 * @since 0.1.0
 * @category models
 */
export type RelationshipsOption<R extends Any> =
  | boolean
  | { readonly [K in RelationshipName<R>]?: boolean | RelationshipConfig };

// --- extraction helpers (config objects are captured via `const`) ----------

// The captured config object for CRUD op `Op` (or `{}` when absent / boolean).
type ConfigObject<E, Op extends string> = E extends undefined
  ? {}
  : Op extends keyof E
    ? NonNullable<E[Op]> extends infer V
      ? V extends boolean
        ? {}
        : V
      : {}
    : {};

// Field `K` of config object `C`, else fallback `F`.
type FieldOr<C, K extends string, F> = K extends keyof C ? Exclude<C[K], undefined> : F;

// Whether CRUD op `Op` is emitted: absent → emit; `false` → omit; else emit.
type EmitOp<E, Op extends string> = E extends undefined
  ? true
  : Op extends keyof E
    ? NonNullable<E[Op]> extends false
      ? false
      : true
    : true;

// The captured config object for relationship `K` (or `{}`).
type RelConfigObject<RO, K extends string> = RO extends boolean
  ? {}
  : RO extends undefined
    ? {}
    : K extends keyof RO
      ? NonNullable<RO[K]> extends infer V
        ? V extends boolean
          ? {}
          : V
        : {}
      : {};

// Whether relationship `K` is emitted.
type EmitRel<RO, K extends string> = RO extends false
  ? false
  : RO extends true
    ? true
    : RO extends undefined
      ? true
      : K extends keyof RO
        ? NonNullable<RO[K]> extends false
          ? false
          : true
        : true;

// Resolve a meta option (schema or function) to its effective schema type.
type ResolveMeta<M, Meta extends Schema.Top> = [M] extends [(...args: any) => infer Ret]
  ? Ret extends Schema.Top
    ? Ret
    : Meta
  : M extends Schema.Top
    ? M
    : Meta;

type EffMeta<C, GMeta, Meta extends Schema.Top> = ResolveMeta<FieldOr<C, "meta", GMeta>, Meta>;

// The effective write payload of a `create` / `update` config: the captured
// `payload` override, else the resource's enveloped default.
type EffPayload<C, Default extends Schema.Top> =
  FieldOr<C, "payload", Default> extends infer P ? (P extends Schema.Top ? P : Default) : Default;

// The effective `idempotency` option of a write config: the captured
// per-endpoint value, else the top-level default.
type EffIdem<C, GIdem extends Idempotency.Option> =
  FieldOr<C, "idempotency", GIdem> extends Idempotency.Option
    ? FieldOr<C, "idempotency", GIdem>
    : GIdem;

// The effective success response of an endpoint config: the captured `success`
// override, else that endpoint's default response — the resource's document /
// collection for the primary-data endpoints, the 204 no-content for `delete`.
type EffSuccess<C, Default extends Schema.Top> =
  FieldOr<C, "success", Default> extends infer S ? (S extends Schema.Top ? S : Default) : Default;

// The effective query schema of a `list` config: the captured `query`
// override, else the `Query.schema` composition of its feature options.
type EffQuery<C, Default extends Schema.Top> =
  FieldOr<C, "query", Default> extends infer Q ? (Q extends Schema.Top ? Q : Default) : Default;

// Whether `sort` is enabled at all: `false` only when explicitly disabled.
type EnabledSort<Sort> = [Sort] extends [false] ? false : true;

// Whether `include` is enabled at all. A `Query.IncludeOptions` object
// constrains the *resource's own* paths, which a relationship endpoint — whose
// graph is its target's — can't reuse; it only learns that the parameter is on.
type EnabledInclude<Include> = [Include] extends [false] ? false : true;

// The effective query feature options of a `get` / `list` config: the captured
// override, else the top-level default. Named (rather than inlined at each use
// site) because `list` needs them twice — once as its own options, once to
// reconstruct the query schema they compose by default.
type ListInclude<C, R extends Any, GInclude extends Query.IncludeOption<R>> =
  FieldOr<C, "include", GInclude> extends Query.IncludeOption<R>
    ? FieldOr<C, "include", GInclude>
    : GInclude;
type ListFields<C, GFields extends boolean> =
  FieldOr<C, "fields", GFields> extends boolean ? FieldOr<C, "fields", GFields> : GFields;
type ListSort<C, R extends Any, GSort extends boolean | ReadonlyArray<AttributeKeys<R>>> =
  FieldOr<C, "sort", GSort> extends boolean | ReadonlyArray<AttributeKeys<R>>
    ? FieldOr<C, "sort", GSort>
    : GSort;
type ListPage<C, GPage extends Schema.Struct.Fields | undefined> =
  FieldOr<C, "page", GPage> extends Schema.Struct.Fields | undefined
    ? FieldOr<C, "page", GPage>
    : GPage;
type ListFilter<C, GFilter extends Query.FilterOption | undefined> =
  FieldOr<C, "filter", GFilter> extends Query.FilterOption | undefined
    ? FieldOr<C, "filter", GFilter>
    : GFilter;

// --- the effective generated endpoint types --------------------------------

type GeneratedGet<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  GFields extends boolean,
  GMeta,
  C = ConfigObject<E, "get">,
> =
  EmitOp<E, "get"> extends true
    ? ReturnType<
        typeof get<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass>
            ? FieldOr<C, "errors", GErrors>
            : GErrors,
          FieldOr<C, "name", "get"> extends string ? FieldOr<C, "name", "get"> : "get",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}`
            ? FieldOr<C, "path", `/${Type}/:id`>
            : `/${Type}/:id`,
          ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
          ListFields<C, GFields>,
          EffMeta<C, GMeta, Meta>,
          EffQuery<
            C,
            DefaultGetQuery<
              Type,
              Attributes,
              Rels,
              Meta,
              IdSchema,
              ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
              ListFields<C, GFields>
            >
          >,
          EffSuccess<
            C,
            DefaultDocument<
              Type,
              Attributes,
              Rels,
              Meta,
              IdSchema,
              EffMeta<C, GMeta, Meta>,
              ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
              ListFields<C, GFields>
            >
          >
        >
      >
    : never;

type GeneratedList<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  GFields extends boolean,
  GSort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>>,
  GPage extends Schema.Struct.Fields | undefined,
  GFilter extends Query.FilterOption | undefined,
  GMeta,
  C = ConfigObject<E, "list">,
> =
  EmitOp<E, "list"> extends true
    ? ReturnType<
        typeof list<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass>
            ? FieldOr<C, "errors", GErrors>
            : GErrors,
          FieldOr<C, "name", "list"> extends string ? FieldOr<C, "name", "list"> : "list",
          FieldOr<C, "path", `/${Type}`> extends `/${string}`
            ? FieldOr<C, "path", `/${Type}`>
            : `/${Type}`,
          ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
          ListFields<C, GFields>,
          ListSort<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GSort>,
          ListPage<C, GPage>,
          ListFilter<C, GFilter>,
          EffMeta<C, GMeta, Meta>,
          EffQuery<
            C,
            DefaultListQuery<
              Type,
              Attributes,
              Rels,
              Meta,
              IdSchema,
              ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
              ListFields<C, GFields>,
              ListSort<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GSort>,
              ListPage<C, GPage>,
              ListFilter<C, GFilter>
            >
          >,
          EffSuccess<
            C,
            DefaultCollection<
              Type,
              Attributes,
              Rels,
              Meta,
              IdSchema,
              EffMeta<C, GMeta, Meta>,
              ListInclude<C, Resource<Type, Attributes, Rels, Meta, IdSchema>, GInclude>,
              ListFields<C, GFields>
            >
          >
        >
      >
    : never;

type GeneratedCreate<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GMeta,
  GIdem extends Idempotency.Option,
  C = ConfigObject<E, "create">,
> =
  EmitOp<E, "create"> extends true
    ? ReturnType<
        typeof create<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass>
            ? FieldOr<C, "errors", GErrors>
            : GErrors,
          FieldOr<C, "name", "create"> extends string ? FieldOr<C, "name", "create"> : "create",
          FieldOr<C, "path", `/${Type}`> extends `/${string}`
            ? FieldOr<C, "path", `/${Type}`>
            : `/${Type}`,
          EffMeta<C, GMeta, Meta>,
          EffPayload<C, Resource<Type, Attributes, Rels, Meta, IdSchema>["createPayload"]>,
          EffSuccess<
            C,
            DefaultDocument<Type, Attributes, Rels, Meta, IdSchema, EffMeta<C, GMeta, Meta>>
          >,
          EffIdem<C, GIdem>
        >
      >
    : never;

type GeneratedUpdate<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GMeta,
  GIdem extends Idempotency.Option,
  C = ConfigObject<E, "update">,
> =
  EmitOp<E, "update"> extends true
    ? ReturnType<
        typeof update<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass>
            ? FieldOr<C, "errors", GErrors>
            : GErrors,
          FieldOr<C, "name", "update"> extends string ? FieldOr<C, "name", "update"> : "update",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}`
            ? FieldOr<C, "path", `/${Type}/:id`>
            : `/${Type}/:id`,
          EffMeta<C, GMeta, Meta>,
          EffPayload<C, Resource<Type, Attributes, Rels, Meta, IdSchema>["updatePayload"]>,
          EffSuccess<
            C,
            DefaultDocument<Type, Attributes, Rels, Meta, IdSchema, EffMeta<C, GMeta, Meta>>
          >,
          EffIdem<C, GIdem>
        >
      >
    : never;

type GeneratedDelete<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  E,
  GErrors extends ReadonlyArray<ErrorClass>,
  GIdem extends Idempotency.Option,
  C = ConfigObject<E, "delete">,
> =
  EmitOp<E, "delete"> extends true
    ? ReturnType<
        typeof deleteEndpoint<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          FieldOr<C, "errors", GErrors> extends ReadonlyArray<ErrorClass>
            ? FieldOr<C, "errors", GErrors>
            : GErrors,
          FieldOr<C, "name", "delete"> extends string ? FieldOr<C, "name", "delete"> : "delete",
          FieldOr<C, "path", `/${Type}/:id`> extends `/${string}`
            ? FieldOr<C, "path", `/${Type}/:id`>
            : `/${Type}/:id`,
          EffSuccess<C, HttpApiSchema.NoContent>,
          EffIdem<C, GIdem>
        >
      >
    : never;

// per-relationship effective option helpers
type RelErrors<RC, GErrors extends ReadonlyArray<ErrorClass>> =
  FieldOr<RC, "errors", GErrors> extends ReadonlyArray<ErrorClass>
    ? FieldOr<RC, "errors", GErrors>
    : GErrors;
type RelInclude<RC, GInclude extends boolean> =
  FieldOr<RC, "include", GInclude> extends boolean ? FieldOr<RC, "include", GInclude> : GInclude;
type RelFields<RC, GFields extends boolean> =
  FieldOr<RC, "fields", GFields> extends boolean ? FieldOr<RC, "fields", GFields> : GFields;
type RelPage<RC, GPage extends Schema.Struct.Fields | undefined> =
  FieldOr<RC, "page", GPage> extends Schema.Struct.Fields | undefined
    ? FieldOr<RC, "page", GPage>
    : GPage;

type GeneratedRelated<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  K extends RelationshipName<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  RC,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends boolean,
  GFields extends boolean,
  GSort,
  GPage extends Schema.Struct.Fields | undefined,
> =
  Rels[K] extends Relationship.ToMany<Any>
    ? ReturnType<
        typeof related<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          K,
          RelErrors<RC, GErrors>,
          K,
          `/${Type}/:id/${K}`,
          RelInclude<RC, GInclude>,
          RelFields<RC, GFields>,
          EnabledSort<FieldOr<RC, "sort", GSort>>,
          RelPage<RC, GPage>,
          undefined,
          typeof AnyMeta
        >
      >
    : ReturnType<
        typeof related<
          Type,
          Attributes,
          Rels,
          Meta,
          IdSchema,
          K,
          RelErrors<RC, GErrors>,
          K,
          `/${Type}/:id/${K}`,
          RelInclude<RC, GInclude>,
          RelFields<RC, GFields>,
          false,
          undefined,
          undefined,
          typeof AnyMeta
        >
      >;

type GeneratedRelationships<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  RO,
  GErrors extends ReadonlyArray<ErrorClass>,
  GInclude extends boolean,
  GFields extends boolean,
  GSort,
  GPage extends Schema.Struct.Fields | undefined,
> =
  | {
      readonly [K in RelationshipName<Resource<Type, Attributes, Rels, Meta, IdSchema>>]: EmitRel<
        RO,
        K
      > extends true
        ?
            | GeneratedRelated<
                Type,
                Attributes,
                Rels,
                Meta,
                IdSchema,
                K,
                RelConfigObject<RO, K>,
                GErrors,
                GInclude,
                GFields,
                GSort,
                GPage
              >
            | ReturnType<
                typeof getRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  IdSchema,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `${K}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  Rels[K] extends Relationship.ToMany<Any>
                    ? RelPage<RelConfigObject<RO, K>, GPage>
                    : undefined,
                  typeof AnyMeta
                >
              >
            | ReturnType<
                typeof updateRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  IdSchema,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `update${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  typeof AnyMeta
                >
              >
        : never;
    }[RelationshipName<Resource<Type, Attributes, Rels, Meta, IdSchema>>]
  | {
      readonly [K in ToManyName<Resource<Type, Attributes, Rels, Meta, IdSchema>>]: EmitRel<
        RO,
        K
      > extends true
        ?
            | ReturnType<
                typeof addRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  IdSchema,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `add${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`,
                  typeof AnyMeta
                >
              >
            | ReturnType<
                typeof removeRelationship<
                  Type,
                  Attributes,
                  Rels,
                  Meta,
                  IdSchema,
                  K,
                  RelErrors<RelConfigObject<RO, K>, GErrors>,
                  `remove${Capitalize<K>}Relationship`,
                  `/${Type}/:id/relationships/${K}`
                >
              >
        : never;
    }[ToManyName<Resource<Type, Attributes, Rels, Meta, IdSchema>>];

/**
 * The union of every endpoint {@link resource} emits for a resource and its
 * configuration.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResourceEndpoint<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  Endpoints,
  RelationshipsOpt,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Fields extends boolean,
  Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Query.FilterOption | undefined,
  GMeta,
  GIdem extends Idempotency.Option = false,
> =
  | GeneratedGet<Type, Attributes, Rels, Meta, IdSchema, Endpoints, Errors, Include, Fields, GMeta>
  | GeneratedList<
      Type,
      Attributes,
      Rels,
      Meta,
      IdSchema,
      Endpoints,
      Errors,
      Include,
      Fields,
      Sort,
      Page,
      Filter,
      GMeta
    >
  | GeneratedCreate<Type, Attributes, Rels, Meta, IdSchema, Endpoints, Errors, GMeta, GIdem>
  | GeneratedUpdate<Type, Attributes, Rels, Meta, IdSchema, Endpoints, Errors, GMeta, GIdem>
  | GeneratedDelete<Type, Attributes, Rels, Meta, IdSchema, Endpoints, Errors, GIdem>
  | GeneratedRelationships<
      Type,
      Attributes,
      Rels,
      Meta,
      IdSchema,
      RelationshipsOpt,
      Errors,
      EnabledInclude<Include>,
      Fields,
      Sort,
      Page
    >;

/**
 * The non-empty tuple of endpoints {@link resource} returns.
 *
 * @since 0.1.0
 * @category type-level
 */
export type ResourceEndpoints<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  Endpoints,
  RelationshipsOpt,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Fields extends boolean,
  Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Query.FilterOption | undefined,
  GMeta,
  GIdem extends Idempotency.Option = false,
> = readonly [
  ResourceEndpoint<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta,
    GIdem
  >,
  ...ReadonlyArray<
    ResourceEndpoint<
      Type,
      Attributes,
      Rels,
      Meta,
      IdSchema,
      Endpoints,
      RelationshipsOpt,
      Errors,
      Include,
      Fields,
      Sort,
      Page,
      Filter,
      GMeta,
      GIdem
    >
  >,
];

/**
 * Configuration for {@link resource} — the whole-resource endpoint generator.
 *
 * Every field is optional; the defaults emit the full CRUD set, every
 * relationship's endpoints, and derived `include` / `fields` / `sort`
 * parameters.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceOptions<
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  Endpoints extends EndpointsOption<Resource<Type, Attributes, Rels, Meta, IdSchema>, Meta>,
  RelationshipsOpt extends RelationshipsOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Errors extends ReadonlyArray<ErrorClass>,
  Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>>,
  Fields extends boolean,
  Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>>,
  Page extends Schema.Struct.Fields | undefined,
  Filter extends Query.FilterOption | undefined,
  GMeta extends Schema.Top,
  GIdem extends Idempotency.Option = false,
> {
  /** Which CRUD endpoints to emit and how to configure each. Defaults to all five. */
  readonly endpoints?: Endpoints;
  /** Which relationships' endpoints to emit. `true` (all, default) / `false` (none) or a per-relationship object. */
  readonly relationships?: RelationshipsOpt;
  /** `ApiError` classes applied to every generated endpoint (overridable per endpoint / relationship). */
  readonly errors?: Errors;
  /**
   * Enable `?include=` on the collection-bearing endpoints. Defaults to `true`
   * — the resource's whole relationship graph at depth 2. A
   * `Query.IncludeOptions` object constrains that (`paths` allow-list and/or
   * `depth`) for `get` and `list`, and an `Include.Surface` legalises exactly a
   * declared surface there *and* derives their documents' `included` union;
   * the relationship endpoints, whose paths are their target's graph, only see
   * that `include` is on.
   */
  readonly include?: Include;
  /**
   * Enable `?fields[TYPE]=` sparse fieldsets. Defaults to `true`, which makes
   * the attributes of the read endpoints' default documents optional (see
   * {@link get}); pass `false` to keep them strict.
   */
  readonly fields?: Fields;
  /** Enable `?sort=`: `true` for all attributes, an explicit list, or `false` to disable. Defaults to `true`. */
  readonly sort?: Sort;
  /** Enable `?page[*]=` on `list`, to-many `related` and paginated-linkage endpoints (see `Query.Page`). */
  readonly page?: Page;
  /** Enable `?filter[*]=` on `list` (user-defined fields). */
  readonly filter?: Filter;
  /**
   * Declare the `Idempotency-Key` request header on every generated write
   * endpoint (`create` / `update` / `delete`) and honour it: `true` to accept
   * a key, `"required"` to insist on one. Off by default, and overridable per
   * endpoint. Opting in attaches `Idempotency.Middleware`, so the api cannot
   * be built without an `Idempotency.layer(store)`.
   *
   * @since 0.15.0
   */
  readonly idempotency?: GIdem;
  /**
   * The `meta` schema of the primary-data documents (`get` / `list` / `create`
   * / `update`): a `Schema` (overriding it) or a function `(base) => schema`
   * (extending the resource's base meta rather than replacing it).
   */
  readonly meta?: GMeta | ((base: Meta) => GMeta);
}

// An op's own value under `key` when it sets one (even `undefined`), else the
// top-level default.
const pick = <V>(config: Readonly<Record<string, V>>, key: string, fallback: NoInfer<V>): V =>
  key in config ? config[key] : fallback;

/**
 * Generates the entire JSON:API endpoint set for a resource definition — the
 * full CRUD surface plus, for every relationship, the `related` and linkage
 * endpoints appropriate to its kind — with `include`, `fields` and `sort`
 * query parameters derived from the resource graph.
 *
 * The result is a plain tuple of `HttpApiEndpoint` values, ready to spread into
 * {@link Group.make} (or `Group.resource`, which does exactly that). Trim or
 * extend it like any array; override individual endpoints by replacing them.
 *
 * Defaults (all overridable):
 *   - emits `get`, `list`, `create`, `update`, `delete` (configure with `endpoints`)
 *   - emits every relationship's endpoints (configure with `relationships`)
 *   - enables `include`, `fields` and `sort` (derived from the graph & attributes)
 *   - leaves `page` and `filter` off (their semantics are application-defined)
 *   - applies `errors` to every generated endpoint, overridable per endpoint / relationship
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { ApiError, Endpoint, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.paginated(() => Person)
 *   }
 * })
 *
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 * class TitleTaken extends ApiError.make<TitleTaken>()("TitleTaken", {
 *   status: 409,
 *   fields: { title: Schema.String }
 * }) {}
 *
 * const articles = Group.make(
 *   Article,
 *   ...Endpoint.resource(Article, {
 *     errors: [ArticleNotFound],
 *     page: Query.Page.Offset,
 *     // per-endpoint config overrides the top-level defaults:
 *     endpoints: {
 *       create: { errors: [TitleTaken] },
 *       list: { filter: { author: Schema.optionalKey(Schema.String) } }
 *     }
 *   })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const resource = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Endpoints extends EndpointsOption<Resource<Type, Attributes, Rels, Meta, IdSchema>, Meta> =
    {},
  const RelationshipsOpt extends RelationshipsOption<
    Resource<Type, Attributes, Rels, Meta, IdSchema>
  > = true,
  const Errors extends ReadonlyArray<ErrorClass> = readonly [],
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>> =
    true,
  const Fields extends boolean = true,
  const Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>> = true,
  const Page extends Schema.Struct.Fields | undefined = undefined,
  const Filter extends Query.FilterOption | undefined = undefined,
  const GMeta extends Schema.Top = Meta,
  const GIdem extends Idempotency.Option = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: ResourceOptions<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta,
    GIdem
  >,
): ResourceEndpoints<
  Type,
  Attributes,
  Rels,
  Meta,
  IdSchema,
  Endpoints,
  RelationshipsOpt,
  Errors,
  Include,
  Fields,
  Sort,
  Page,
  Filter,
  GMeta,
  GIdem
> => {
  const gInclude = options?.include ?? true;
  const gFields = options?.fields ?? true;
  const gSort = options?.sort ?? true;
  const gPage = options?.page;
  const gFilter = options?.filter;
  const gMeta = options?.meta;
  const gErrors = options?.errors;
  const gIdem = options?.idempotency;
  const endpointsOpt = options?.endpoints as Record<string, unknown> | undefined;
  const relationshipsOpt = options?.relationships ?? true;

  // The resource's base meta schema, for resolving `meta` functions.
  const baseMeta = (resource.fields.meta as { readonly schema: Schema.Top }).schema;
  const resolveMeta = (value: MetaOption<Schema.Top>): Schema.Top =>
    typeof value === "function"
      ? // SAFETY: a callable `meta` is read as `MetaOption`'s
        // `(base) => Schema.Top` member.
        (value as (base: Schema.Top) => Schema.Top)(baseMeta)
      : value;

  // Emit + captured config for a CRUD op.
  const opConfig = (
    op: CrudOperation,
  ): { readonly emit: boolean; readonly config: Record<string, unknown> } => {
    if (endpointsOpt === undefined) return { emit: true, config: {} };
    const value = endpointsOpt[op];
    if (value === undefined || value === true) return { emit: true, config: {} };
    if (value === false) return { emit: false, config: {} };
    return { emit: true, config: value as Record<string, unknown> };
  };

  // The shared name / path / errors (and, optionally, meta) overrides of an op.
  const commonOpts = (
    config: Record<string, unknown>,
    withMeta: boolean,
  ): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    const errors = pick(config, "errors", gErrors);
    if (errors !== undefined) out.errors = errors;
    if ("name" in config) out.name = config.name;
    if ("path" in config) out.path = config.path;
    if (withMeta) {
      const meta = pick(config, "meta", gMeta);
      // SAFETY: `config` is the op's captured config object, whose `meta` is
      // typed `MetaOption` by its config interface (`GetConfig`, …); the
      // global `meta` is one too.
      if (meta !== undefined) out.meta = resolveMeta(meta as MetaOption<Schema.Top>);
    }
    return out;
  };

  // An endpoint's `success` override is per-endpoint only: the primary-data
  // endpoints answer with a single-resource document and `list` with a
  // collection, so there is no sensible top-level default to fall back to.
  const successOpt = (config: Record<string, unknown>): Record<string, unknown> =>
    config.success !== undefined ? { success: config.success } : {};

  // Likewise `status`: each endpoint's default (201 for `create`, 200 for
  // `update`, 204 for `delete`) is the constructor's, so an absent key must
  // stay absent rather than resolve to some shared number here.
  const statusOpt = (config: Record<string, unknown>): Record<string, unknown> =>
    config.status !== undefined ? { status: config.status } : {};

  // A read endpoint's `query` override is per-endpoint only: it replaces that
  // endpoint's whole composed query, and `get`'s and `list`'s compositions
  // differ, so there is no sensible top-level default to fall back to.
  const queryOpt = (config: Record<string, unknown>): Record<string, unknown> =>
    config.query !== undefined ? { query: config.query } : {};

  const endpoints: Array<HttpApiEndpoint.Top> = [];

  const getOp = opConfig("get");
  if (getOp.emit) {
    endpoints.push(
      get(resource, {
        include: pick(getOp.config, "include", gInclude),
        fields: pick(getOp.config, "fields", gFields),
        ...queryOpt(getOp.config),
        ...commonOpts(getOp.config, true),
        ...successOpt(getOp.config),
      } as never),
    );
  }
  const listOp = opConfig("list");
  if (listOp.emit) {
    const page = pick(listOp.config, "page", gPage);
    const filter = pick(listOp.config, "filter", gFilter);
    endpoints.push(
      list(resource, {
        include: pick(listOp.config, "include", gInclude),
        fields: pick(listOp.config, "fields", gFields),
        sort: pick(listOp.config, "sort", gSort),
        ...(page !== undefined ? { page } : {}),
        ...(filter !== undefined ? { filter } : {}),
        ...queryOpt(listOp.config),
        ...commonOpts(listOp.config, true),
        ...successOpt(listOp.config),
      } as never),
    );
  }
  // A write endpoint's `payload` override is per-endpoint only: `create` and
  // `update` have different default envelopes, so there is no sensible
  // top-level default to fall back to.
  // `idempotency` is the one write option with a top-level default, so an
  // absent per-endpoint key inherits it rather than staying absent.
  const idempotencyOpt = (config: Record<string, unknown>): Record<string, unknown> => {
    const idempotency = pick(config, "idempotency", gIdem);
    return idempotency !== undefined ? { idempotency } : {};
  };

  const payloadOpt = (config: Record<string, unknown>): Record<string, unknown> => ({
    ...(config.payload !== undefined ? { payload: config.payload } : {}),
    ...(config.payloadMediaType !== undefined ? { payloadMediaType: config.payloadMediaType } : {}),
  });

  const createOp = opConfig("create");
  if (createOp.emit) {
    endpoints.push(
      create(resource, {
        ...commonOpts(createOp.config, true),
        ...payloadOpt(createOp.config),
        ...successOpt(createOp.config),
        ...statusOpt(createOp.config),
        ...idempotencyOpt(createOp.config),
      } as never),
    );
  }
  const updateOp = opConfig("update");
  if (updateOp.emit) {
    endpoints.push(
      update(resource, {
        ...commonOpts(updateOp.config, true),
        ...payloadOpt(updateOp.config),
        ...successOpt(updateOp.config),
        ...statusOpt(updateOp.config),
        ...idempotencyOpt(updateOp.config),
      } as never),
    );
  }
  const deleteOp = opConfig("delete");
  if (deleteOp.emit) {
    endpoints.push(
      deleteEndpoint(resource, {
        ...commonOpts(deleteOp.config, false),
        ...successOpt(deleteOp.config),
        ...statusOpt(deleteOp.config),
        ...idempotencyOpt(deleteOp.config),
      } as never),
    );
  }

  if (relationshipsOpt !== false) {
    const relMap =
      typeof relationshipsOpt === "object"
        ? (relationshipsOpt as Record<string, unknown>)
        : undefined;
    const relationships = resource.relationships as Record<string, Relationship.Descriptor>;
    for (const name of Object.keys(relationships)) {
      let relConfig: Record<string, unknown> = {};
      if (relMap !== undefined) {
        const value = relMap[name];
        if (value === false) continue;
        if (value !== undefined && value !== true) relConfig = value as Record<string, unknown>;
      }
      const toMany = Relationship.isToMany(relationships[name]!);
      // A constrained `include` names this resource's paths, not the target's:
      // a relationship endpoint only inherits that the parameter is on.
      const inheritedInclude = pick(relConfig, "include", gInclude);
      const include = typeof inheritedInclude === "object" ? true : inheritedInclude;
      const fields = pick(relConfig, "fields", gFields);
      const sortOpt = pick(relConfig, "sort", gSort);
      const page = pick(relConfig, "page", gPage);
      const errors = pick(relConfig, "errors", gErrors);
      const errorOpt = errors !== undefined ? { errors } : {};
      const relatedSort = sortOpt === false ? false : true;

      endpoints.push(
        related(
          resource,
          name as never,
          {
            include,
            fields,
            ...(toMany ? { sort: relatedSort, ...(page !== undefined ? { page } : {}) } : {}),
            ...errorOpt,
          } as never,
        ),
      );
      endpoints.push(
        getRelationship(
          resource,
          name as never,
          {
            ...(toMany && page !== undefined ? { page } : {}),
            ...errorOpt,
          } as never,
        ),
      );
      endpoints.push(updateRelationship(resource, name as never, { ...errorOpt } as never));
      if (toMany) {
        endpoints.push(addRelationship(resource, name as never, { ...errorOpt } as never));
        endpoints.push(removeRelationship(resource, name as never, { ...errorOpt } as never));
      }
    }
  }

  return endpoints as unknown as ResourceEndpoints<
    Type,
    Attributes,
    Rels,
    Meta,
    IdSchema,
    Endpoints,
    RelationshipsOpt,
    Errors,
    Include,
    Fields,
    Sort,
    Page,
    Filter,
    GMeta,
    GIdem
  >;
};

// ---------------------------------------------------------------------------
// The flat contract: string-link documents and the §7.4 related endpoint
// ---------------------------------------------------------------------------

/**
 * Options of {@link ResourceDocument}, {@link CollectionDocument} and
 * {@link RelatedDocument}.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatDocumentOptions<Included extends Schema.Top> {
  /**
   * The union of resource schemas an `?include=` walk over this endpoint can
   * hoist (`Include.make(...).included`), declared so the compound `included`
   * member survives the success-schema encode — without it the response
   * encoder strips whatever the handler resolved.
   */
  readonly included?: Included | undefined;
}

/**
 * The `success:` document of a flat `get` / `create` / `update`: a
 * single-resource data document over the **wire** form of `resource`
 * (`Document.wire` — string links, since the assembler stringifies every
 * `URL` before the document leaves the server), annotated with the JSON:API
 * media type. `data` is non-null: a missing resource is a 404, never
 * `200 { data: null }`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApiEndpoint } from "effect/http-api"
 * import { Endpoint, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 *
 * const latest = HttpApiEndpoint.get("latest", "/articles/latest", {
 *   success: Endpoint.ResourceDocument(Article)
 * })
 * console.log(latest.path)
 * // → /articles/latest
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const ResourceDocument = <
  S extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
>(
  resource: S,
  options?: FlatDocumentOptions<Included>,
): DataDocument<WireSchema<S>, WireSchema<Included>> =>
  asJsonApi(
    DataDocument(
      wire(resource),
      options?.included === undefined ? undefined : { included: wire(options.included) },
    ),
  ) as DataDocument<WireSchema<S>, WireSchema<Included>>;

/**
 * The `success:` document of a committed flat `create` / `update` whose
 * resource is hidden from its writer (`ResourceHandlers.HiddenWrite`): a
 * data document whose primary data is the resource reduced to its
 * identifier — `type`, `id` and an optional `meta` (`meta.version`, when
 * the write reported one) — with no `attributes` or `relationships`, both
 * optional members of a resource object (JSON:API 1.1 §Resource Objects).
 * Annotated with the JSON:API media type.
 *
 * The identifier is **closed**: a resource object carrying any member the
 * identifier doesn't declare (`attributes`, `relationships`, `links`, …) is
 * rejected, decoding and encoding alike, rather than stripped down to its
 * `type` and `id`. So inside {@link WriteDocument} a full document that fails
 * {@link ResourceDocument} (an attribute its schema rejects) fails the union
 * too — a defect on the server (a 500), a decode failure on the client —
 * instead of going out, or coming in, as this identifier document. The
 * closedness is a **parse** rule (decode and encode): `Schema.is` on this
 * schema and its `make` validate the type side, where an undeclared member
 * is dropped before the check sees it, so `Schema.is` accepts, and `make`
 * strips, a resource object carrying one.
 *
 * Closed also means the resource object carries no `links`, so no
 * `data.links.self` for `Middleware.CreatedLocation` to copy: by design, a
 * hidden write's 201 has no `Location` header, since the document
 * `ResourceHandlers` builds sets no top-level `links` either.
 *
 * This is the **schema**; `ResourceHandlers.CommittedDocument` is the
 * **value** type a handler answers with, which this schema encodes — the same
 * split as this module's {@link ResourceDocument} and
 * `Assemble.ResourceDocument`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.NonEmptyString } })
 *
 * const committed = Schema.decodeUnknownSync(Endpoint.CommittedDocument(Article))({
 *   data: { type: "articles", id: "1", meta: { version: 2 } }
 * })
 * console.log(committed.data.meta)
 * // → { version: 2 }
 * ```
 *
 * @since 0.17.0
 * @category constructors
 */
export const CommittedDocument = <F extends Schema.Struct.Fields>(resource: {
  readonly identifier: { readonly fields: F };
}): DataDocument<Schema.Struct<F>> =>
  asJsonApi(
    DataDocument(closedStruct(resource.identifier.fields, defaultMaxUndeclaredMemberErrors)),
  );

/**
 * The `success:` document of a flat `create` / `update` that may answer a
 * hidden write: {@link ResourceDocument} or {@link CommittedDocument} — a
 * document carrying the full resource decodes as the first, one whose
 * resource object is exactly an identifier (`type`, `id`, `meta?`) as the
 * second. No document matches both, so the members' order is not observable:
 * a resource object in {@link ResourceDocument} always carries `attributes`
 * (even for a resource that declares none), and the closed identifier
 * rejects one that does. For the same reason a document that fails the
 * first and carries a member the identifier doesn't declare fails both, so
 * an invalid full document is never answered, or accepted, as the
 * identifier document. What `Group.flat({ …, hiddenWrites: true })` declares.
 *
 * @since 0.17.0
 * @category constructors
 */
export const WriteDocument = <
  S extends Schema.Top & StructIdentified,
  Included extends Schema.Top = typeof Schema.Never,
>(
  resource: S,
  options?: FlatDocumentOptions<Included>,
): WriteDocument<S, Included> =>
  asJsonApi(
    Schema.Union<WriteDocumentMembers<S, Included>>([
      ResourceDocument(resource, options),
      CommittedDocument(resource),
    ]),
  );

/** A resource definition whose identifier is a struct, as `Resource.make`'s is. */
type StructIdentified = { readonly identifier: { readonly fields: Schema.Struct.Fields } };

/** The members of {@link WriteDocument}. */
type WriteDocumentMembers<
  S extends Schema.Top & StructIdentified,
  Included extends Schema.Top,
> = readonly [
  DataDocument<WireSchema<S>, WireSchema<Included>>,
  DataDocument<Schema.Struct<S["identifier"]["fields"]>>,
];

/**
 * The schema {@link WriteDocument} builds.
 *
 * @since 0.17.0
 * @category models
 */
export interface WriteDocument<
  S extends Schema.Top & StructIdentified,
  Included extends Schema.Top = typeof Schema.Never,
> extends Schema.Union<WriteDocumentMembers<S, Included>> {}

/**
 * The `success:` document of a §7.4 related-resource fetch of a **to-one**
 * relationship: {@link ResourceDocument} whose `data` may be `null` (empty
 * linkage).
 *
 * @since 0.16.0
 * @category constructors
 */
export const RelatedDocument = <
  S extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
>(
  resource: S,
  options?: FlatDocumentOptions<Included>,
): DataDocument<Schema.NullOr<WireSchema<S>>, WireSchema<Included>> =>
  asJsonApi(
    DataDocument(
      Schema.NullOr(wire(resource)),
      options?.included === undefined ? undefined : { included: wire(options.included) },
    ),
  ) as DataDocument<Schema.NullOr<WireSchema<S>>, WireSchema<Included>>;

/**
 * The `success:` document of a flat `list` (or a to-many related fetch): a
 * collection document over the wire form of `resource`, annotated with the
 * JSON:API media type. A list endpoint that resolves an `?include=` walk
 * MUST pass `included`, or the walk silently returns nothing.
 *
 * @since 0.16.0
 * @category constructors
 */
export const FlatCollectionDocument = <
  S extends Schema.Top,
  Included extends Schema.Top = typeof Schema.Never,
>(
  resource: S,
  options?: FlatDocumentOptions<Included>,
): CollectionDocument<WireSchema<S>, WireSchema<Included>> =>
  asJsonApi(
    CollectionDocument(
      wire(resource),
      options?.included === undefined ? undefined : { included: wire(options.included) },
    ),
  ) as CollectionDocument<WireSchema<S>, WireSchema<Included>>;

/**
 * The endpoint (and handler) name of a flat §7.4 related-resource fetch —
 * `related_<key>`, collision-free with the CRUD and §8 operation names.
 *
 * @since 0.16.0
 * @category utils
 */
export const relatedName = <const Key extends string>(key: Key): `related_${Key}` =>
  `related_${key}`;

/**
 * The `get` query of a flat endpoint: the open `?include=` parameter and
 * nothing else.
 *
 * @since 0.16.0
 * @category schemas
 */
export const FlatGetQuery: Schema.Struct<typeof Query.includeListField> = Schema.Struct(
  Query.includeListField,
);

/**
 * The decoded type of a flat endpoint's {@link FlatGetQuery} `get` query.
 *
 * @since 0.18.0
 * @category models
 */
export type FlatGetQuery = typeof FlatGetQuery.Type;

/**
 * Options of {@link flatRelated}.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatRelatedOptions<Key extends string> {
  /** The relationship key: the field under `relationships`, and the path segment. */
  readonly key: Key;
  readonly cardinality: "one" | "many";
  /** The parent family's id schema, validating the `:id` path param. */
  readonly idSchema: Schema.Top;
  /** The related resource schema (a concrete schema, or a union for polymorphic refs). */
  readonly target: Schema.Top;
  /**
   * To-many only: the flat page-cursor struct, bracketed on the wire.
   * Defaults to `FlatQuery.pagination({ maxLimit: 100 })`.
   */
  readonly query?: Query.FlatListStruct | undefined;
  /**
   * To-one only: the `included` union an `?include=` walk over the related
   * resource can hoist. Omit when the relationship supports no includes —
   * the endpoint then carries no `include` parameter at all.
   */
  readonly included?: Schema.Top | undefined;
}

/**
 * A flat JSON:API §7.4 related-resource fetch endpoint for one declared
 * relationship, at `/:id/<key>` (relative — add it to the family's group,
 * which prefixes the path) and named {@link relatedName}: a to-many
 * relationship answers a paginated collection document
 * ({@link FlatCollectionDocument}, `page[…]` query), a to-one the nullable
 * {@link RelatedDocument}, with the open `?include=` when `included` is
 * declared.
 *
 * The package-native counterpart, deriving everything from the relationship
 * declaration, is {@link related}.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApiGroup } from "effect/http-api"
 * import { Endpoint, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 *
 * const author = Endpoint.flatRelated({
 *   key: "author",
 *   cardinality: "one",
 *   idSchema: Article.Id,
 *   target: Person
 * })
 * console.log(author.identifier, author.path)
 * // → related_author /:id/author
 *
 * const group = HttpApiGroup.make("articles").add(author).prefix("/articles")
 * console.log(Object.keys(group.endpoints))
 * // → [ "related_author" ]
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const flatRelated = <const Key extends string>(options: FlatRelatedOptions<Key>) => {
  const path = `/:id/${options.key}` as const;
  const name = relatedName(options.key);
  const params = { id: options.idSchema };
  if (options.cardinality === "many") {
    return HttpApiEndpoint.get(name, path, {
      params,
      query: Query.flatList(
        (options.query ??
          Schema.Struct(FlatQuery.pagination({ maxLimit: 100 }))) as Query.FlatListStruct,
        { include: false },
      ),
      success: FlatCollectionDocument(options.target),
    });
  }
  if (options.included === undefined) {
    return HttpApiEndpoint.get(name, path, {
      params,
      success: RelatedDocument(options.target),
    });
  }
  return HttpApiEndpoint.get(name, path, {
    params,
    query: FlatGetQuery,
    success: RelatedDocument(options.target, { included: options.included }),
  });
};
