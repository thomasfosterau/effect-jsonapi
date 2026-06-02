/**
 * The blog's handlers: a vanilla `HttpApiBuilder.group` implementation backed
 * by an in-memory store, using the JSON:API document builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.sort` / `query.page` / `query.filter` are typed
 *   - `payload.data.attributes` is the typed create/update payload
 *   - relationship endpoints receive typed linkage payloads
 *
 * and return document values (`JsonApi.data` / `JsonApi.collection` /
 * `JsonApi.linkage`), which are validated against the endpoint's document
 * schema on the way out.
 */
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
import { Api } from "./api.js"
import { ArticleNotFound, TitleTaken } from "./errors.js"
import { Article, Comment, Person, Tag } from "./resources.js"

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const sampleAuthor: Person = Person.make({
  id: Person.Id.make("9"),
  attributes: { firstName: "Dan", lastName: "Gebhardt", twitter: "dgeb" }
})

export const sampleTag: Tag = Tag.make({
  id: Tag.Id.make("1"),
  attributes: { name: "api-design" }
})

export const sampleComments: ReadonlyArray<Comment> = [
  Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First!" },
    relationships: {
      author: { data: Person.ref(sampleAuthor.id) }
    }
  }),
  Comment.make({
    id: Comment.Id.make("12"),
    attributes: { body: "I like XML better" },
    relationships: {
      author: { data: Person.ref(sampleAuthor.id) }
    }
  })
]

export const sampleArticle: Article = Article.make({
  id: Article.Id.make("1"),
  attributes: {
    title: "JSON:API paints my bikeshed!",
    body: "The shortest article. Ever.",
    createdAt: new Date("2024-01-01T00:00:00.000Z")
  },
  relationships: {
    // `one`: inline identifier, never null
    author: { data: Person.ref(sampleAuthor.id) },
    // `many`: inline identifier array
    tags: { data: [Tag.ref(sampleTag.id)] },
    // `paginated`: no inline data — just the links clients follow
    comments: JsonApi.paginatedRelationship("articles", "1", "comments")
  }
})

const store = {
  articles: new Map<string, Article>([[sampleArticle.id, sampleArticle]]),
  people: new Map<string, Person>([[sampleAuthor.id, sampleAuthor]]),
  tags: new Map<string, Tag>([[sampleTag.id, sampleTag]]),
  comments: new Map<string, Comment>(sampleComments.map((comment) => [comment.id, comment])),
  // The paginated comments relationship is backed by its own index, not by
  // inline linkage on the article.
  articleComments: new Map<string, Array<string>>([[sampleArticle.id, sampleComments.map((c) => c.id)]])
}

const loadArticle = (id: string): Effect.Effect<Article, ArticleNotFound> => {
  const article = store.articles.get(id)
  return article === undefined ? Effect.fail(new ArticleNotFound({ id })) : Effect.succeed(article)
}

// Resolve the resources referenced by the requested include paths.
// Only `one` / `optional` / `many` relationships are includable; the paginated
// `comments` relationship never appears here.
const resolveIncluded = (article: Article, include: ReadonlyArray<string> | undefined) => {
  const included: Array<Person | Tag> = []
  if (include?.includes("author")) {
    const author = article.relationships?.author.data
    if (author !== undefined && store.people.has(author.id)) included.push(store.people.get(author.id)!)
  }
  if (include?.includes("tags")) {
    for (const identifier of article.relationships?.tags.data ?? []) {
      const tag = store.tags.get(identifier.id)
      if (tag !== undefined) included.push(tag)
    }
  }
  return included
}

