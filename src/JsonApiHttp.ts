// JSON:API conventions for Effect v4 HttpApi — a thin wrapper over
// HttpApiEndpoint that bakes in the media type, document wrapping, default
// status codes, and the mandatory JSON:API error responses.
//
// Companion to ./JsonApi.ts. Verified against effect@4.0.0-beta.70; the
// `effect/unstable/httpapi` surface may shift between betas.
//
// Design: decorate, don't replace. Every constructor delegates to the real
// HttpApiEndpoint.* and returns its *inferred* type — no hand-written return
// annotations — so Name/Path/Success/Error/Payload inference flows untouched
// into handlers and the derived client.
import { Effect, Schema, SchemaTransformation, Struct } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from "effect/unstable/httpapi"
import {
  AnyMeta,
  Article,
  CollectionDocument,
  Comment,
  DataDocument,
  ErrorDocument,
  ErrorObject,
  Person,
  ResourceId
} from "./JsonApi.js"

export const JSONAPI_MEDIA_TYPE = "application/vnd.api+json"
const JSONAPI = { contentType: JSONAPI_MEDIA_TYPE } as const

// Mark a schema as a JSON:API body and (optionally) set its status.
// No return annotation: the inferred type carries the exact schema through.
const json = <S extends Schema.Top>(schema: S, status?: number) => {
  const body = schema.pipe(HttpApiSchema.asJson(JSONAPI))
  return status === undefined ? body : body.pipe(HttpApiSchema.status(status))
}

// ---------------------------------------------------------------------------
// Layer 1 — schema combinators (preserve inference; use anywhere)
// ---------------------------------------------------------------------------

export const jsonApi = {
  // Single-resource / collection success document. `included` and `meta` are
  // threaded so their types stay precise in the success document.
  success: <
    R extends Schema.Top,
    I extends Schema.Top = typeof Schema.Unknown,
    M extends Schema.Top = typeof AnyMeta
  >(
    resource: R,
    opts?: { readonly included?: I; readonly meta?: M; readonly status?: number }
  ) => json(DataDocument(resource, opts?.included, opts?.meta), opts?.status),

  // Strict `data: ReadonlyArray<resource>` for list endpoints.
  collection: <
    R extends Schema.Top,
    I extends Schema.Top = typeof Schema.Unknown,
    M extends Schema.Top = typeof AnyMeta
  >(
    resource: R,
    opts?: { readonly included?: I; readonly meta?: M; readonly status?: number }
  ) => json(CollectionDocument(resource, opts?.included, opts?.meta), opts?.status),

  // Create success — 201 by convention.
  created: <
    R extends Schema.Top,
    I extends Schema.Top = typeof Schema.Unknown,
    M extends Schema.Top = typeof AnyMeta
  >(
    resource: R,
    opts?: { readonly included?: I; readonly meta?: M }
  ) => json(DataDocument(resource, opts?.included, opts?.meta), 201),

  // Request body: { data: <resource> }.
  payload: <R extends Schema.Top>(resource: R) => json(Schema.Struct({ data: resource }))
}

// ---------------------------------------------------------------------------
// Errors — domain error in the E channel, JSON:API document on the wire
// ---------------------------------------------------------------------------

const ErrDoc = ErrorDocument(ErrorObject)
type ErrDocType = typeof ErrDoc.Type

// Turn a tagged error (the value the handler fails with, and the value the
// client receives) into an endpoint error schema whose encoded form is a
// JSON:API error document, carrying the given HTTP status.
//
// decodeTo runs from the document side, so within the transformation:
//   - `decode` maps document -> domain error (used by the client)
//   - `encode` maps domain error -> document (used by the server)
export const errorResponse = <E extends Schema.Top>(
  error: E,
  status: number,
  toDocument: (e: E["Type"]) => ErrDocType,
  fromDocument: (doc: ErrDocType) => E["Type"]
) =>
  ErrDoc.pipe(
    Schema.decodeTo(
      error,
      SchemaTransformation.transform({ decode: fromDocument, encode: toDocument })
    ),
    HttpApiSchema.status(status),
    HttpApiSchema.asJson(JSONAPI)
  )

// The responses every JSON:API endpoint must be able to produce: 415 on a
// parametrised media type, 406 on a bad Accept, 400 on a malformed document.
export class BadRequest extends Schema.TaggedErrorClass<BadRequest>()("BadRequest", {
  detail: Schema.optionalKey(Schema.String)
}) {}

