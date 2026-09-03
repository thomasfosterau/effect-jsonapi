/**
 * Server-side document builders.
 *
 * Handlers return values matching their endpoint's document schema. These
 * helpers assemble those values while enforcing the spec's compound-document
 * rules at runtime:
 *
 *   - `included` resources are deduplicated by `(type, id)`
 *   - full linkage: every included resource must be referenced by a resource
 *     identifier somewhere in the document (data's relationships or another
 *     included resource's relationships)
 *
 * ```ts
 * handlers.handle("fetch", ({ params, query }) =>
 *   loadArticle(params.id).pipe(Effect.map((article) =>
 *     data(article, {
 *       included: query.include?.includes("author") ? [author] : [],
 *       self: `/articles/${article.id}`
 *     })
 *   ))
 * )
 * ```
 *
 * @since 0.1.0
 */
import type { JsonApiObject } from "./Document.js"
import { serialise, withPagePairs } from "./internal/canonical.js"
import type { Pair } from "./Query.js"

/**
 * The top-level `jsonapi` object *value* (`{ version?, ext?, profile?, meta? }`).
 *
 * @since 0.3.0
 * @category models
 */
export type JsonApiObjectValue = typeof JsonApiObject.Type

// ---------------------------------------------------------------------------
// Identifiable resources (the runtime shape builders work with)
// ---------------------------------------------------------------------------

/**
 * The minimal runtime shape of a resource object value.
 *
 * Relationship objects either carry inline linkage (`data`) or — for
 * paginated relationships — only `links` / `meta`.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceValue {
  readonly type: string
  readonly id: string
  readonly relationships?: {
    readonly [key: string]: {
      readonly data?: ResourceIdentifierValue | ReadonlyArray<ResourceIdentifierValue> | null
      readonly links?: unknown
      readonly meta?: unknown
    }
  }
}

/**
 * The minimal runtime shape of a resource identifier value.
 *
 * @since 0.1.0
 * @category models
 */
export interface ResourceIdentifierValue {
  readonly type: string
  readonly id: string
}

/**
 * A link value: either a URL string or a link object.
 *
 * @since 0.1.0
 * @category models
 */
export type LinkValue = string | { readonly href: string }

/**
 * Top-level links accepted by the document builders.
 *
 * @since 0.1.0
 * @category models
 */
export interface LinksValue {
  readonly self?: LinkValue
  readonly related?: LinkValue
  readonly describedby?: LinkValue
  readonly first?: LinkValue | null
  readonly last?: LinkValue | null
  readonly prev?: LinkValue | null
  readonly next?: LinkValue | null
}

const key = (identifier: ResourceIdentifierValue): string => `${identifier.type}\0${identifier.id}`

const referencedIdentifiers = (resources: ReadonlyArray<ResourceValue>): Set<string> => {
  const identifiers = new Set<string>()
  for (const resource of resources) {
    for (const relationship of Object.values(resource.relationships ?? {})) {
      const linkage = relationship.data
      if (linkage === null || linkage === undefined) continue
      for (const identifier of Array.isArray(linkage) ? linkage : [linkage]) {
        identifiers.add(key(identifier))
      }
    }
  }
  return identifiers
}

/**
 * Deduplicates included resources by `(type, id)` and verifies the spec's
 * full-linkage rule: every included resource must be referenced by a resource
 * identifier in the document.
 *
 * A linkage violation is a programming error in the handler, so it throws
 * (surfacing as a defect) rather than failing the request.
 *
 * @since 0.1.0
 * @category utils
 */
