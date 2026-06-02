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
import { Effect, Layer, Match } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
import { Api } from "./api.js"
import { ArticleNotFound, OperationFailed, TitleTaken } from "./errors.js"
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

// ---------------------------------------------------------------------------
// Atomic operations handlers — all-or-nothing processing with lid support
// ---------------------------------------------------------------------------

/** The operation union the operations endpoint accepts. */
type AtomicOperation = JsonApi.Atomic.Operation<typeof Article | typeof Comment>["Type"]

/** One result entry per operation; removals and relationship updates return no data. */
type ResultEntry = { readonly data?: Article | Comment | null }

/**
 * A draft of the store: operations apply here, and the draft is committed only
 * if every operation succeeds — all-or-nothing, per the extension.
 */
interface Draft {
  readonly articles: Map<string, Article>
  readonly comments: Map<string, Comment>
}

let atomicIdCounter = 0
const freshId = (): string => `atomic-${++atomicIdCounter}`

const emptyArticleRelationships: NonNullable<Article["relationships"]> = {
  author: { data: null },
  comments: { data: [] }
}

/**
 * The id a ref (or update `data`) targets, resolving lids assigned by earlier
 * operations in the same request.
 */
const targetId = (
  lids: JsonApi.LidMap,
  target: { readonly id?: string; readonly lid?: string }
): string => {
  if (target.id !== undefined) return target.id
  if (target.lid !== undefined) {
    const id = lids.id(target.lid)
    if (id !== undefined) return id
    throw new JsonApi.UnknownLidError(target.lid)
  }
  throw new Error("operation does not identify a target resource")
}

const getArticle = (
  draft: Draft,
  lids: JsonApi.LidMap,
  target: { readonly id?: string; readonly lid?: string }
): Article => {
  const id = targetId(lids, target)
  const article = draft.articles.get(id)
  if (article === undefined) throw new Error(`article "${id}" not found`)
  return article
}

const getComment = (
  draft: Draft,
  lids: JsonApi.LidMap,
  target: { readonly id?: string; readonly lid?: string }
): Comment => {
  const id = targetId(lids, target)
  const comment = draft.comments.get(id)
  if (comment === undefined) throw new Error(`comment "${id}" not found`)
  return comment
}

/**
 * Applies one operation to the draft, returning its result entry.
 *
 * Pattern-matches over the operation union with Effect's `Match` module: the
 * curried `Atomic.targetsRelationship` / `Atomic.targetsResource` guards
 * narrow each case to fully typed `data` / `ref`.
 *
 * Failures throw; the handler converts them into typed `OperationFailed`
 * errors carrying the index of the operation that failed.
 */
