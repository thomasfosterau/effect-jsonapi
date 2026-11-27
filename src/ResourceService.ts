/**
 * The seam between a decoded JSON:API request and an application's data: a
 * {@link Service} per resource, and {@link layer}, which implements a whole
 * `Group.resource` (or `Group.make`) group over it, with `included`
 * resolution, pagination links and the specification's statuses.
 *
 * @since 0.24.0
 */
import * as Arr from "effect/Array";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import type * as Ordering from "effect/Ordering";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Ref from "effect/Ref";
import type * as Schema from "effect/Schema";
import type { HttpApi, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { HttpApiBuilder } from "effect/http-api";
import * as Handlers from "./Handlers.js";
import { declarationError } from "./internal/errors.js";
import { type Kind, Operation } from "./internal/operation.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import type * as Resource from "./Resource.js";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * The resource definitions a {@link Service} is typed against: anything
 * `Resource.make` or `Resource.extend` builds.
 *
 * @since 0.24.0
 * @category models
 */
export interface Definition extends Resource.Any {
  readonly Type: Handlers.ResourceValue;
  readonly Id: Schema.Top & { readonly Type: string };
  readonly createPayload: Schema.Top & { readonly Type: { readonly data: WriteData } };
  readonly updatePayload: Schema.Top & { readonly Type: { readonly data: WriteData } };
}

/**
 * The shape every create and update `data` member shares, which
 * {@link layer} reads to check the identifiers a write carries.
 *
 * @since 0.24.0
 * @category models
 */
export interface WriteData {
  readonly type: string;
  readonly id?: string;
  readonly attributes?: R.ReadonlyRecord<string, unknown>;
  readonly relationships?: R.ReadonlyRecord<string, { readonly data: Handlers.LinkageValue }>;
}

/**
 * The resource value a definition decodes to.
 *
 * @since 0.24.0
 * @category type-level
 */
export type ValueOf<Res extends Definition> = Res["Type"];

/**
 * The branded id of a definition.
 *
 * @since 0.24.0
 * @category type-level
 */
export type IdOf<Res extends Definition> = Res["Id"]["Type"];

/**
 * The `data` member of a create request, as the `create` endpoint decodes it.
 *
 * @since 0.24.0
 * @category type-level
 */
export type CreateData<Res extends Definition> = Res["createPayload"]["Type"]["data"];

/**
 * The `data` member of an update request, as the `update` endpoint decodes it.
 *
 * @since 0.24.0
 * @category type-level
 */
export type UpdateData<Res extends Definition> = Res["updatePayload"]["Type"]["data"];

/**
 * The decoded query of a read endpoint, as `Query.schema` nests it. A
 * service reads the members its endpoints declare; the rest are absent.
 *
 * @since 0.24.0
 * @category models
 */
export interface ReadQuery {
  readonly include?: ReadonlyArray<string>;
  readonly fields?: Handlers.Fields;
}

/**
 * The decoded query of a collection endpoint (`list`, or a related to-many
 * the service pages itself). `filter` is whatever the endpoint's `filter`
 * option decodes: a field map's struct, or the `Filter` grammar's tree.
 *
 * @since 0.24.0
 * @category models
 */
export interface ListQuery extends ReadQuery {
  readonly sort?: ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }>;
  readonly page?: R.ReadonlyRecord<string, string | number>;
  readonly filter?: R.ReadonlyRecord<string, unknown>;
}

/**
 * One page of a collection and the collection's unpaged total, from which
 * {@link layer} builds the pagination links.
 *
 * @since 0.24.0
 * @category models
 */
export interface Page<A> {
  readonly items: ReadonlyArray<A>;
  readonly total: number;
}

/**
 * What an application implements for one resource. Only `find` is required;
 * {@link layer} needs each other member exactly when the group declares the
 * endpoint that calls it, and checks that when the layer is built.
 *
 * Every operation fails with the application's own errors, which must be
 * ones the group declares. An operation that cannot find its resource fails
 * with the group's not-found error: the layer never invents a 404.
 *
 * Authorisation, field visibility and lifecycle hooks are wrappers around a
 * service, not callbacks of it: build a `Service` from another one, with
 * `Effect.tap` before a write or `Effect.map` over what a read answers.
 *
 * @since 0.24.0
 * @category models
 */