export const buildIncluded = <Included extends ResourceValue>(
  primary: ReadonlyArray<ResourceValue>,
  included: ReadonlyArray<Included>,
  options?: { readonly checkLinkage?: boolean }
): ReadonlyArray<Included> => {
  // Dedupe by (type, id)
  const seen = new Set<string>()
  const deduped: Array<Included> = []
  for (const resource of included) {
    const k = key(resource)
    if (seen.has(k)) continue
    seen.add(k)
    deduped.push(resource)
  }

  // Full linkage: every included resource is referenced from the document.
  if (options?.checkLinkage !== false) {
    const referenced = referencedIdentifiers([...primary, ...deduped])
    for (const resource of deduped) {
      if (!referenced.has(key(resource))) {
        throw new Error(
          `JSON:API full linkage violation: included resource "${resource.type}:${resource.id}" ` +
            `is not referenced by any resource identifier in the document ` +
            `(https://jsonapi.org/format/1.1/#document-compound-documents)`
        )
      }
    }
  }

  return deduped
}

/**
 * Free-form meta values accepted by the document builders.
 *
 * @since 0.1.0
 * @category models
 */
export type MetaValue = { readonly [key: string]: unknown }

// Simplifies intersections for readable hover types.
type Simplify<T> = { readonly [K in keyof T]: T[K] } & {}

/**
 * A top-level JSON:API document *value* — the shape {@link data} and
 * {@link collection} return, named so consumers can annotate their own
 * document-assembling functions instead of hand-rolling the envelope type.
 *
 * The optional `jsonapi` member (the top-level `jsonapi` object) is included so
 * a builder that stamps it still conforms; the {@link data}/{@link collection}
 * builders themselves omit it.
 *
 * The type stays *conditional* on its generics so TypeScript only infers
 * `Included` / `M` from arguments — never from the expected (contextual) return
 * type of a handler, which breaks down inside `pipe(Effect.map(...))` chains.
 *
 * @since 0.3.0
 * @category models
 */
export type DocumentValue<Data, Included extends ResourceValue = never, M extends MetaValue = never> = Simplify<
  { readonly data: Data; readonly links?: LinksValue; readonly jsonapi?: JsonApiObjectValue } & ([Included] extends [
    never
  ]
    ? {}
    : { readonly included?: ReadonlyArray<Included> }) &
    ([M] extends [never] ? {} : { readonly meta?: M })
>

// Appends a query string (no leading `?`) to a path, whichever separator the
// path needs; a path with no query is returned as is.
const withQuery = (path: string, query: string): string =>
  query === "" ? path : path.includes("?") ? `${path}&${query}` : `${path}?${query}`

// A request's canonical query, however it was handed over.
const queryString = (query: string | ReadonlyArray<Pair>): string =>
  typeof query === "string" ? query : serialise(query)

// A link with a query string appended, in either link spelling.
const linkWithQuery = (link: LinkValue, query: string): LinkValue =>
  typeof link === "string" ? withQuery(link, query) : { ...link, href: withQuery(link.href, query) }

// The top-level links of a document: `links.self` wins over the `self`
// option, and `query` is appended to whichever `self` the document ends up
// with — a `query` with no self link to carry it is a programming error.
const buildLinks = (options: {
  readonly self?: string
  readonly query?: string | ReadonlyArray<Pair>
  readonly links?: LinksValue
}): LinksValue | undefined => {
  const links: LinksValue | undefined =
    options.self !== undefined ? { self: options.self, ...options.links } : options.links
  if (options.query === undefined) return links
  if (links?.self === undefined) {
    throw new Error("Handlers.collection: `query` needs a self link to be appended to — pass `self` or `links.self`")
  }
  return { ...links, self: linkWithQuery(links.self, queryString(options.query)) }
}

