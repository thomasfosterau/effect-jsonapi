/**
 * The blog's HTTP API: JSON:API endpoints with conventional paths, typed
 * query parameters and JSON:API error documents — composed into a vanilla
 * `HttpApi`.
 */
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { Endpoint, Group, Query } from "@thomasfosterau/effect-jsonapi"
import { ArticleNotFound, OperationFailed, TitleTaken } from "./errors.js"
import { Article, Comment, Person } from "./resources.js"

/**
 * Typed collection meta carried by list responses.
 */
export const PageMeta = Schema.Struct({
  total: Schema.Int
})

export const articles = Group.make(
  Article,
  // GET /articles/:id?include=author,tags&fields[articles]=title
  Endpoint.fetch(Article, {
    include: true,
    fields: true,
    errors: [ArticleNotFound]
  }),
  // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
  Endpoint.list(Article, {
    include: true,
    sort: ["createdAt", "title"],
    page: Query.Page.Offset,
    filter: { author: Schema.optionalKey(Schema.String) },
    meta: PageMeta
  }),
  // POST /articles (payload may carry a client-generated lid; author is required)
  Endpoint.create(Article, {
    errors: [TitleTaken]
  }),
  // PATCH /articles/:id (partial attributes)
  Endpoint.update(Article, {
    errors: [ArticleNotFound]
  }),
  // DELETE /articles/:id → 204
  Endpoint.remove(Article, {
    errors: [ArticleNotFound]
  }),
  // --- Related resource endpoints --------------------------------------------
  // GET /articles/:id/author — the article's author, as a full resource
  Endpoint.related(Article, "author", {
    errors: [ArticleNotFound]
  }),
  // GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author —
  // the paginated comment collection that `relationships.comments.links.related`
  // points at
  Endpoint.related(Article, "comments", {
    include: true,
    page: Query.Page.Offset,
    meta: PageMeta,
    errors: [ArticleNotFound]
  }),
  // --- Relationship (linkage) endpoints ---------------------------------------
  // GET /articles/:id/relationships/comments — comment identifiers, paginated
  Endpoint.fetchRelationship(Article, "comments", {
    page: Query.Page.Offset,
    errors: [ArticleNotFound]
  }),
  // PATCH /articles/:id/relationships/author — replace the author (never null: `one`)
  Endpoint.updateRelationship(Article, "author", {
    errors: [ArticleNotFound]
  }),
  // POST /articles/:id/relationships/comments — attach existing comments
  Endpoint.addRelationship(Article, "comments", {
    errors: [ArticleNotFound]
  }),
  // DELETE /articles/:id/relationships/comments — detach comments → 204
  Endpoint.removeRelationship(Article, "comments", {
    errors: [ArticleNotFound]
  })
)

/**
 * A heterogeneous search endpoint: results are a mixed collection of articles
 * and people, discriminated by their `type` tags.
 */
export const search = Group.make(
  "search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  Endpoint.search([Article, Person], {
    filter: { q: Schema.String },
    include: true,
    fields: true,
    page: Query.Page.Offset,
    meta: PageMeta
  })
)

/**
 * An atomic operations endpoint (https://jsonapi.org/ext/atomic/): one request
 * carrying an ordered list of operations on articles and comments — including
 * lid-based references between them — processed all-or-nothing.
 */
export const operations = Group.make(
  "operations",
  // POST /operations with an atomic:operations document
  Endpoint.operations([Article, Comment], {
    errors: [OperationFailed]
  })
)

export const Api = HttpApi.make("blog").add(articles).add(search).add(operations)