export interface Service<Res extends Definition, E = never, R = never> {
  /** `GET /<type>/:id`, and every read that starts from one resource. */
  readonly find: (id: IdOf<Res>, query: ReadQuery) => Effect.Effect<ValueOf<Res>, E, R>;
  /**
   * The batch loader `included` resolution calls once per level with every
   * id it reached; ids it does not return are left out of `included`.
   * Defaults to `find` per id, run concurrently, with failures dropped.
   */
  readonly findMany?: (
    ids: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<ValueOf<Res>>, E, R>;
  /** `GET /<type>`. */
  readonly list?: (query: ListQuery) => Effect.Effect<Page<ValueOf<Res>>, E, R>;
  /** `POST /<type>`: the stored resource, answered 201. */
  readonly create?: (data: CreateData<Res>) => Effect.Effect<ValueOf<Res>, E, R>;
  /** `PATCH /<type>/:id`: the stored resource, answered 200. */
  readonly update?: (id: IdOf<Res>, data: UpdateData<Res>) => Effect.Effect<ValueOf<Res>, E, R>;
  /** `DELETE /<type>/:id`, answered 204. */
  readonly delete?: (id: IdOf<Res>) => Effect.Effect<void, E, R>;
  /**
   * One page of a to-many relationship whose linkage the resource does not
   * carry inline (`Relationship.paginated`), for its related and
   * relationship endpoints. A relationship with inline linkage is read from
   * `find` and loaded through the include targets instead.
   */
  readonly related?: (
    id: IdOf<Res>,
    relationship: string,
    query: ListQuery,
  ) => Effect.Effect<Page<Handlers.ResourceValue>, E, R>;
  /** `PATCH /<type>/:id/relationships/<name>`: replace the linkage. */
  readonly setRelationship?: (
    id: IdOf<Res>,
    relationship: string,
    data: Handlers.LinkageValue,
  ) => Effect.Effect<void, E, R>;
  /** `POST /<type>/:id/relationships/<name>`: add members to a to-many. */
  readonly addToRelationship?: (
    id: IdOf<Res>,
    relationship: string,
    data: ReadonlyArray<Handlers.ResourceIdentifierValue>,
  ) => Effect.Effect<void, E, R>;
  /** `DELETE /<type>/:id/relationships/<name>`: remove members from a to-many. */
  readonly removeFromRelationship?: (
    id: IdOf<Res>,
    relationship: string,
    data: ReadonlyArray<Handlers.ResourceIdentifierValue>,
  ) => Effect.Effect<void, E, R>;
}

/**
 * Options of {@link layer}.
 *
 * @since 0.24.0
 * @category models
 */
export interface LayerOptions<Targets extends Handlers.IncludeTargets, NE = never> {
  /**
   * The loaders for the other types `?include=` and the related endpoints
   * reach, keyed by type: pass another service through {@link includeTarget}.
   * The group's own type is added from the service. A path that reaches a
   * type with no loader is a defect, answered 500.
   */
  readonly include?: Targets;
  /** Options of the include walk: its concurrency and depth bound. */
  readonly resolve?: Handlers.ResolveIncludedOptions;
  /**
   * The failure for a write whose linkage names a resource that does not
   * exist, which the specification answers 404. When given, every
   * identifier a create, an update or a relationship write carries is loaded
   * through the include targets first, and the first one missing fails the
   * write with this error before the service runs. Without it, checking is
   * the service's job.
   */
  readonly missingTarget?: (identifier: Handlers.ResourceIdentifierValue) => NE;
}

/**
 * A service's batch loader, for another group's {@link LayerOptions.include}.
 *
 * @since 0.24.0
 * @category constructors
 */
export const includeTarget = <Res extends Definition, E, R>(
  service: Service<Res, E, R>,
): Handlers.IncludeTarget<ValueOf<Res>, E, R> =>
  service.findMany ??
  ((ids) =>
    Effect.map(
      Effect.forEach(
        ids,
        // SAFETY: the include walk hands a loader the ids its own type's
        // linkage carries, which the router decoded through the same `Id`.
        (id) => Effect.option(service.find(id as IdOf<Res>, {})),
        { concurrency: "unbounded" },
      ),
      Arr.getSomes,
    ));

/**
 * The failures a group's endpoints declare: what a {@link Service} for it
 * and {@link LayerOptions.missingTarget} may fail with.
 *
 * @since 0.24.0
 * @category type-level
 */
export type GroupError<
  Groups extends HttpApiGroup.Constraint,
  Id extends string,
> = HttpApiEndpoint.Errors<HttpApiGroup.Endpoints<HttpApiGroup.WithIdentifier<Groups, Id>>>;

// ---------------------------------------------------------------------------
// The generic handlers
// ---------------------------------------------------------------------------

type Identifier = Handlers.ResourceIdentifierValue;
type Value = Handlers.ResourceValue;
type Erased<A = unknown> = Effect.Effect<A, unknown, unknown>;

// A service with its resource erased. Method signatures, whose parameters
// compare bivariantly, so every `Service<Res, E, R>` is one.
interface ErasedService {
  find(id: string, query: ReadQuery): Erased<Value>;
  findMany?(ids: ReadonlyArray<string>): Erased<ReadonlyArray<Value>>;
  list?(query: ListQuery): Erased<Page<Value>>;
  create?(data: WriteData): Erased<Value>;
  update?(id: string, data: WriteData): Erased<Value>;
  delete?(id: string): Erased<void>;
  related?(id: string, relationship: string, query: ListQuery): Erased<Page<Value>>;
  setRelationship?(id: string, relationship: string, data: Handlers.LinkageValue): Erased<void>;
  addToRelationship?(
    id: string,
    relationship: string,
    data: ReadonlyArray<Identifier>,
  ): Erased<void>;
  removeFromRelationship?(
    id: string,
    relationship: string,
    data: ReadonlyArray<Identifier>,
  ): Erased<void>;
}

// The service member each operation calls, beyond `find`.
const requiredMember: R.ReadonlyRecord<Kind["_tag"], Option.Option<keyof ErasedService>> = {
  get: Option.none(),
  list: Option.some("list"),
  create: Option.some("create"),
  update: Option.some("update"),
  delete: Option.some("delete"),
  related: Option.none(),
  relationship: Option.none(),
  updateRelationship: Option.some("setRelationship"),
  addRelationship: Option.some("addToRelationship"),
  removeRelationship: Option.some("removeFromRelationship"),
};

// The request an erased group's builder hands every handler.
type ErasedRequest = Parameters<HttpApiEndpoint.Handler<HttpApiEndpoint.Top, never, never>>[0];

// The request the router hands each handler, as the endpoints declare it.
interface Request extends ErasedRequest {
  readonly params: { readonly id: string };
  readonly query: ListQuery;
  readonly payload: { readonly data: WriteData & Handlers.LinkageValue };
}

type Handler = (request: Request) => Erased;

const identifiersOf = (linkage: Handlers.LinkageValue): ReadonlyArray<Identifier> =>
  P.isNull(linkage) ? [] : "type" in linkage ? [linkage] : linkage;

const linkageOf = (value: Value, relationship: string): Handlers.LinkageValue =>
  value.relationships?.[relationship]?.data ?? null;

const sameIdentifier =
  (left: Identifier) =>
  (right: Identifier): boolean =>
    left.type === right.type && left.id === right.id;

// The resources the identifiers name, loaded through the targets, in order;
// identifiers no target returns are left out.
const loadAll = (
  identifiers: ReadonlyArray<Identifier>,
  targets: Handlers.IncludeTargets,
): Erased<ReadonlyArray<Value>> =>
  Effect.map(
    Effect.forEach(
      Arr.dedupe(Arr.map(identifiers, (identifier) => identifier.type)),
      (type) =>
        Option.match(Option.fromUndefinedOr(targets[type]), {
          onNone: () =>
            Effect.die(
              declarationError(
                `ResourceService.layer: no include target loads "${type}" resources`,
              ),
            ),
          onSome: (load) =>
            load(
              Arr.map(
                Arr.filter(identifiers, (identifier) => identifier.type === type),
                (identifier) => identifier.id,
              ),
            ),
        }),
      { concurrency: "unbounded" },
    ),
    (batches) => {
      const loaded = Arr.flatten(batches);
      return Arr.getSomes(
        Arr.map(identifiers, (identifier) => Arr.findFirst(loaded, sameIdentifier(identifier))),
      );
    },
  );

const pathFor = (endpoint: HttpApiEndpoint.Top, id: string): string =>
  endpoint.path.replace(":id", encodeURIComponent(id));

// A numeric bound of a decoded `page` member, by name.
const bound = (query: ListQuery, key: string): Option.Option<number> =>
  Option.filter(Option.fromUndefinedOr(query.page?.[key]), P.isNumber);

const member = (key: string, value: Option.Option<number>): R.ReadonlyRecord<string, number> =>
  Option.match(value, { onNone: () => ({}), onSome: (n) => ({ [key]: n }) });

// The links of a collection document at `path`: the pagination links of the
// strategy the decoded `page` member names, or `self` alone.
const collectionLinks = (
  path: string,
  endpoint: HttpApiEndpoint.Top,
  query: ListQuery,
  total: Option.Option<number>,
): Handlers.LinksValue => {
  const pairs = P.isUndefined(endpoint.query)
    ? []
    : // SAFETY: every `Endpoint.*` read declares its query through `Query.schema`.
      Query.canonicalPairs(endpoint.query as Query.FlatQuerySchema)(query);
  const offset = bound(query, "offset");
  const limit = bound(query, "limit");
  const number = bound(query, "number");
  const size = bound(query, "size");
  const self = {
    self: Arr.isReadonlyArrayNonEmpty(pairs) ? `${path}?${Query.serialise(pairs)}` : path,
  };
  return Option.match(total, {
    onNone: () => self,
    onSome: (total) =>
      Option.isSome(offset) || Option.isSome(limit)
        ? Handlers.offsetPaginationLinks(
            path,
            { ...member("offset", offset), ...member("limit", limit) },
            total,
            { query: pairs },
          )
        : Option.isSome(number) || Option.isSome(size)
          ? Handlers.numberPaginationLinks(
              path,
              { ...member("number", number), ...member("size", size) },
              total,
              { query: pairs },
            )
          : self,
  });
};

// What every handler of one endpoint closes over.
interface Wiring {
  readonly endpoint: HttpApiEndpoint.Top;
  readonly resource: Definition;
  readonly service: ErasedService;
  readonly targets: Handlers.IncludeTargets;
  readonly options: LayerOptions<Handlers.IncludeTargets, unknown>;
}

// The `included` member of a read's document: absent without `?include=`.
const includedFor =
  ({ targets, options }: Wiring) =>
  (primary: Parameters<typeof Handlers.resolveIncluded>[0], query: ReadQuery) =>
    Effect.map(
      Handlers.resolveIncluded(
        primary,
        Option.fromUndefinedOr(query.include),
        targets,
        options.resolve,
      ),
      (resolved) =>
        Option.match(resolved, {
          onNone: () => ({}),
          onSome: (included) => ({ included }),
        }),
    );

const project = (query: ReadQuery) => Handlers.project(query.fields);

const caller =
  (service: ErasedService) =>
  <K extends keyof ErasedService>(key: K) =>
    // SAFETY: `layer` checked, when it was built, that the service has every
    // member the group's endpoints call.
    service[key] as NonNullable<ErasedService[K]>;

// Fails with `missingTarget` for the first identifier no target loads.
const checked = (
  { targets, options }: Wiring,
  identifiers: ReadonlyArray<Identifier>,
): Erased<void> =>
  Option.match(Option.fromUndefinedOr(options.missingTarget), {
    onNone: () => Effect.void,
    onSome: (missing) =>
      Arr.isReadonlyArrayNonEmpty(identifiers)
        ? Effect.flatMap(loadAll(identifiers, targets), (loaded) =>
            Option.match(
              Arr.findFirst(
                identifiers,
                (identifier) => !Arr.some(loaded, sameIdentifier(identifier)),
              ),
              {
                onNone: () => Effect.void,
                onSome: (identifier) => Effect.fail(missing(identifier)),
              },
            ),
          )
        : Effect.void,
  });

const payloadIdentifiers = (data: WriteData): ReadonlyArray<Identifier> =>
  Arr.flatMap(R.values(data.relationships ?? {}), (relationship) =>
    identifiersOf(relationship.data),
  );

// The handlers of the resource operations.
const resourceHandler = (
  tag: "get" | "list" | "create" | "update" | "delete",
  wiring: Wiring,
): Handler => {
  const { endpoint, service } = wiring;
  const included = includedFor(wiring);
  const call = caller(service);
  const handlers: R.ReadonlyRecord<typeof tag, Handler> = {
    get: ({ params, query }) =>
      Effect.flatMap(service.find(params.id, query), (value) =>
        Effect.map(included(value, query), (members) =>
          Handlers.data(value, {
            ...members,
            self: pathFor(endpoint, value.id),
            onResource: project(query),
          }),
        ),
      ),
    list: ({ query }) =>
      Effect.flatMap(call("list")(query), (page) =>
        Effect.map(included(page.items, query), (members) =>
          Handlers.collection(page.items, {
            ...members,
            links: collectionLinks(endpoint.path, endpoint, query, Option.some(page.total)),
            onResource: project(query),
          }),
        ),
      ),
    create: ({ payload }) =>
      Effect.map(
        Effect.andThen(
          checked(wiring, payloadIdentifiers(payload.data)),
          call("create")(payload.data),
        ),
        (value) => {
          const self = `${endpoint.path}/${encodeURIComponent(value.id)}`;
          return Handlers.data({ ...value, links: { self } }, { self });
        },
      ),
    update: ({ params, payload }) =>
      Effect.map(
        Effect.andThen(
          checked(wiring, payloadIdentifiers(payload.data)),
          call("update")(params.id, payload.data),
        ),
        (value) => Handlers.data(value, { self: pathFor(endpoint, value.id) }),
      ),
    delete: ({ params }) => call("delete")(params.id),
  };
  return handlers[tag];
};

// The handlers of the relationship operations.
const relationshipHandler = (
  tag: "related" | "relationship" | "updateRelationship" | "addRelationship" | "removeRelationship",
  relationship: string,
  wiring: Wiring,
): Handler => {
  const { endpoint, resource, service, targets } = wiring;
  const included = includedFor(wiring);
  const call = caller(service);
  const descriptor = Option.fromUndefinedOr(resource.relationships[relationship]);
  const inline = Option.exists(descriptor, Relationship.isLinkable);
  const toOne = Option.exists(descriptor, Relationship.isToOne);

  // The relationship's linkage and members: inline from `find`, or one page
  // of them from the service.
  const page = (id: string, query: ListQuery) =>
    inline
      ? Effect.flatMap(service.find(id, {}), (value) => {
          const linkage = linkageOf(value, relationship);
          return Effect.map(loadAll(identifiersOf(linkage), targets), (items) => ({
            linkage,
            items,
            total: Option.none<number>(),
          }));
        })
      : Effect.map(call("related")(id, relationship, query), (page) => ({
          linkage: Arr.map(page.items, (item): Identifier => ({ type: item.type, id: item.id })),
          items: page.items,
          total: Option.some(page.total),
        }));
  const linkageDocument = (id: string, query: ListQuery) =>
    Effect.flatMap(page(id, query), (members) =>
      Effect.map(included(members.items, query), (compound) =>
        Handlers.linkage(members.linkage, {
          ...compound,
          links: collectionLinks(pathFor(endpoint, id), endpoint, query, members.total),
          onResource: project(query),
        }),
      ),
    );

  const handlers: R.ReadonlyRecord<typeof tag, Handler> = {
    related: ({ params, query }) =>
      Effect.flatMap(page(params.id, query), (members) =>
        Effect.map(included(members.items, query), (compound) =>
          toOne
            ? Handlers.data(Option.getOrNull(Arr.head(members.items)), {
                ...compound,
                self: pathFor(endpoint, params.id),
                onResource: project(query),
              })
            : Handlers.collection(members.items, {
                ...compound,
                links: collectionLinks(
                  pathFor(endpoint, params.id),
                  endpoint,
                  query,
                  members.total,
                ),
                onResource: project(query),
              }),
        ),
      ),
    relationship: ({ params, query }) => linkageDocument(params.id, query),
    updateRelationship: ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(
          checked(wiring, identifiersOf(payload.data)),
          call("setRelationship")(params.id, relationship, payload.data),
        ),
        linkageDocument(params.id, {}),
      ),
    addRelationship: ({ params, payload }) =>
      Effect.andThen(
        Effect.andThen(
          checked(wiring, identifiersOf(payload.data)),
          call("addToRelationship")(params.id, relationship, identifiersOf(payload.data)),
        ),
        linkageDocument(params.id, {}),
      ),
    removeRelationship: ({ params, payload }) =>
      call("removeFromRelationship")(params.id, relationship, identifiersOf(payload.data)),
  };
  return handlers[tag];
};