export class NotAcceptable extends Schema.TaggedErrorClass<NotAcceptable>()("NotAcceptable", {}) {}

export class UnsupportedMediaType extends Schema.TaggedErrorClass<UnsupportedMediaType>()(
  "UnsupportedMediaType",
  {}
) {}

export const BadRequestResponse = errorResponse(
  BadRequest,
  400,
  (e) => ({
    errors: [{
      status: "400",
      code: "bad_request",
      title: "Bad Request",
      ...(e.detail !== undefined ? { detail: e.detail } : {})
    }]
  }),
  (doc) => new BadRequest({ detail: doc.errors[0]?.detail })
)

export const NotAcceptableResponse = errorResponse(
  NotAcceptable,
  406,
  () => ({ errors: [{ status: "406", code: "not_acceptable", title: "Not Acceptable" }] }),
  () => new NotAcceptable()
)

export const UnsupportedMediaTypeResponse = errorResponse(
  UnsupportedMediaType,
  415,
  () => ({
    errors: [{ status: "415", code: "unsupported_media_type", title: "Unsupported Media Type" }]
  }),
  () => new UnsupportedMediaType()
)

export const StandardErrors = [
  BadRequestResponse,
  NotAcceptableResponse,
  UnsupportedMediaTypeResponse
] as const

// ---------------------------------------------------------------------------
// Layer 2 — per-verb constructors (bake in conventions + the standard errors)
// ---------------------------------------------------------------------------
//
// `resource` (and `payload`) generics are threaded so the success/request
// types stay precise. `params`/`query` are typed loosely as Fields — fully
// threading their generics would mean reproducing HttpApiEndpoint's dual
// overloads, which isn't worth the maintenance cost; drop to the raw
// constructor + Layer-1 combinators for endpoints that need that precision.

export const JsonApiEndpoint = {
  get: <
    const Name extends string,
    const Path extends `/${string}`,
    R extends Schema.Top,
    I extends Schema.Top = typeof Schema.Unknown,
    Params extends Schema.Struct.Fields = never,
    Query extends Schema.Struct.Fields = never
  >(
    name: Name,
    path: Path,
    config: {
      readonly params?: Params
      readonly query?: Query
      readonly resource: R
      readonly included?: I
      readonly meta?: Schema.Top
      readonly errors?: ReadonlyArray<Schema.Top>
    }
  ) =>
    HttpApiEndpoint.get(name, path, {
      params: config.params,
      query: config.query,
      success: jsonApi.success(config.resource, {
        included: config.included,
        meta: config.meta
      }),
      error: [...StandardErrors, ...(config.errors ?? [])]
    }),

  list: <
    const Name extends string,
    const Path extends `/${string}`,
    R extends Schema.Top,
    I extends Schema.Top = typeof Schema.Unknown,
    Params extends Schema.Struct.Fields = never,
    Query extends Schema.Struct.Fields = never
  >(
    name: Name,
    path: Path,
    config: {
      readonly params?: Params
      readonly query?: Query
      readonly resource: R
      readonly included?: I
      readonly meta?: Schema.Top
      readonly errors?: ReadonlyArray<Schema.Top>
    }
  ) =>
    HttpApiEndpoint.get(name, path, {
      params: config.params,
      query: config.query,
      success: jsonApi.collection(config.resource, {
        included: config.included,
        meta: config.meta
      }),
      error: [...StandardErrors, ...(config.errors ?? [])]
    }),

  create: <
    const Name extends string,
    const Path extends `/${string}`,
    P extends Schema.Top,
    R extends Schema.Top
  >(
    name: Name,
    path: Path,
    config: {
      readonly payload: P // resource shape inside `data` (typically id-less)
      readonly resource: R
      readonly errors?: ReadonlyArray<Schema.Top>
    }
  ) =>
    HttpApiEndpoint.post(name, path, {
      payload: jsonApi.payload(config.payload),
      success: jsonApi.created(config.resource),
      error: [...StandardErrors, ...(config.errors ?? [])]
    }),

  update: <
    const Name extends string,
    const Path extends `/${string}`,
    P extends Schema.Top,
    R extends Schema.Top,
    Params extends Schema.Struct.Fields = never
  >(
    name: Name,
    path: Path,
    config: {
      readonly params?: Params
      readonly payload: P
      readonly resource: R
      readonly errors?: ReadonlyArray<Schema.Top>
    }
  ) =>
    HttpApiEndpoint.patch(name, path, {
      params: config.params,
      payload: jsonApi.payload(config.payload),
      success: jsonApi.success(config.resource),
      error: [...StandardErrors, ...(config.errors ?? [])]
    }),

  delete: <
    const Name extends string,
    const Path extends `/${string}`,
    Params extends Schema.Struct.Fields = never
  >(
    name: Name,
    path: Path,
    config?: {
      readonly params?: Params
      readonly errors?: ReadonlyArray<Schema.Top>
    }
  ) =>
    HttpApiEndpoint.delete(name, path, {
      params: config?.params,
      success: HttpApiSchema.NoContent, // 204; JSON:API also permits 200 + meta
      error: [...StandardErrors, ...(config?.errors ?? [])]
    })
}