const build = (
  data: unknown,
  primary: ReadonlyArray<ResourceValue>,
  options:
    | {
        readonly included?: ReadonlyArray<ResourceValue>
        readonly meta?: MetaValue
        readonly self?: string
        readonly query?: string | ReadonlyArray<Pair>
        readonly links?: LinksValue
        readonly checkLinkage?: boolean
      }
    | undefined
) => {
  const links = options === undefined ? undefined : buildLinks(options)
  const included =
    options?.included !== undefined && options.included.length > 0
      ? buildIncluded(primary, options.included, options)
      : undefined
  return {
    data,
    ...(included !== undefined ? { included } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  }
}

/**
 * Builds a single-resource document value: `{ data, included?, links?, meta? }`.
 *
 * Included resources are deduplicated and checked for full linkage.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     tags: Relationship.many(() => Tag)
 *   }
 * })
 *
 * const author = Person.make({
 *   id: Person.Id.make("9"),
 *   attributes: { firstName: "Dan", lastName: "Gebhardt" }
 * })
 *
 * // in a handler — `handlers` comes from HttpApiBuilder.group, `loadArticle` from your data layer
 * const fetchHandler = (
 *   handlers: {
 *     handle: (
 *       name: string,
 *       handler: (request: {
 *         readonly params: { readonly id: string }
 *         readonly query: { readonly include?: ReadonlyArray<string> }
 *       }) => Effect.Effect<unknown>
 *     ) => void
 *   },
 *   loadArticle: (id: string) => Effect.Effect<typeof Article.Type>
 * ) =>
 *   // build a single-resource response document
 *   handlers.handle("fetch", ({ params, query }) =>
 *     loadArticle(params.id).pipe(
 *       Effect.map((article) =>
 *         Handlers.data(article, {
 *           included: query.include?.includes("author") ? [author] : [],
 *           self: `/articles/${article.id}`
 *         })
 *       )
 *     )
 *   )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const data = <
  R extends ResourceValue | null,
  const Included extends ResourceValue = never,
  const M extends MetaValue = never
>(
  resource: R,
  options?: {
    readonly included?: ReadonlyArray<Included>
    readonly meta?: M
    readonly self?: string
    readonly links?: LinksValue
    /** Disable the full-linkage check (it is on by default). */
    readonly checkLinkage?: boolean
  }
): DocumentValue<R, Included, M> =>
  build(resource, resource === null ? [] : [resource], options) as DocumentValue<R, Included, M>

/**
 * Builds a collection document value: `{ data: [...], included?, links?, meta? }`.
 *
 * Included resources are deduplicated and checked for full linkage.
 *
 * JSON:API 1.1 requires a collection's `self` link to carry the query
 * parameters the client provided. Pass `query` — the request's canonical
 * query, from `Query.canonicalPairs(listQuery)(query)` or the
 * `Query.canonical(listQuery)(query)` string — and it is appended to the
 * document's `self` link, whether that is the `self` option or `links.self`
 * (which wins when both are given); `query` without either throws. A
 * paginated collection gets that for free from the link builders' own
 * `query` option instead ({@link offsetPaginationLinks}): pass the pairs
 * there, not here.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Handlers, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const listQuery = Query.schema(Article, { sort: true, page: Query.Page.Offset })
 *
 * const total = 42
 * const page = [
 *   Article.make({ id: Article.Id.make("1"), attributes: { title: "Hi", body: "..." } })
 * ]
 *
 * // build a paginated collection response document in a handler (`handlers`
 * // comes from HttpApiBuilder.group)
 * const listHandler = (handlers: {
 *   handle: (
 *     name: string,
 *     handler: (request: { readonly query: typeof listQuery.Type }) => Effect.Effect<unknown>
 *   ) => void
 * }) =>
 *   handlers.handle("list", ({ query }) =>
 *     Effect.succeed(
 *       Handlers.collection(page, {
 *         meta: { total },
 *         links: Handlers.offsetPaginationLinks("/articles", query.page ?? {}, total, {
 *           query: Query.canonicalPairs(listQuery)(query)
 *         })
 *       })
 *     )
 *   )
 *
 * // …or, unpaginated, the canonical query on the collection's own `self` link
 * Handlers.collection(page, {
 *   self: "/articles",
 *   query: Query.canonicalPairs(listQuery)({ sort: [{ field: "title", direction: "desc" }] })
 * })
 * // → { data: [...], links: { self: "/articles?sort=-title" } }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const collection = <
  R extends ResourceValue,
  const Included extends ResourceValue = never,
  const M extends MetaValue = never
>(
  resources: ReadonlyArray<R>,
  options?: {
    readonly included?: ReadonlyArray<Included>
    readonly meta?: M
    readonly self?: string
    /**
     * The request's canonical query — `Query.canonicalPairs(schema)(query)`
     * or the `Query.canonical(schema)(query)` string — appended to the
     * document's `self` link (`self`, or `links.self`); throws without one.
     *
     * @since 0.13.0
     */
    readonly query?: string | ReadonlyArray<Pair>
    readonly links?: LinksValue
    /** Disable the full-linkage check (it is on by default). */
    readonly checkLinkage?: boolean
  }
): DocumentValue<ReadonlyArray<R>, Included, M> =>
  build(resources, resources, options) as DocumentValue<ReadonlyArray<R>, Included, M>