// One endpoint's handler, after the checks `layer` makes when it is built.
const endpointHandler = (
  group: string,
  endpoint: HttpApiEndpoint.Top,
  wiring: Omit<Wiring, "endpoint">,
): Effect.Effect<readonly [string, (request: ErasedRequest) => Erased]> => {
  const defect = (message: string) =>
    Effect.die(
      declarationError(
        `ResourceService.layer: the "${endpoint.identifier}" endpoint of "${group}" ${message}`,
      ),
    );
  return Option.match(Context.getOption(endpoint.annotations, Operation), {
    onNone: () =>
      defect(
        "was not built by an Endpoint.* operation; implement this group with HttpApiBuilder.group",
      ),
    onSome: (operation) => {
      const missing = Option.filter(requiredMember[operation._tag], (key) =>
        P.isUndefined(wiring.service[key]),
      );
      if (Option.isSome(missing)) return defect(`needs the service's \`${missing.value}\``);
      if (operation.type !== wiring.resource.type) {
        return defect(`serves "${operation.type}", not "${wiring.resource.type}"`);
      }
      const full = { ...wiring, endpoint };
      const handler =
        "relationship" in operation
          ? relationshipHandler(operation._tag, operation.relationship, full)
          : resourceHandler(operation._tag, full);
      // SAFETY: the router hands a handler only requests its own endpoint
      // decoded, and an `Endpoint.*` operation declares them in `Request`'s shape.
      const erased = handler as (request: ErasedRequest) => Erased;
      return Effect.succeed([endpoint.identifier, erased] as const);
    },
  });
};