const applyOperation = (
  draft: Draft,
  lids: JsonApi.LidMap,
  operation: AtomicOperation
): ResultEntry =>
  Match.value(operation).pipe(
    // --- relationship operations (refs carrying a `relationship` member) ----
    // replace an article's author (to-one)
    Match.when(JsonApi.Atomic.targetsRelationship(Article, "author"), (op) => {
      const article = getArticle(draft, lids, op.ref)
      draft.articles.set(
        article.id,
        Article.make({
          ...article,
          relationships: {
            ...(article.relationships ?? emptyArticleRelationships),
            author: { data: op.data === null ? null : lids.identifier(Person, op.data) }
          }
        })
      )
      return JsonApi.Atomic.emptyResult
    }),
    // add to / replace / remove from an article's comments (to-many)
    Match.when(JsonApi.Atomic.targetsRelationship(Article, "comments"), (op) => {
      const article = getArticle(draft, lids, op.ref)
      const refs = op.data.map((ref) => lids.identifier(Comment, ref))
      const current = article.relationships?.comments.data ?? []
      const next = op.op === "add"
        ? [...current, ...refs]
        : op.op === "remove"
        ? current.filter((existing) => !refs.some((removed) => removed.id === existing.id))
        : refs
      draft.articles.set(
        article.id,
        Article.make({
          ...article,
          relationships: {
            ...(article.relationships ?? emptyArticleRelationships),
            comments: { data: next }
          }
        })
      )
      return JsonApi.Atomic.emptyResult
    }),
    // replace a comment's author (to-one)
    Match.when(JsonApi.Atomic.targetsRelationship(Comment, "author"), (op) => {
      const comment = getComment(draft, lids, op.ref)
      draft.comments.set(
        comment.id,
        Comment.make({
          ...comment,
          relationships: {
            author: { data: op.data === null ? null : lids.identifier(Person, op.data) }
          }
        })
      )
      return JsonApi.Atomic.emptyResult
    }),
    // --- resource operations -------------------------------------------------
    Match.when(JsonApi.Atomic.targetsResource(Article), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const article = Article.make({
            id: Article.Id.make(freshId()),
            attributes: add.data.attributes,
            relationships: {
              ...emptyArticleRelationships,
              ...lids.resolveLinkage(Article, add.data.relationships)
            }
          })
          draft.articles.set(article.id, article)
          if (add.data.lid !== undefined) lids.assign(add.data.lid, article.id)
          return { data: article }
        }),
        Match.when({ op: "update" }, (update) => {
          const article = getArticle(draft, lids, update.ref ?? update.data)
          const updated = Article.make({
            ...article,
            attributes: { ...article.attributes, ...(update.data.attributes ?? {}) },
            relationships: {
              ...(article.relationships ?? emptyArticleRelationships),
              ...lids.resolveLinkage(Article, update.data.relationships)
            }
          })
          draft.articles.set(updated.id, updated)
          return { data: updated }
        }),
        Match.when({ op: "remove" }, (remove) => {
          const article = getArticle(draft, lids, remove.ref)
          draft.articles.delete(article.id)
          return JsonApi.Atomic.emptyResult
        }),
        Match.exhaustive
      )),
    Match.when(JsonApi.Atomic.targetsResource(Comment), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const comment = Comment.make({
            id: Comment.Id.make(freshId()),
            attributes: add.data.attributes,
            relationships: {
              author: { data: null },
              ...lids.resolveLinkage(Comment, add.data.relationships)
            }
          })
          draft.comments.set(comment.id, comment)
          if (add.data.lid !== undefined) lids.assign(add.data.lid, comment.id)
          return { data: comment }
        }),
        Match.when({ op: "update" }, (update) => {
          const comment = getComment(draft, lids, update.ref ?? update.data)
          const updated = Comment.make({
            ...comment,
            attributes: { ...comment.attributes, ...(update.data.attributes ?? {}) },
            relationships: {
              ...(comment.relationships ?? { author: { data: null } }),
              ...lids.resolveLinkage(Comment, update.data.relationships)
            }
          })
          draft.comments.set(updated.id, updated)
          return { data: updated }
        }),
        Match.when({ op: "remove" }, (remove) => {
          const comment = getComment(draft, lids, remove.ref)
          draft.comments.delete(comment.id)
          return JsonApi.Atomic.emptyResult
        }),
        Match.exhaustive
      )),
    Match.exhaustive
  )

export const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.gen(function*() {
      const draft: Draft = {
        articles: new Map(store.articles),
        comments: new Map(store.comments)
      }
      const lids = JsonApi.lidMap()
      const entries: Array<ResultEntry> = []

      const operations = payload["atomic:operations"]
      for (let index = 0; index < operations.length; index++) {
        const entry = yield* Effect.try({
          try: () => applyOperation(draft, lids, operations[index]!),
          catch: (error) =>
            new OperationFailed({
              operation: index,
              reason: error instanceof Error ? error.message : String(error)
            })
        })
        entries.push(entry)
      }

      // every operation succeeded — commit the draft
      store.articles = draft.articles
      store.comments = draft.comments
      return JsonApi.Atomic.results(entries)
    })))

/**
 * Everything needed to serve the blog: the handlers plus the JSON:API
 * protocol middleware (content negotiation + spec-compliant 400s).
 *
 * The api supports the atomic operations extension, so the middleware is
 * configured to accept its media type
 * (`application/vnd.api+json;ext="https://jsonapi.org/ext/atomic"`).
 *
 * The middleware is provided *into* the handler groups (not merged alongside
 * them) so that every endpoint's middleware requirement is satisfied.
 */
export const BlogLive = Layer.mergeAll(ArticlesLive, SearchLive, OperationsLive).pipe(
  Layer.provideMerge(JsonApi.Middleware.layerWith({ extensions: [JsonApi.Atomic.EXTENSION_URI] }))
)
