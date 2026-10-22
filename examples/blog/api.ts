/**
 * The blog's HTTP API: JSON:API endpoints with conventional paths, typed
 * query parameters and JSON:API error documents — composed into a vanilla
 * `HttpApi`.
 */
import { Schema } from "effect";
import { HttpApi } from "effect/http-api";
import { Endpoint, Group, Query } from "@thomasfosterau/effect-jsonapi";
import {
  ArticleNotFound,
  CommentNotFound,
  OperationFailed,
  PersonNotFound,
  TagNotFound,
  TitleTaken,
} from "./errors.js";
import { Article, Comment, Person } from "./resources.js";

/**
 * Typed collection meta carried by list responses.
 */
export const PageMeta = Schema.Struct({
  total: Schema.Int,
});

/**
 * The decoded type of the typed collection {@link PageMeta}.
 */
export type PageMeta = typeof PageMeta.Type;

/**
 * Offset/limit pagination capped at 100 rows — a shared DoS guard.
 *
 * `Query.Page.offset(...)` is the bounded, configurable variant of the
 * `Query.Page.Offset` constant; defining it once and reusing it keeps the cap
 * (and the `page[offset]` / `page[limit]` keys) consistent across every
 * paginated endpoint, so the input and the emitted pagination links can't drift.
 */
export const Pagination = Query.Page.offset({ maxLimit: 100 });

// ---------------------------------------------------------------------------
// Paginated query schemas
// ---------------------------------------------------------------------------
//
// Each paginated endpoint's query schema is built once, here, and shared with
// its handler, which spells the pagination links from it:
// `Handlers.offsetPaginationLinks(path, page, total, { query:
// Query.canonicalPairs(ArticlesQuery)(query) })`. A link's query and the query
// the endpoint decodes then come from one schema, so `next` is the same
// `sort` / `filter` / `include` / `fields` on the next page. A list endpoint
// takes the schema as its `query`; the related and search endpoints take no
// `query` override, so they are handed the same options object the schema is
// built from and derive the identical schema.

const articlesQueryOptions = {
  include: true,
  sort: ["createdAt", "title"],
  page: Pagination,
  filter: { author: Schema.optionalKey(Schema.String) },
} as const;
/** The query `GET /articles` decodes. */
export const ArticlesQuery = Query.schema(Article, articlesQueryOptions);

const articleCommentsQueryOptions = { include: true, page: Pagination } as const;
/** The query `GET /articles/:id/comments` decodes. */
export const ArticleCommentsQuery = Query.schema(Comment, articleCommentsQueryOptions);

const searchResources = [Article, Person] as const;
const searchQueryOptions = {
  filter: { q: Schema.String },
  include: true,
  fields: true,
  page: Pagination,
} as const;
/** The query `GET /search` decodes. */
export const SearchQuery = Query.schema(searchResources, searchQueryOptions);

export const articles = Group.make(
  Article,
  // GET /articles/:id?include=author,tags&fields[articles]=title
  Endpoint.get(Article, {
    include: true,
    fields: true,
    errors: [ArticleNotFound],
  }),
  // GET /articles?sort=-createdAt&page[offset]=0&page[limit]=10&filter[author]=9
  Endpoint.list(Article, {
    ...articlesQueryOptions,
    query: ArticlesQuery,
    meta: PageMeta,
  }),
  // POST /articles (payload may carry a client-generated lid; author is required)
  Endpoint.create(Article, {
    errors: [TitleTaken],
  }),
  // PATCH /articles/:id (partial attributes)
  Endpoint.update(Article, {
    errors: [ArticleNotFound],
  }),
  // DELETE /articles/:id → 204
  Endpoint.delete(Article, {
    errors: [ArticleNotFound],
  }),
  // --- Related resource endpoints --------------------------------------------
  // GET /articles/:id/author — the article's author, as a full resource
  Endpoint.related(Article, "author", {
    errors: [ArticleNotFound],
  }),
  // GET /articles/:id/comments?page[offset]=0&page[limit]=10&include=author —
  // the paginated comment collection that `relationships.comments.links.related`
  // points at
  Endpoint.related(Article, "comments", {
    ...articleCommentsQueryOptions,
    meta: PageMeta,
    errors: [ArticleNotFound],
  }),
  // --- Relationship (linkage) endpoints ---------------------------------------
  // GET /articles/:id/relationships/comments — comment identifiers, paginated
  Endpoint.getRelationship(Article, "comments", {
    page: Pagination,
    errors: [ArticleNotFound],
  }),
  // GET /articles/:id/relationships/tags?include=tags — a compound relationship
  // document: the tag identifiers as `data`, the tags themselves in `included`.
  // Include paths are the article's, rooted at `tags`; the paginated
  // `comments` relationship is never an include path, so it has none.
  Endpoint.getRelationship(Article, "tags", {
    include: true,
    errors: [ArticleNotFound],
  }),
  // PATCH /articles/:id/relationships/author — replace the author (never null: `one`)
  Endpoint.updateRelationship(Article, "author", {
    errors: [ArticleNotFound, PersonNotFound],
  }),
  // POST /articles/:id/relationships/comments — attach existing comments
  Endpoint.addRelationship(Article, "comments", {
    errors: [ArticleNotFound, CommentNotFound],
  }),
  // DELETE /articles/:id/relationships/comments — detach comments → 204
  Endpoint.removeRelationship(Article, "comments", {
    errors: [ArticleNotFound],
  }),
);

/**
 * A heterogeneous search endpoint: results are a mixed collection of articles
 * and people, discriminated by their `type` tags.
 */
export const search = Group.make(
  "search",
  // GET /search?filter[q]=bikeshed&include=author&page[offset]=0&page[limit]=10
  Endpoint.collection(searchResources, {
    ...searchQueryOptions,
    name: "search",
    path: "/search",
    meta: PageMeta,
  }),
);

/**
 * An atomic operations endpoint (https://jsonapi.org/ext/atomic/): one request
 * carrying an ordered list of operations on articles and comments — including
 * lid-based references between them — processed all-or-nothing.
 */
export const operations = Group.make(
  "operations",
  // POST /operations with an atomic:operations document
  Endpoint.operations([Article, Comment], {
    errors: [OperationFailed, PersonNotFound, CommentNotFound, TagNotFound],
  }),
);

export const Api = HttpApi.make("blog").add(articles).add(search).add(operations);