// ===========================================================================
// Worked example
// ===========================================================================

// A per-endpoint domain error. The id is round-tripped through the document's
// `meta` so the client can reconstruct it from the wire body.
export class ArticleNotFound extends Schema.TaggedErrorClass<ArticleNotFound>()("ArticleNotFound", {
  id: Schema.String
}) {}

export const ArticleNotFoundResponse = errorResponse(
  ArticleNotFound,
  404,
  (e) => ({
    errors: [{
      status: "404",
      code: "not_found",
      title: "Resource not found",
      detail: `Article ${e.id} not found`,
      meta: { id: e.id }
    }]
  }),
  (doc) => new ArticleNotFound({ id: String(doc.errors[0]?.meta?.id ?? "") })
)

export const getArticle = JsonApiEndpoint.get("getArticle", "/articles/:id", {
  params: { id: Schema.String },
  resource: Article,
  included: Schema.Union([Person, Comment]),
  errors: [ArticleNotFoundResponse]
})

export const createArticle = JsonApiEndpoint.create("createArticle", "/articles", {
  payload: Article.mapFields(Struct.omit(["id"])), // id-less create resource
  resource: Article
})

export const deleteArticle = JsonApiEndpoint.delete("deleteArticle", "/articles/:id", {
  params: { id: Schema.String },
  errors: [ArticleNotFoundResponse]
})

export const ArticlesGroup = HttpApiGroup.make("articles")
  .add(getArticle)
  .add(createArticle)
  .add(deleteArticle)

export const Api = HttpApi.make("JsonApi").add(ArticlesGroup)

// ---------------------------------------------------------------------------
// In-memory "sample data" used by the worked-example handlers and by the
// HTTP round-trip test. Keeps the example self-contained: no Context services
// to wire up, no IO.
// ---------------------------------------------------------------------------

const SAMPLE_ARTICLE_ID = ResourceId("articles").make("1")
const SAMPLE_AUTHOR_ID = ResourceId("people").make("9")
const SAMPLE_COMMENT_ID = ResourceId("comments").make("5")

export const sampleArticle: typeof Article.Type = Article.make({
  id: SAMPLE_ARTICLE_ID,
  attributes: {
    title: "Hello",
    body: "World",
    createdAt: new Date("2024-01-01T00:00:00.000Z")
  },
  relationships: {
    author: { data: { type: "people", id: SAMPLE_AUTHOR_ID } },
    comments: { data: [{ type: "comments", id: SAMPLE_COMMENT_ID }] }
  }
})

const loadArticle = (id: string): Effect.Effect<typeof Article.Type, ArticleNotFound> =>
  id === SAMPLE_ARTICLE_ID
    ? Effect.succeed(sampleArticle)
    : Effect.fail(new ArticleNotFound({ id }))

const persistArticle = (
  input: { readonly data: Omit<typeof Article.Type, "id"> }
): Effect.Effect<typeof Article.Type> =>
  Effect.succeed(
    Article.make({
      ...input.data,
      id: ResourceId("articles").make("new-id")
    })
  )

export const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("getArticle", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => ({ data: article }))
      )
    )
    .handle("createArticle", ({ payload }) =>
      persistArticle(payload).pipe(Effect.map((article) => ({ data: article })))
    )
    .handle("deleteArticle", ({ params }) =>
      loadArticle(params.id).pipe(Effect.asVoid)
    )
)