/**
 * Implements every endpoint of a JSON:API group over a {@link Service}: the
 * group `Group.resource` generates, or one `Group.make` assembles from the
 * `Endpoint.*` constructors, renamed and re-pathed endpoints included.
 *
 * Reads resolve `?include=` through the batched include walk (the service's
 * own loader plus {@link LayerOptions.include}), project `?fields[TYPE]=`,
 * and build `self` and pagination links from the endpoint's path and the
 * request's canonical query (`page[offset]` / `page[limit]` or
 * `page[number]` / `page[size]`). Writes answer the endpoints' default
 * statuses: 201 with the created resource, 200 with the updated one or the
 * new linkage, 204 for a delete.
 *
 * Building the layer dies when the group has an endpoint no `Endpoint.*`
 * operation built (an `Endpoint.action`, a hand-written endpoint) or when
 * the service lacks a member one of its endpoints calls: implement such a
 * group by hand with `HttpApiBuilder.group`. An endpoint whose `success` is
 * overridden is answered with the default document all the same.
 *
 * @example
 * ```ts
 * import { strictEqual } from "node:assert"
 * import { Layer, Schema } from "effect"
 * import { HttpRouter } from "effect/http"
 * import { HttpApi, HttpApiBuilder } from "effect/http-api"
 * import { ApiError, Group, Middleware, Resource, ResourceService } from "@thomasfosterau/effect-jsonapi"
 * import { platformLayer } from "@thomasfosterau/effect-jsonapi/Registry"
 *
 * const Article = Resource.make("articles", { attributes: { title: Schema.String } })
 * class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
 *   status: 404,
 *   fields: { id: Schema.String }
 * }) {}
 *
 * const Api = HttpApi.make("blog").add(Group.resource(Article, { errors: [ArticleNotFound] }))
 *
 * const articles = ResourceService.memory(Article, {
 *   notFound: (id) => new ArticleNotFound({ id }),
 *   initial: [Article.make({ id: Article.Id.make("1"), attributes: { title: "Hello" } })]
 * })
 *
 * const ApiLive = HttpApiBuilder.layer(Api).pipe(
 *   Layer.provide(ResourceService.layer(Api, "articles", Article, articles)),
 *   Layer.provide(Middleware.layer),
 *   Layer.provide(platformLayer)
 * )
 *
 * const { dispose, handler } = HttpRouter.toWebHandler(ApiLive)
 * void handler(
 *   new Request("http://localhost/articles/1", { headers: { accept: "application/vnd.api+json" } })
 * ).then((response) => {
 *   strictEqual(response.status, 200)
 *   return dispose()
 * })
 * ```
 *
 * @since 0.24.0
 * @category layers
 */
