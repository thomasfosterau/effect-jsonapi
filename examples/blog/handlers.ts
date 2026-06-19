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
 * and return document values (`Handlers.data` / `Handlers.collection` /
 * `Handlers.linkage`), which are validated against the endpoint's document
 * schema on the way out.
 */
import { Effect, Layer, Match } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Atomic, Handlers, Lid, Middleware } from "@thomasfosterau/effect-jsonapi"
import { Api } from "./api.js"
import { ArticleNotFound, OperationFailed, TitleTaken } from "./errors.js"
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
    comments: Handlers.paginatedRelationship("articles", "1", "comments")
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
  (store.articleComments.get(articleId) ?? []).flatMap((commentId) => {
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
          Handlers.data(article, {
            included: resolveIncluded(article, query.include),
            self: `/articles/${article.id}`
          })
        )
      )
    )
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
        Handlers.collection(page, {
          included: page.flatMap((article) => resolveIncluded(article, query.include)),
          meta: { total },
          links: Handlers.offsetPaginationLinks("/articles", { offset, limit }, total)
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
          comments: Handlers.paginatedRelationship("articles", id, "comments")
        }
      })
      store.articles.set(article.id, article)
      store.articleComments.set(article.id, [])
      return Effect.succeed(Handlers.data(article, { self: `/articles/${article.id}` }))
    })
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const relationships = article.relationships!
          const updated = Article.make({
            ...article,
            attributes: { ...article.attributes, ...payload.data.attributes },
            relationships: {
              author: payload.data.relationships?.author ?? relationships.author,
              tags: payload.data.relationships?.tags ?? relationships.tags,
              comments: relationships.comments
            }
          })
          store.articles.set(updated.id, updated)
          return Handlers.data(updated, { self: `/articles/${updated.id}` })
        })
      )
    )
    .handle("remove", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          store.articles.delete(article.id)
          store.articleComments.delete(article.id)
        })
      )
    )
    // --- Related resource endpoints -----------------------------------------
    .handle("author", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const author = store.people.get(article.relationships!.author.data.id) ?? null
          return Handlers.data(author, {
            self: Handlers.relatedLink("articles", article.id, "author")
          })
        })
      )
    )
    .handle("comments", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const all = articleComments(article.id)
          const total = all.length
          const offset = query.page?.offset ?? 0
          const limit = query.page?.limit ?? total
          const page = all.slice(offset, offset + limit)
          const path = Handlers.relatedLink("articles", article.id, "comments")
          return Handlers.collection(page, {
            included: query.include?.includes("author")
              ? page.flatMap((comment) => {
                  const author = store.people.get(comment.relationships!.author.data.id)
                  return author === undefined ? [] : [author]
                })
              : [],
            meta: { total },
            links: Handlers.offsetPaginationLinks(path, { offset, limit }, total)
          })
        })
      )
    )
    // --- Relationship (linkage) endpoints ------------------------------------
    .handle("commentsRelationship", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const all = articleComments(article.id).map((comment) => Comment.ref(comment.id))
          const total = all.length
          const offset = query.page?.offset ?? 0
          const limit = query.page?.limit ?? total
          return Handlers.linkage(all.slice(offset, offset + limit), {
            self: Handlers.relationshipLink("articles", article.id, "comments"),
            related: Handlers.relatedLink("articles", article.id, "comments"),
            meta: { total }
          })
        })
      )
    )
    .handle("updateAuthorRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const updated = Article.make({
            ...article,
            relationships: { ...article.relationships!, author: { data: payload.data } }
          })
          store.articles.set(updated.id, updated)
          return Handlers.linkage(payload.data, {
            self: Handlers.relationshipLink("articles", article.id, "author"),
            related: Handlers.relatedLink("articles", article.id, "author")
          })
        })
      )
    )
    .handle("addCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const linked = store.articleComments.get(article.id) ?? []
          for (const identifier of payload.data) {
            if (!linked.includes(identifier.id)) linked.push(identifier.id)
          }
          store.articleComments.set(article.id, linked)
          return Handlers.linkage(
            linked.map((id) => Comment.ref(id)),
            {
              self: Handlers.relationshipLink("articles", article.id, "comments"),
              related: Handlers.relatedLink("articles", article.id, "comments")
            }
          )
        })
      )
    )
    .handle("removeCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const remove = new Set<string>(payload.data.map((identifier) => identifier.id))
          store.articleComments.set(
            article.id,
            (store.articleComments.get(article.id) ?? []).filter((id) => !remove.has(id))
          )
        })
      )
    )
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
      Handlers.collection(page, {
        included:
          query.include === undefined
            ? []
            : page.flatMap((result) => (result.type === "articles" ? resolveIncluded(result, query.include) : [])),
        meta: { total },
        links: Handlers.offsetPaginationLinks("/search", { offset, limit }, total)
      })
    )
  })
)