// ---------------------------------------------------------------------------
// Relationship linkage & links
// ---------------------------------------------------------------------------

/**
 * The canonical relationship-endpoint URL:
 * `/<type>/<id>/relationships/<name>`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const relationshipLink = (type: string, id: string, name: string): string =>
  `/${type}/${id}/relationships/${name}`

/**
 * The canonical related-resource URL: `/<type>/<id>/<name>`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const relatedLink = (type: string, id: string, name: string): string => `/${type}/${id}/${name}`

/**
 * Builds the relationship object value for a `paginated` relationship: no
 * inline `data`, just the required `related` link (and the relationship
 * endpoint as `self`).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString },
 *   relationships: { articles: Relationship.paginated(() => Article) }
 * })
 *
 * const id = Person.Id.make("9")
 * const attributes = { firstName: "Dan", lastName: "Gebhardt" }
 *
 * Person.make({
 *   id,
 *   attributes,
 *   relationships: {
 *     articles: Handlers.paginatedRelationship("people", id, "articles")
 *     // → { links: { self: "/people/9/relationships/articles",
 *     //              related: "/people/9/articles" } }
 *   }
 * })
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const paginatedRelationship = (
  type: string,
  id: string,
  name: string
): { readonly links: { readonly self: string; readonly related: string } } => ({
  links: {
    self: relationshipLink(type, id, name),
    related: relatedLink(type, id, name)
  }
})

/**
 * The linkage shapes accepted by {@link linkage}: one identifier (to-one),
 * `null` (empty to-one), or an identifier array (to-many).
 *
 * @since 0.1.0
 * @category models
 */
export type LinkageValue = ResourceIdentifierValue | ReadonlyArray<ResourceIdentifierValue> | null

// The builder's return type is conditional on its generics for the same
// reason as `DocumentValue` above.
type LinkageDocumentValue<Data, M extends MetaValue> = Simplify<
  { readonly data: Data; readonly links?: LinksValue } & ([M] extends [never] ? {} : { readonly meta?: M })
>

