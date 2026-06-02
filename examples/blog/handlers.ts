/**
 * The blog's handlers: a vanilla `HttpApiBuilder.group` implementation backed
 * by an in-memory store, using the JSON:API document builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.sort` / `query.page` / `query.filter` are typed
 *   - `payload.data.attributes` is the typed create/update payload
 *
 * and return document values (`JsonApi.data` / `JsonApi.collection`), which
 * are validated against the endpoint's document schema on the way out.
 */
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
import { Api } from "./api.js"
import { ArticleNotFound, TitleTaken } from "./errors.js"
import { Article, Comment, Person } from "./resources.js"

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const sampleAuthor: Person = Person.make({
  id: Person.Id.make("9"),
  attributes: { firstName: "Dan", lastName: "Gebhardt", twitter: "dgeb" }
})

export const sampleComment: Comment = Comment.make({
  id: Comment.Id.make("5"),
  attributes: { body: "First!" },
  relationships: {
    author: { data: { type: "people", id: sampleAuthor.id } }
  }
})

export const sampleArticle: Article = Article.make({
  id: Article.Id.make("1"),
  attributes: {
    title: "JSON:API paints my bikeshed!",
    body: "The shortest article. Ever.",
    createdAt: new Date("2024-01-01T00:00:00.000Z")
  },
  relationships: {
    author: { data: { type: "people", id: sampleAuthor.id } },
    comments: { data: [{ type: "comments", id: sampleComment.id }] }
  }
})

const store = {
  articles: new Map<string, Article>([[sampleArticle.id, sampleArticle]]),
  people: new Map<string, Person>([[sampleAuthor.id, sampleAuthor]]),
  comments: new Map<string, Comment>([[sampleComment.id, sampleComment]])
}

const loadArticle = (id: string): Effect.Effect<Article, ArticleNotFound> => {
  const article = store.articles.get(id)
  return article === undefined ? Effect.fail(new ArticleNotFound({ id })) : Effect.succeed(article)
}

// Resolve the resources referenced by the requested include paths.
const resolveIncluded = (article: Article, include: ReadonlyArray<string> | undefined) => {
  const included: Array<Person | Comment> = []
  if (include?.some((path) => path === "author")) {
    const author = article.relationships?.author.data
    if (author != null && store.people.has(author.id)) included.push(store.people.get(author.id)!)
  }
  if (include?.some((path) => path === "comments" || path === "comments.author")) {
    for (const identifier of article.relationships?.comments.data ?? []) {
      const comment = store.comments.get(identifier.id)
      if (comment === undefined) continue
      included.push(comment)
      if (include.includes("comments.author")) {
        const author = comment.relationships?.author.data
        if (author != null && store.people.has(author.id)) included.push(store.people.get(author.id)!)
      }
    }
  }
  return included
}

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
        articles = articles.filter((article) => article.relationships?.author.data?.id === author)
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
      const article = Article.make({
        id: Article.Id.make(`${store.articles.size + 1}`),
        attributes: payload.data.attributes,
        relationships: payload.data.relationships ?? {
          author: { data: null },
          comments: { data: [] }
        }
      })
      store.articles.set(article.id, article)
      return Effect.succeed(JsonApi.data(article, { self: `/articles/${article.id}` }))
    })
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const updated = Article.make({
            ...article,
            attributes: { ...article.attributes, ...(payload.data.attributes ?? {}) },
            relationships: payload.data.relationships ?? article.relationships ?? {
              author: { data: null },
              comments: { data: [] }
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
 */
export const BlogLive = Layer.mergeAll(ArticlesLive, SearchLive, JsonApi.Middleware.layer)