// ---------------------------------------------------------------------------
// Atomic operations handlers — all-or-nothing processing with lid support
// ---------------------------------------------------------------------------

/** The operation union the operations endpoint accepts. */
type AtomicOperation = Atomic.Operation<typeof Article | typeof Comment>["Type"]

/** One result entry per operation; removals and relationship updates return no data. */
type ResultEntry = { readonly data?: Article | Comment | null }

/**
 * A draft of the store: operations apply here, and the draft is committed only
 * if every operation succeeds — all-or-nothing, per the extension.
 */
interface Draft {
  readonly articles: Map<string, Article>
  readonly comments: Map<string, Comment>
  /** The paginated comments relationship index (article id → comment ids). */
  readonly articleComments: Map<string, Array<string>>
}

let atomicIdCounter = 0
const freshId = (): string => `atomic-${++atomicIdCounter}`

/**
 * The id a ref (or update `data`) targets, resolving lids assigned by earlier
 * operations in the same request.
 */
const targetId = (lids: Lid.LidMap, target: { readonly id?: string; readonly lid?: string }): string => {
  if (target.id !== undefined) return target.id
  if (target.lid !== undefined) {
    const id = lids.id(target.lid)
    if (id !== undefined) return id
    throw new Lid.UnknownLidError(target.lid)
  }
  throw new Error("operation does not identify a target resource")
}

const getArticle = (
  draft: Draft,
  lids: Lid.LidMap,
  target: { readonly id?: string; readonly lid?: string }
): Article => {
  const id = targetId(lids, target)
  const article = draft.articles.get(id)
  if (article === undefined) throw new Error(`article "${id}" not found`)
  return article
}