/**
 * Builds a relationship-linkage document value — what relationship-endpoint
 * handlers (`fetchRelationship` / `updateRelationship` / `addRelationship`)
 * return: `{ data, links?, meta? }` where `data` is resource linkage.
 *
 * @example
 * ```ts
 * import { Effect, Schema } from "effect"
 * import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Person = Resource.make("people", {
 *   attributes: { firstName: Schema.NonEmptyString, lastName: Schema.NonEmptyString }
 * })
 * const Comment = Resource.make("comments", {
 *   attributes: { body: Schema.NonEmptyString },
 *   relationships: { author: Relationship.one(() => Person) }
 * })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String },
 *   relationships: {
 *     author: Relationship.one(() => Person),
 *     comments: Relationship.many(() => Comment)
 *   }
 * })
 *
 * // in a handler — `handlers` comes from HttpApiBuilder.group, `loadArticle` from your data layer
 * const relationshipHandler = (
 *   handlers: {
 *     handle: (
 *       name: string,
 *       handler: (request: { readonly params: { readonly id: string } }) => Effect.Effect<unknown>
 *     ) => void
 *   },
 *   loadArticle: (id: string) => Effect.Effect<typeof Article.Type>
 * ) =>
 *   handlers.handle("commentsRelationship", ({ params }) =>
 *     loadArticle(params.id).pipe(
 *       Effect.map((article) =>
 *         Handlers.linkage(article.relationships?.comments.data ?? null, {
 *           self: Handlers.relationshipLink("articles", article.id, "comments"),
 *           related: Handlers.relatedLink("articles", article.id, "comments")
 *         })
 *       )
 *     )
 *   )
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const linkage = <const Data extends LinkageValue, const M extends MetaValue = never>(
  data: Data,
  options?: {
    readonly meta?: M
    readonly self?: string
    readonly related?: string
    readonly links?: LinksValue
  }
): LinkageDocumentValue<Data, M> => {
  const links: LinksValue | undefined =
    options?.self !== undefined || options?.related !== undefined
      ? {
          ...(options?.self !== undefined ? { self: options.self } : {}),
          ...(options?.related !== undefined ? { related: options.related } : {}),
          ...options?.links
        }
      : options?.links
  return {
    data,
    ...(links !== undefined ? { links } : {}),
    ...(options?.meta !== undefined ? { meta: options.meta } : {})
  } as LinkageDocumentValue<Data, M>
}

// ---------------------------------------------------------------------------
// Pagination links
// ---------------------------------------------------------------------------

/**
 * Options of the pagination link builders.
 *
 * @since 0.13.0
 * @category models
 */
export interface PaginationLinksOptions {
  /**
   * The request's canonical query pairs — `Query.canonicalPairs(listQuery)(query)`
   * — so every link carries the client's `include` / `fields` / `filter` /
   * `sort` alongside its page cursor. The pairs are already in canonical
   * order; each link's `page[*]` pairs take the place of any the list
   * carries.
   */
  readonly query?: ReadonlyArray<Pair>
}

// A link to one page: the cursor's `page[*]` pairs, slotted into the
// request's other canonical pairs when given, serialised canonically.
const withPage = (path: string, page: Record<string, number>, query: ReadonlyArray<Pair> | undefined): string => {
  const cursor: ReadonlyArray<Pair> = Object.entries(page).map(([key, value]) => [`page[${key}]`, String(value)])
  return withQuery(path, serialise(query === undefined ? cursor : withPagePairs(query, cursor)))
}

// The links of an unpageable collection (a non-positive page size, which
// `page[limit]=0` can request): `self` keeps the request's canonical pairs as
// sent, its own `page[*]` included; nothing else can be linked.
const unpageable = (path: string, query: ReadonlyArray<Pair> | undefined): LinksValue => ({
  self: query === undefined ? path : withQuery(path, serialise(query)),
  first: null,
  prev: null,
  next: null,
  last: null
})