export function layer<
  ApiId extends string,
  Groups extends HttpApiGroup.Constraint,
  const Id extends HttpApiGroup.Identifier<Groups>,
  Res extends Definition,
  E extends GroupError<Groups, Id>,
  R,
  const Targets extends Handlers.IncludeTargets = Record<never, never>,
  NE extends GroupError<Groups, Id> = never,
  LE = never,
  LR = never,
>(
  api: HttpApi.HttpApi<ApiId, Groups>,
  group: Id,
  resource: Res,
  service: Service<Res, E, R> | Effect.Effect<Service<Res, E, R>, LE, LR>,
  options?: LayerOptions<Targets, NE>,
): Layer.Layer<
  HttpApiGroup.Service<ApiId, Id>,
  LE,
  LR | R | Handlers.IncludeTargetServices<Targets>
>;
export function layer(
  api: HttpApi.Top,
  group: string,
  resource: Definition,
  service: ErasedService | Erased<ErasedService>,
  options?: LayerOptions<Handlers.IncludeTargets, unknown>,
): Layer.Layer<HttpApiGroup.Service<string, string>, unknown, unknown> {
  return Layer.unwrap(
    Effect.gen(function* () {
      const resolved = Effect.isEffect(service) ? yield* service : service;
      const endpoints = R.values(
        Option.getOrElse(
          Option.map(R.get(api.groups, group), (found) => found.endpoints),
          () => ({}),
        ),
      );
      const targets: Handlers.IncludeTargets = {
        ...options?.include,
        [resource.type]: includeTarget(resolved),
      };
      const handlers = yield* Effect.forEach(
        endpoints,
        (endpoint) =>
          endpointHandler(group, endpoint, {
            resource,
            service: resolved,
            targets,
            options: options ?? {},
          }),
        { concurrency: "unbounded" },
      );
      const all: { readonly [endpoint: string]: (request: ErasedRequest) => Erased } =
        R.fromEntries(handlers);
      return HttpApiBuilder.group(api, group, (builder) => builder.handleAll(all));
    }),
  );
}