// The comments attached to an article, via the relationship index.
const articleComments = (articleId: string): Array<Comment> =>
  (store.articleComments.get(articleId) ?? [])
    .flatMap((commentId) => {
      const comment = store.comments.get(commentId)
      return comment === undefined ? [] : [comment]
    })

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("fetch", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) =>
          JsonApi.data(article, {
            included: resolveIncluded(article, query.include),
            self: `/articles/${article.id}`
          })
        )
      ))
    .handle("list", ({ query }) => {
      let articles = [...store.articles.values()]

      // filter[author]=<person id>
      const author = query.filter?.author
      if (author !== undefined) {
        articles = articles.filter((article) => article.relationships?.author.data.id === author)
      }

      // sort=-createdAt,title
      for (const term of [...(query.sort ?? [])].reverse()) {
        const direction = term.direction === "desc" ? -1 : 1
        articles.sort((a, b) => {
          const left = a.attributes[term.field]
          const right = b.attributes[term.field]
          return (left < right ? -1 : left > right ? 1 : 0) * direction
        })
      }

      // page[offset]=0&page[limit]=10
      const total = articles.length
      const offset = query.page?.offset ?? 0
      const limit = query.page?.limit ?? total
      const page = articles.slice(offset, offset + limit)

      return Effect.succeed(
        JsonApi.collection(page, {
          included: page.flatMap((article) => resolveIncluded(article, query.include)),
          meta: { total },
          links: JsonApi.offsetPaginationLinks("/articles", { offset, limit }, total)
        })
      )
    })
    .handle("create", ({ payload }) => {
      const title = payload.data.attributes.title
      for (const existing of store.articles.values()) {
        if (existing.attributes.title === title) {
          return Effect.fail(new TitleTaken({ title }))
        }
      }
      const id = Article.Id.make(`${store.articles.size + 1}`)
      const article = Article.make({
        id,
        attributes: payload.data.attributes,
        relationships: {
          // `author` is a required relationship — the payload always carries it.
          author: payload.data.relationships.author,
          tags: payload.data.relationships.tags ?? { data: [] },
          // `comments` can't be supplied at create time; new articles start
          // with an empty, paginated comment collection.
          comments: JsonApi.paginatedRelationship("articles", id, "comments")
        }
      })
      store.articles.set(article.id, article)
      store.articleComments.set(article.id, [])
      return Effect.succeed(JsonApi.data(article, { self: `/articles/${article.id}` }))
    })
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const relationships = article.relationships!
          const updated = Article.make({
            ...article,
            attributes: { ...article.attributes, ...(payload.data.attributes ?? {}) },
            relationships: {
              author: payload.data.relationships?.author ?? relationships.author,
              tags: payload.data.relationships?.tags ?? relationships.tags,
              comments: relationships.comments
            }
          })
          store.articles.set(updated.id, updated)
          return JsonApi.data(updated, { self: `/articles/${updated.id}` })
        })
      ))
    .handle("remove", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          store.articles.delete(article.id)
          store.articleComments.delete(article.id)
        })
      ))
    // --- Related resource endpoints -----------------------------------------
    .handle("author", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const author = store.people.get(article.relationships!.author.data.id) ?? null
          return JsonApi.data(author, {
            self: JsonApi.relatedLink("articles", article.id, "author")
          })
        })
      ))
    .handle("comments", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const all = articleComments(article.id)
          const total = all.length
          const offset = query.page?.offset ?? 0
          const limit = query.page?.limit ?? total
          const page = all.slice(offset, offset + limit)
          const path = JsonApi.relatedLink("articles", article.id, "comments")
          return JsonApi.collection(page, {
            included: query.include?.includes("author")
              ? page.flatMap((comment) => {
                const author = store.people.get(comment.relationships!.author.data.id)
                return author === undefined ? [] : [author]
              })
              : [],
            meta: { total },
            links: JsonApi.offsetPaginationLinks(path, { offset, limit }, total)
          })
        })
      ))
    // --- Relationship (linkage) endpoints ------------------------------------
    .handle("commentsRelationship", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const all = articleComments(article.id).map((comment) => Comment.ref(comment.id))
          const total = all.length
          const offset = query.page?.offset ?? 0
          const limit = query.page?.limit ?? total
          return JsonApi.linkage(all.slice(offset, offset + limit), {
            self: JsonApi.relationshipLink("articles", article.id, "comments"),
            related: JsonApi.relatedLink("articles", article.id, "comments"),
            meta: { total }
          })
        })
      ))
    .handle("updateAuthorRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const updated = Article.make({
            ...article,
            relationships: { ...article.relationships!, author: { data: payload.data } }
          })
          store.articles.set(updated.id, updated)
          return JsonApi.linkage(payload.data, {
            self: JsonApi.relationshipLink("articles", article.id, "author"),
            related: JsonApi.relatedLink("articles", article.id, "author")
          })
        })
      ))
    .handle("addCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const linked = store.articleComments.get(article.id) ?? []
          for (const identifier of payload.data) {
            if (!linked.includes(identifier.id)) linked.push(identifier.id)
          }
          store.articleComments.set(article.id, linked)
          return JsonApi.linkage(linked.map((id) => Comment.ref(id)), {
            self: JsonApi.relationshipLink("articles", article.id, "comments"),
            related: JsonApi.relatedLink("articles", article.id, "comments")
          })
        })
      ))
    .handle("removeCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const remove = new Set<string>(payload.data.map((identifier) => identifier.id))
          store.articleComments.set(
            article.id,
            (store.articleComments.get(article.id) ?? []).filter((id) => !remove.has(id))
          )
        })
      ))
)

// ---------------------------------------------------------------------------
// Search handlers — a heterogeneous collection of articles and people
// ---------------------------------------------------------------------------

const matches = (haystack: ReadonlyArray<string>, needle: string): boolean =>
  haystack.some((value) => value.toLowerCase().includes(needle.toLowerCase()))

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => {
    // no filter[q] → match everything
    const q = query.filter?.q ?? ""

    // search across both resource types; results stay discriminated by `type`
    const articles = [...store.articles.values()].filter((article) =>
      matches([article.attributes.title, article.attributes.body], q)
    )
    const people = [...store.people.values()].filter((person) =>
      matches([person.attributes.firstName, person.attributes.lastName], q)
    )
    const results = [...articles, ...people]

    const total = results.length
    const offset = query.page?.offset ?? 0
    const limit = query.page?.limit ?? total
    const page = results.slice(offset, offset + limit)

    return Effect.succeed(
      JsonApi.collection(page, {
        included: query.include === undefined
          ? []
          : page.flatMap((result) => result.type === "articles" ? resolveIncluded(result, query.include) : []),
        meta: { total },
        links: JsonApi.offsetPaginationLinks("/search", { offset, limit }, total)
      })
    )
  })
)

/**
 * Everything needed to serve the blog: the handlers plus the JSON:API
 * protocol middleware (content negotiation + spec-compliant 400s).
 *
 * The middleware is provided *into* the handler groups (not merged alongside
 * them) so that every endpoint's middleware requirement is satisfied.
 */
export const BlogLive = Layer.mergeAll(ArticlesLive, SearchLive).pipe(
  Layer.provideMerge(JsonApi.Middleware.layer)
)