/**
 * Builds the spec's pagination links (`self` / `first` / `prev` / `next` /
 * `last`) for offset/limit pagination.
 *
 * Links are serialised canonically (`Query.serialise`). Pass the request's
 * canonical pairs as `query` and every link carries them, each page cursor
 * slotted into the `page[*]` position (replacing the request's own), so
 * `next` / `prev` / `first` / `last` are the same query on another page and
 * `self` carries the **effective page window**: the request's canonical
 * string with the page defaults the server applied filled in. A request
 * without page keys (`?sort=-title`) canonicalises to `sort=-title`, while
 * its `self` is `sort=-title&page[offset]=0&page[limit]=<total>` — the
 * window the document actually covers. When the window is unpageable
 * (`limit <= 0`) `self` is the request's pairs as sent and the other links
 * are `null`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Handlers, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * Handlers.offsetPaginationLinks("/articles", { offset: 0, limit: 10 }, 35)
 * // → { self: "/articles?page[offset]=0&page[limit]=10",
 * //     first: "/articles?page[offset]=0&page[limit]=10",
 * //     prev: null,
 * //     next: "/articles?page[offset]=10&page[limit]=10",
 * //     last: "/articles?page[offset]=30&page[limit]=10" }
 *
 * // …carrying the request's full query
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 * const listQuery = Query.schema(Article, { fields: true, sort: true, page: Query.Page.Offset })
 * const query: typeof listQuery.Type = {
 *   fields: { articles: ["title"] },
 *   sort: [{ field: "title", direction: "desc" }],
 *   page: { offset: 10, limit: 10 }
 * }
 *
 * Handlers.offsetPaginationLinks("/articles", query.page ?? {}, 35, {
 *   query: Query.canonicalPairs(listQuery)(query)
 * })
 * // → { self: "/articles?fields[articles]=title&sort=-title&page[offset]=10&page[limit]=10",
 * //     first: "/articles?fields[articles]=title&sort=-title&page[offset]=0&page[limit]=10",
 * //     prev: "/articles?fields[articles]=title&sort=-title&page[offset]=0&page[limit]=10",
 * //     next: "/articles?fields[articles]=title&sort=-title&page[offset]=20&page[limit]=10",
 * //     last: "/articles?fields[articles]=title&sort=-title&page[offset]=30&page[limit]=10" }
 * ```
 *
 * @see {@link https://jsonapi.org/format/1.1/#fetching-pagination}
 * @since 0.1.0
 * @category constructors
 */
export const offsetPaginationLinks = (
  path: string,
  page: { readonly offset?: number; readonly limit?: number },
  total: number,
  options?: PaginationLinksOptions
): LinksValue => {
  const limit = page.limit ?? total
  const offset = page.offset ?? 0
  const query = options?.query
  if (limit <= 0) return unpageable(path, query)
  const lastOffset = Math.floor(Math.max(total - 1, 0) / limit) * limit
  return {
    self: withPage(path, { offset, limit }, query),
    first: withPage(path, { offset: 0, limit }, query),
    prev: offset > 0 ? withPage(path, { offset: Math.max(offset - limit, 0), limit }, query) : null,
    next: offset + limit < total ? withPage(path, { offset: offset + limit, limit }, query) : null,
    last: withPage(path, { offset: lastOffset, limit }, query)
  }
}

/**
 * Builds the spec's pagination links for page-number/size pagination.
 *
 * Links are serialised canonically (`Query.serialise`); pass the request's
 * canonical pairs as `query` and every link carries them, `self` with the
 * effective page window — see {@link offsetPaginationLinks}.
 *
 * @example
 * ```ts
 * import { Handlers } from "@thomasfosterau/effect-jsonapi"
 *
 * Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35)
 * // → { self: "/articles?page[number]=2&page[size]=10",
 * //     first: "/articles?page[number]=1&page[size]=10",
 * //     prev: "/articles?page[number]=1&page[size]=10",
 * //     next: "/articles?page[number]=3&page[size]=10",
 * //     last: "/articles?page[number]=4&page[size]=10" }
 *
 * // …carrying the request's other canonical pairs
 * Handlers.numberPaginationLinks("/articles", { number: 2, size: 10 }, 35, { query: [["sort", "-title"]] })
 * // → { self: "/articles?sort=-title&page[number]=2&page[size]=10", … }
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const numberPaginationLinks = (
  path: string,
  page: { readonly number?: number; readonly size?: number },
  total: number,
  options?: PaginationLinksOptions
): LinksValue => {
  const size = page.size ?? total
  const number = page.number ?? 1
  const query = options?.query
  if (size <= 0) return unpageable(path, query)
  const lastPage = Math.max(Math.ceil(total / size), 1)
  return {
    self: withPage(path, { number, size }, query),
    first: withPage(path, { number: 1, size }, query),
    prev: number > 1 ? withPage(path, { number: number - 1, size }, query) : null,
    next: number < lastPage ? withPage(path, { number: number + 1, size }, query) : null,
    last: withPage(path, { number: lastPage, size }, query)
  }
}