// ---------------------------------------------------------------------------
// The in-memory service
// ---------------------------------------------------------------------------

/**
 * Options of {@link memory}.
 *
 * @since 0.24.0
 * @category models
 */
export interface MemoryOptions<Res extends Definition, E> {
  /** The failure for an id the store does not hold, e.g. the group's 404. */
  readonly notFound: (id: string) => E;
  /** The resources the store starts with. */
  readonly initial?: ReadonlyArray<ValueOf<Res>>;
  /** The id of a created resource. Defaults to a counter past the initial ids. */
  readonly id?: () => string;
}

interface Stored extends Value {
  readonly attributes?: R.ReadonlyRecord<string, unknown>;
  readonly relationships?: R.ReadonlyRecord<string, { readonly data?: Handlers.LinkageValue }>;
}

// Orders two values when `is` holds for both.
const ordered =
  <In, A extends In>(is: P.Refinement<In, A>, order: Order.Order<A>) =>
  (left: In, right: In): Option.Option<Ordering.Ordering> =>
    is(left) && is(right) ? Option.some(order(left, right)) : Option.none();

const orderings = [
  ordered(P.isNumber, Order.Number),
  ordered(P.isString, Order.String),
  ordered(P.isBoolean, Order.Boolean),
  ordered(P.isDate, Order.Date),
];