const getComment = (
  draft: Draft,
  lids: Lid.LidMap,
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
const applyOperation = (draft: Draft, lids: Lid.LidMap, operation: AtomicOperation): ResultEntry =>
  Match.value(operation).pipe(
    // --- relationship operations (refs carrying a `relationship` member) ----
    // replace an article's author (`one`: the new linkage is never null)
    Match.when(Atomic.targetsRelationship(Article, "author"), (op) => {
      const article = getArticle(draft, lids, op.ref)
      draft.articles.set(
        article.id,
        Article.make({
          ...article,
          relationships: {
            ...article.relationships!,
            author: { data: lids.identifier(Person, op.data) }
          }
        })
      )
      return Atomic.emptyResult
    }),
    // add to / replace / remove from an article's tags (`many`: inline linkage)
    Match.when(Atomic.targetsRelationship(Article, "tags"), (op) => {
      const article = getArticle(draft, lids, op.ref)
      const refs = op.data.map((ref) => lids.identifier(Tag, ref))
      const current = article.relationships?.tags.data ?? []
      const next =
        op.op === "add"
          ? [...current, ...refs]
          : op.op === "remove"
            ? current.filter((existing) => !refs.some((removed) => removed.id === existing.id))
            : refs
      draft.articles.set(
        article.id,
        Article.make({
          ...article,
          relationships: { ...article.relationships!, tags: { data: next } }
        })
      )
      return Atomic.emptyResult
    }),
    // add to / replace / remove from an article's comments (`paginated`: the
    // linkage lives in the relationship index, not inline on the article)
    Match.when(Atomic.targetsRelationship(Article, "comments"), (op) => {
      const article = getArticle(draft, lids, op.ref)
      const ids: ReadonlyArray<string> = op.data.map((ref) => lids.identifier(Comment, ref).id)
      const current = draft.articleComments.get(article.id) ?? []
      const next =
        op.op === "add"
          ? [...current, ...ids.filter((id) => !current.includes(id))]
          : op.op === "remove"
            ? current.filter((id) => !ids.includes(id))
            : [...ids]
      draft.articleComments.set(article.id, next)
      return Atomic.emptyResult
    }),
    // replace a comment's author (`one`)
    Match.when(Atomic.targetsRelationship(Comment, "author"), (op) => {
      const comment = getComment(draft, lids, op.ref)
      draft.comments.set(
        comment.id,
        Comment.make({
          ...comment,
          relationships: { author: { data: lids.identifier(Person, op.data) } }
        })
      )
      return Atomic.emptyResult
    }),
    // --- resource operations -------------------------------------------------
    Match.when(Atomic.targetsResource(Article), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const id = Article.Id.make(freshId())
          const resolved = lids.resolveLinkage(Article, add.data.relationships)
          const article = Article.make({
            id,
            attributes: add.data.attributes,
            relationships: {
              // `author` is required (`one`), so the operation always carries it
              author: { data: lids.identifier(Person, add.data.relationships.author.data) },
              tags: resolved.tags ?? { data: [] },
              // `comments` is paginated: new articles start with an empty collection
              comments: Handlers.paginatedRelationship("articles", id, "comments")
            }
          })
          draft.articles.set(article.id, article)
          draft.articleComments.set(article.id, [])
          if (add.data.lid !== undefined) lids.assign(add.data.lid, article.id)
          return { data: article }
        }),
        Match.when({ op: "update" }, (update) => {
          const article = getArticle(draft, lids, update.ref ?? update.data)
          const resolved = lids.resolveLinkage(Article, update.data.relationships)
          const updated = Article.make({
            ...article,
            attributes: { ...article.attributes, ...update.data.attributes },
            relationships: { ...article.relationships!, ...resolved }
          })
          draft.articles.set(updated.id, updated)
          return { data: updated }
        }),
        Match.when({ op: "remove" }, (remove) => {
          const article = getArticle(draft, lids, remove.ref)
          draft.articles.delete(article.id)
          draft.articleComments.delete(article.id)
          return Atomic.emptyResult
        }),
        Match.exhaustive
      )
    ),
    Match.when(Atomic.targetsResource(Comment), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const comment = Comment.make({
            id: Comment.Id.make(freshId()),
            attributes: add.data.attributes,
            relationships: {
              // `author` is required (`one`)
              author: { data: lids.identifier(Person, add.data.relationships.author.data) }
            }
          })
          draft.comments.set(comment.id, comment)
          if (add.data.lid !== undefined) lids.assign(add.data.lid, comment.id)
          return { data: comment }
        }),
        Match.when({ op: "update" }, (update) => {
          const comment = getComment(draft, lids, update.ref ?? update.data)
          const resolved = lids.resolveLinkage(Comment, update.data.relationships)
          const updated = Comment.make({
            ...comment,
            attributes: { ...comment.attributes, ...update.data.attributes },
            relationships: { ...comment.relationships!, ...resolved }
          })
          draft.comments.set(updated.id, updated)
          return { data: updated }
        }),
        Match.when({ op: "remove" }, (remove) => {
          const comment = getComment(draft, lids, remove.ref)
          draft.comments.delete(comment.id)
          // unlink it from any article's paginated comments relationship
          for (const [articleId, ids] of draft.articleComments) {
            draft.articleComments.set(
              articleId,
              ids.filter((id) => id !== comment.id)
            )
          }
          return Atomic.emptyResult
        }),
        Match.exhaustive
      )
    ),
    Match.exhaustive
  )

export const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.gen(function* () {
      const draft: Draft = {
        articles: new Map(store.articles),
        comments: new Map(store.comments),
        articleComments: new Map([...store.articleComments].map(([articleId, ids]) => [articleId, [...ids]]))
      }
      const lids = Lid.make()
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
      store.articleComments = draft.articleComments
      return Atomic.results(entries)
    })
  )
)

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
  Layer.provideMerge(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] }))
)
