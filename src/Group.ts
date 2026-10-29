/**
 * JSON:API resource groups.
 *
 * Light sugar over `HttpApiGroup`: a group named after a resource type (or a
 * plain name, for heterogeneous endpoints like search), holding JSON:API
 * endpoints.
 *
 * ```ts skip-type-checking
 * const articles = Group.make(Article,
 *   Endpoint.get(Article, { include: true, errors: [ArticleNotFound] }),
 *   Endpoint.list(Article, { page: Query.Page.Offset }),
 *   Endpoint.create(Article),
 *   Endpoint.update(Article, { errors: [ArticleNotFound] }),
 *   Endpoint.delete(Article, { errors: [ArticleNotFound] })
 * )
 *
 * // …or generate the whole group from the resource definition:
 * const articles = Group.resource(Article, { errors: [ArticleNotFound] })
 *
 * const search = Group.make("search",
 *   Endpoint.collection([Article, Person], { name: "search", path: "/search", filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * The result is a plain `HttpApiGroup`, so everything composes with vanilla
 * `HttpApi` / `HttpApiBuilder` / `HttpApiClient` / `HttpApiTest` / `OpenApi`.
 *
 * @since 0.1.0
 */
import type { Schema } from "effect";
import * as ApiError from "./ApiError.js";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { HttpApiEndpoint } from "effect/http-api";
import { HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import type { DataDocument } from "./Document.js";
import type * as Idempotency from "./Idempotency.js";
import type { AnySurface } from "./Include.js";
import * as Query from "./Query.js";
import type { Relationships } from "./Relationship.js";
import type { AttributeKeys, Id, Parameter, Resource } from "./Resource.js";

/**
 * Creates an `HttpApiGroup` named after a resource's type — or after a plain
 * string, for groups that span several resource types — containing the given
 * endpoints.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { Endpoint, Group, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 * const Person = Resource.make("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * // A group named after a resource type
 * const articles = Group.make(
 *   Article,
 *   Endpoint.get(Article, { include: true }),
 *   Endpoint.list(Article, { page: Query.Page.Offset })
 * )
 *
 * // A group named after a plain string, for heterogeneous endpoints
 * const search = Group.make(
 *   "search",
 *   Endpoint.collection([Article, Person], { name: "search", path: "/search", filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: {
  <const Type extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Top>>(
    resource: { readonly type: Type },
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Type, Endpoints[number]>;
  <const Name extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Top>>(
    name: Name,
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Name, Endpoints[number]>;
} = (
  nameOrResource: string | { readonly type: string },
  ...endpoints: ReadonlyArray<HttpApiEndpoint.Top>
) =>
  HttpApiGroup.make(typeof nameOrResource === "string" ? nameOrResource : nameOrResource.type).add(
    ...(endpoints as unknown as NonEmptyReadonlyArray<HttpApiEndpoint.Top>),
  ) as never;

/**
 * Generates a complete `HttpApiGroup` from a resource definition — the group is
 * named after the resource's type and contains the full endpoint set produced
 * by {@link Endpoint.resource} (CRUD + relationship endpoints with derived
 * query parameters).
 *
 * This is the one-call "whole group from a resource" ergonomic. For finer
 * control — adding heterogeneous endpoints, dropping or replacing individual
 * endpoints — spread {@link Endpoint.resource} into {@link make} instead.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/http-api"
 * import { ApiError, Group, Query, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
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
 *
 * // CRUD + every relationship endpoint, fully typed:
 * const articles = Group.resource(Article, {
 *   errors: [ArticleNotFound],
 *   page: Query.Page.Offset,
 *   endpoints: {
 *     // override the top-level defaults per endpoint:
 *     list: { filter: { author: Schema.optionalKey(Schema.String) } }
 *   }
 * })
 *
 * // A read-only resource: just get + list, no relationship endpoints:
 * const people = Group.resource(Person, {
 *   endpoints: { create: false, update: false, delete: false },
 *   relationships: false
 * })
 *
 * const Api = HttpApi.make("blog").add(articles).add(people)
 * ```
 *
 * @since 0.1.0 (`relationshipInclude` and `relationshipFields` since 0.18.0)
 * @category constructors
 */
export const resource = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string> = Id<Type>,
  const Endpoints extends Endpoint.EndpointsOption<
    Resource<Type, Attributes, Rels, Meta, IdSchema>,
    Meta
  > = Record<never, never>,
  const RelationshipsOpt extends Endpoint.RelationshipsOption<
    Resource<Type, Attributes, Rels, Meta, IdSchema>
  > = true,
  const Errors extends ReadonlyArray<Endpoint.ErrorClass> = readonly [],
  const Include extends Query.IncludeOption<Resource<Type, Attributes, Rels, Meta, IdSchema>> =
    true,
  const Fields extends boolean = true,
  const Sort extends
    | boolean
    | ReadonlyArray<AttributeKeys<Resource<Type, Attributes, Rels, Meta, IdSchema>>> = true,
  const Page extends Schema.Struct.Fields | undefined = undefined,
  const Filter extends Schema.Struct.Fields | undefined = undefined,
  const GMeta extends Schema.Top = Meta,
  const GIdem extends Idempotency.Option = false,
  const GRelInclude extends Endpoint.ResourceRelationshipIncludeOption = false,
  const GRelFields extends boolean = false,
>(
  resource: Parameter<Type, Attributes, Rels, Meta, IdSchema>,
  options?: Endpoint.ResourceOptions<
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
    GIdem,
    GRelInclude,
    GRelFields
  >,
): HttpApiGroup.HttpApiGroup<
  Type,
  Endpoint.ResourceEndpoint<
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
    GIdem,
    GRelInclude,
    GRelFields
  >
> =>
  make(
    resource,
    ...Endpoint.resource<
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
      GIdem,
      GRelInclude,
      GRelFields
    >(resource, options),
  );

// ---------------------------------------------------------------------------
// The flat presets
// ---------------------------------------------------------------------------

/**
 * The media type a flat write registers its payload under — `application/json`,
 * not the JSON:API media type.
 *
 * The **external** contract is JSON:API: a host's `Negotiation` verdict
 * enforces §5 at the seam, and `Negotiation.requestForRouter` then relabels
 * every dispatched write to `application/json` once, globally, so the router
 * decodes the already-JSON body. Because that relabel is global, the
 * registration is all-or-nothing across the writes — one constant, not a
 * per-endpoint choice.
 *
 * @since 0.16.0
 * @category constants
 */
export const FLAT_PAYLOAD_MEDIA_TYPE = "application/json";

/**
 * The declarations a flat read-only group is built from.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatReadOnlyOptions<
  R extends Schema.Top,
  List extends Query.FlatListStruct,
  Filters extends ReadonlyArray<Extract<keyof List["fields"], string>>,
  Surface extends AnySurface | undefined,
  TM extends Schema.Top = never,
> {
  readonly resource: R;
  /** The flat `List<X>` input (the page cursor plus the family's own filters). */
  readonly list: List;
  /** Fields of `list` re-keyed to `filter[…]` on the wire — see `Query.flatList`. */
  readonly filters?: Filters | undefined;
  /**
   * The family's include surface (`Include.make`): its `included` union is
   * what the documents declare, its `paths` the whitelist the handlers
   * enforce. Omit for a family that serves no walk.
   */
  readonly include?: Surface;
  /**
   * The schema every to-many relationship object's `meta` is narrowed to in
   * the group's documents, primary data and `included` alike — the per-call
   * override of what each relationship declared with `Relationship.many` /
   * `paginated`'s `meta` option (see `Document.wire`). For a family whose
   * every to-many arm carries the same meta, such as `{ totalCount }`.
   *
   * @since 0.20.0
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling AGENTS.md requires under exactOptionalPropertyTypes
  readonly toManyMeta?: TM | undefined;
}

/**
 * The declarations a flat CRUD group is built from.
 *
 * @since 0.16.0
 * @category models
 */
export interface FlatOptions<
  R extends Schema.Top,
  List extends Query.FlatListStruct,
  Filters extends ReadonlyArray<Extract<keyof List["fields"], string>>,
  Surface extends AnySurface | undefined,
  Create extends Schema.Top,
  Update extends Schema.Top,
  Hidden extends boolean = false,
  TM extends Schema.Top = never,
> extends FlatReadOnlyOptions<R, List, Filters, Surface, TM> {
  /** The flat `Create<X>` command input (attributes plus relationship ids) — not the JSON:API envelope. */
  readonly create: Create;
  /** The flat `Update<X>` command input, keyed by the required `id`. */
  readonly update: Update;
  /**
   * `true` when a committed write can be hidden from its own writer: `create`
   * and `update` then declare `Endpoint.WriteDocument`, which also admits the
   * `Endpoint.CommittedDocument` (the resource's identifier with
   * `meta.version`, no attributes) that `ResourceHandlers.make`'s
   * `hiddenWrite` answers. Off by default: the writes declare the full
   * resource document alone, and a typed client's success is unchanged.
   *
   * @since 0.17.0
   */
  // oxlint-disable-next-line effect/prefer-option-over-null -- the `?: T | undefined` spelling AGENTS.md requires under exactOptionalPropertyTypes, as the sibling options do
  readonly hiddenWrites?: Hidden | undefined;
}

const SHARED_FLAT_OPTIONS = {
  relationships: false,
  include: false,
  fields: false,
  sort: false,
} as const;

const flatWire = <
  R extends Schema.Top,
  List extends Query.FlatListStruct,
  const Filters extends ReadonlyArray<Extract<keyof List["fields"], string>>,
  Surface extends AnySurface | undefined,
  TM extends Schema.Top,
>(
  options: FlatReadOnlyOptions<R, List, Filters, Surface, TM>,
) => {
  const included = options.include?.included;
  const toManyMeta = options.toManyMeta;
  return {
    document: Endpoint.ResourceDocument(options.resource, { included, toManyMeta }),
    collection: Endpoint.FlatCollectionDocument(options.resource, { included, toManyMeta }),
    listQuery: Query.flatList(options.list, { filters: options.filters }),
  };
};

/**
 * A flat read-only `HttpApiGroup`: `list` and `get` only, for a resource
 * written by a pipeline and never through the api — a write to its URL is a
 * 404 route, not a 403 guard.
 *
 * Returns the group **and** the `list` wire query it built: the server's
 * collection handler spells its pagination links from the family's own list
 * query (`Query.canonicalPairs(listQuery)`), so a link's query and a
 * request's query cannot drift. Reading it back off
 * `group.endpoints.list.query` would lose the decoded type — `HttpApiGroup`
 * widens that member to `Schema.Top | undefined`. Call sites destructure:
 * `const { group, listQuery } = Group.flatReadOnly({ … })`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Contest = Resource.make("contests", { attributes: { name: Schema.NonEmptyString } })
 * const ListContests = FlatQuery.listInput({ maxLimit: 100 }, {
 *   election: Schema.optionalKey(Schema.String)
 * })
 *
 * const { group, listQuery } = Group.flatReadOnly({
 *   resource: Contest,
 *   list: ListContests,
 *   filters: ["election"]
 * })
 * console.log(Object.keys(group.endpoints))
 * // → [ "list", "get" ]
 * console.log(Schema.decodeUnknownSync(listQuery)({ "filter[election]": "H", "page[limit]": 5 }))
 * // → { offset: 0, limit: 5, election: "H" }
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const flatReadOnly = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  List extends Query.FlatListStruct,
  const Filters extends ReadonlyArray<Extract<keyof List["fields"], string>> = readonly [],
  Surface extends AnySurface | undefined = undefined,
  TM extends Schema.Top = never,
>(
  options: FlatReadOnlyOptions<
    Parameter<Type, Attributes, Rels, Meta, IdSchema>,
    List,
    Filters,
    Surface,
    TM
  >,
) => {
  const { collection, document, listQuery } = flatWire(options);
  return {
    group: resource(options.resource, {
      ...SHARED_FLAT_OPTIONS,
      endpoints: {
        list: { query: listQuery, success: collection },
        get: { query: Endpoint.FlatGetQuery, success: document },
        create: false,
        update: false,
        delete: false,
      },
    }),
    listQuery,
  };
};

/**
 * A flat CRUD `HttpApiGroup`: the five standard endpoints over one resource
 * definition, with the flat `Create<X>` / `Update<X>` command inputs as the
 * write payloads (registered under {@link FLAT_PAYLOAD_MEDIA_TYPE}),
 * `create` answering 201, `update` declaring the 409 (`ApiError.Conflict`)
 * an id mismatch answers, `delete` answering 204 with no body. With
 * `hiddenWrites: true`, `create` / `update` also admit the committed write's
 * identifier document (`Endpoint.WriteDocument`).
 *
 * Returns `{ group, listQuery }` — see {@link flatReadOnly} for why.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { FlatQuery, Group, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } })
 * const ListPeople = FlatQuery.listInput({ maxLimit: 100 }, { q: Schema.optionalKey(Schema.String) })
 * const CreatePerson = Schema.Struct({ name: Schema.NonEmptyString })
 * const UpdatePerson = Schema.Struct({ id: Person.Id, name: Schema.optionalKey(Schema.NonEmptyString) })
 *
 * const { group } = Group.flat({
 *   resource: Person,
 *   list: ListPeople,
 *   filters: ["q"],
 *   create: CreatePerson,
 *   update: UpdatePerson
 * })
 * console.log(Object.keys(group.endpoints))
 * // → [ "list", "get", "create", "update", "delete" ]
 * ```
 *
 * @since 0.16.0
 * @category constructors
 */
export const flat = <
  Type extends string,
  Attributes extends Schema.Struct.Fields,
  Rels extends Relationships,
  Meta extends Schema.Top,
  IdSchema extends Schema.Codec<any, string>,
  List extends Query.FlatListStruct,
  Create extends Schema.Top,
  Update extends Schema.Top,
  const Filters extends ReadonlyArray<Extract<keyof List["fields"], string>> = readonly [],
  Surface extends AnySurface | undefined = undefined,
  const Hidden extends boolean = false,
  TM extends Schema.Top = never,
>(
  options: FlatOptions<
    Parameter<Type, Attributes, Rels, Meta, IdSchema>,
    List,
    Filters,
    Surface,
    Create,
    Update,
    Hidden,
    TM
  >,
) => {
  const { collection, document, listQuery } = flatWire(options);
  type Document = typeof document;
  // Only the writes widen: `get` keeps the full document, so a hidden
  // resource stays a 404 there.
  type Committed = DataDocument<
    Schema.Struct<Parameter<Type, Attributes, Rels, Meta, IdSchema>["identifier"]["fields"]>
  >;
  type Success = Hidden extends true ? Schema.Union<readonly [Document, Committed]> : Document;
  // SAFETY: `Hidden` is the literal type of `options.hiddenWrites`, so the
  // branch taken is the one the conditional type names.
  // oxlint-disable-next-line effect/casting-awareness -- a ternary can't narrow a generic conditional type (`Success`); the SAFETY comment above is why the branch matches
  const success = (
    options.hiddenWrites === true
      ? Endpoint.WriteDocument(options.resource, {
          included: options.include?.included,
          toManyMeta: options.toManyMeta,
        })
      : document
  ) as Success;
  const write = { payloadMediaType: FLAT_PAYLOAD_MEDIA_TYPE, success } as const;
  return {
    group: resource(options.resource, {
      ...SHARED_FLAT_OPTIONS,
      endpoints: {
        list: { query: listQuery, success: collection },
        get: { query: Endpoint.FlatGetQuery, success: document },
        create: { ...write, payload: options.create },
        update: { ...write, payload: options.update, errors: [ApiError.Conflict] },
        delete: true,
      },
    }),
    listQuery,
  };
};