// Orders attribute values of one kind (numbers, strings, booleans or dates);
// an absent value sorts first, and values of different kinds tie.
const compareValues: Order.Order<unknown> = (left, right) =>
  P.isUndefined(left) || P.isUndefined(right)
    ? Order.Boolean(!P.isUndefined(left), !P.isUndefined(right))
    : Option.getOrElse(
        Option.firstSomeOf(Arr.map(orderings, (compare) => compare(left, right))),
        (): Ordering.Ordering => 0,
      );

// A created resource's default for a relationship its payload leaves out:
// empty inline linkage, or the links of a paginated one.
const defaultRelationship = (
  type: string,
  id: string,
  name: string,
  descriptor: Relationship.Descriptor,
): Option.Option<object> =>
  !Relationship.isLinkable(descriptor)
    ? Option.some(Handlers.paginatedRelationship(type, id, name))
    : descriptor.kind === "many"
      ? Option.some({ data: [] })
      : descriptor.kind === "optional"
        ? Option.some({ data: null })
        : Option.none();

const isScalar = P.or(P.isString, P.or(P.isNumber, P.isBoolean));

const unsupported = (message: string) =>
  Effect.die(declarationError(`ResourceService.memory ${message}`));

/**
 * An in-memory {@link Service}, for tests, examples and prototypes. `list`
 * answers a filter map by equality on an attribute or a to-one
 * relationship's id, sorts by attributes and pages by `page[offset]` /
 * `page[limit]` or `page[number]` / `page[size]`; a `Filter` grammar tree or
 * a cursor page is a defect. A relationship write is stored as given (pair
 * it with {@link LayerOptions.missingTarget} to refuse a missing target),
 * and a `Relationship.paginated` relationship is answered empty.
 *
 * @since 0.24.0
 * @category constructors
 */
