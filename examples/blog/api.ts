/**
 * The blog's HTTP API: JSON:API endpoints with conventional paths, typed
 * query parameters and JSON:API error documents — composed into a vanilla
 * `HttpApi`.
 */
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
import { ArticleNotFound, TitleTaken } from "./errors.js"
import { Article, Person } from "./resources.js"

/**
 * Typed collection meta carried by list responses.
 */
export const PageMeta = Schema.Struct({
  total: Schema.Int
})

export const articles = JsonApi.Group(
  Article,
  // GET /articles/:id?include=author,comments&fields[articles]=title
  JsonApi.Endpoint.fetch(Article, {
    include: true,
    fields: true,
    errors: [ArticleNotFound]
  }),
  // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
  JsonApi.Endpoint.list(Article, {
    include: true,
    sort: ["createdAt", "title"],
    page: JsonApi.Page.Offset,
    filter: { author: Schema.optionalKey(Schema.String) },
    meta: PageMeta
  }),
  // POST /articles (payload may carry a client-generated lid)
  JsonApi.Endpoint.create(Article, {
    errors: [TitleTaken]
  }),
  // PATCH /articles/:id (partial attributes)
  JsonApi.Endpoint.update(Article, {
    errors: [ArticleNotFound]
  }),
  // DELETE /articles/:id → 204
  JsonApi.Endpoint.remove(Article, {
    errors: [ArticleNotFound]
  })
)

/**
 * A heterogeneous search endpoint: results are a mixed collection of articles
 * and people, discriminated by their `type` tags.
 */
export const search = JsonApi.Group(
  "search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  JsonApi.Endpoint.search([Article, Person], {
    filter: { q: Schema.String },
    include: true,
    fields: true,
    page: JsonApi.Page.Offset,
    meta: PageMeta
  })
)

export const Api = HttpApi.make("blog").add(articles).add(search)