export const memory = <Res extends Definition, E>(
  resource: Res,
  options: MemoryOptions<Res, E>,
): Effect.Effect<Service<Res, E>> =>
  Effect.map(Ref.make<ReadonlyArray<Stored>>(options.initial ?? []), (store): Service<Res, E> => {
    const counter = Ref.makeUnsafe((options.initial ?? []).length);
    const nextId = Option.match(Option.fromUndefinedOr(options.id), {
      onNone: () =>
        Effect.map(
          Ref.updateAndGet(counter, (n) => n + 1),
          (n) => `${n}`,
        ),
      onSome: (id) => Effect.sync(id),
    });
    const read = (id: string): Effect.Effect<Stored, E> =>
      Effect.flatMap(Ref.get(store), (values) =>
        Option.match(
          Arr.findFirst(values, (value) => value.id === id),
          { onNone: () => Effect.fail(options.notFound(id)), onSome: Effect.succeed },
        ),
      );
    const write = (stored: Stored) =>
      Ref.update(store, (values) =>
        Arr.some(values, (value) => value.id === stored.id)
          ? Arr.map(values, (value) => (value.id === stored.id ? stored : value))
          : Arr.append(values, stored),
      );
    // Whether a stored value's attribute, or to-one relationship's id, is
    // `expected`.
    const holds = (value: Stored, field: string) => (expected: string | number | boolean) =>
      Option.match(Option.fromUndefinedOr(value.attributes?.[field]), {
        onSome: (actual) => actual === expected,
        onNone: () =>
          Arr.some(identifiersOf(linkageOf(value, field)), (linked) => linked.id === expected),
      });
    const filtered = (values: ReadonlyArray<Stored>, filter: ListQuery["filter"]) =>
      P.isUndefined(filter)
        ? Effect.succeed(values)
        : Arr.every(R.values(filter), isScalar)
          ? Effect.succeed(
              Arr.filter(values, (value) =>
                Arr.every(R.toEntries(filter), ([field, expected]) =>
                  isScalar(expected) ? holds(value, field)(expected) : true,
                ),
              ),
            )
          : unsupported("answers only equality filter maps");
    const sorted = (values: ReadonlyArray<Stored>, sort: ListQuery["sort"]) =>
      Arr.sortBy(
        ...Arr.map(sort ?? [], (term) => {
          const ascending = Order.mapInput(
            compareValues,
            (value: Stored) => value.attributes?.[term.field],
          );
          return term.direction === "desc" ? Order.flip(ascending) : ascending;
        }),
      )(values);
    const paged = (values: ReadonlyArray<Stored>, query: ListQuery) => {
      if (Arr.some(R.values(query.page ?? {}), P.isString)) {
        return unsupported("answers only numeric pages");
      }
      const at = (key: string, fallback: number) =>
        Option.getOrElse(bound(query, key), () => fallback);
      const numbered = Option.isSome(bound(query, "number")) || Option.isSome(bound(query, "size"));
      const size = at("size", values.length);
      const offset = numbered ? (at("number", 1) - 1) * size : at("offset", 0);
      const limit = numbered ? size : at("limit", values.length);
      return Effect.succeed(values.slice(offset, offset + limit));
    };
    const setLinkage = (id: string, name: string, data: Handlers.LinkageValue) =>
      Effect.flatMap(read(id), (value) =>
        write({ ...value, relationships: { ...value.relationships, [name]: { data } } }),
      );

    const service: ErasedService = {
      find: read,
      findMany: (ids) =>
        Effect.map(Ref.get(store), (values) =>
          Arr.filter(values, (value) => Arr.contains(ids, value.id)),
        ),
      list: (query) =>
        Effect.flatMap(Ref.get(store), (values) =>
          Effect.flatMap(filtered(values, query.filter), (matching) => {
            const ordered = sorted(matching, query.sort);
            return Effect.map(paged(ordered, query), (items) => ({
              items,
              total: ordered.length,
            }));
          }),
        ),
      create: (data) =>
        Effect.flatMap(
          Option.match(Option.fromUndefinedOr(data.id), {
            onNone: () => nextId,
            onSome: Effect.succeed,
          }),
          (id) => {
            const stored: Stored = {
              type: resource.type,
              id,
              attributes: R.filter(data.attributes ?? {}, P.isNotUndefined),
              relationships: R.getSomes(
                R.map(resource.relationships, (descriptor, name) =>
                  Option.orElse(Option.fromUndefinedOr(data.relationships?.[name]), () =>
                    defaultRelationship(resource.type, id, name, descriptor),
                  ),
                ),
              ),
            };
            return Effect.as(write(stored), stored);
          },
        ),
      update: (id, data) =>
        Effect.flatMap(read(id), (value) => {
          const updated: Stored = {
            ...value,
            attributes: {
              ...value.attributes,
              ...R.filter(data.attributes ?? {}, P.isNotUndefined),
            },
            relationships: { ...value.relationships, ...data.relationships },
          };
          return Effect.as(write(updated), updated);
        }),
      delete: (id) =>
        Effect.andThen(
          read(id),
          Ref.update(store, (values) => Arr.filter(values, (value) => value.id !== id)),
        ),
      related: () => Effect.succeed({ items: [], total: 0 }),
      setRelationship: setLinkage,
      addToRelationship: (id, name, data) =>
        Effect.flatMap(read(id), (value) =>
          setLinkage(
            id,
            name,
            Arr.unionWith(identifiersOf(linkageOf(value, name)), data, (left, right) =>
              sameIdentifier(left)(right),
            ),
          ),
        ),
      removeFromRelationship: (id, name, data) =>
        Effect.flatMap(read(id), (value) =>
          setLinkage(
            id,
            name,
            Arr.filter(
              identifiersOf(linkageOf(value, name)),
              (linked) => !Arr.some(data, sameIdentifier(linked)),
            ),
          ),
        ),
    };
    // SAFETY: the store holds the values the resource decodes to (its
    // `initial` values, and the ones built here from decoded payloads), and
    // each operation reads its arguments through the resource's own shapes.
    return service as Service<Res, E>;
  });
