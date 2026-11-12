/**
 * The blog's handlers: a vanilla `HttpApiBuilder.group` implementation backed
 * by an in-memory store, using the JSON:API document builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.fields` / `query.sort` / `query.page` /
 *     `query.filter` are typed
 *   - `payload.data.attributes` is the typed create/update payload
 *   - relationship endpoints receive typed linkage payloads
 *
 * and return document values (`Handlers.data` / `Handlers.collection` /
 * `Handlers.linkage`), which are validated against the endpoint's document
 * schema on the way out. Each of those documents advertises the JSON:API
 * version it implements (`jsonapi: Document.v1_1`); the `Atomic.results` answer
 * to `/operations` and the `ApiError` error documents carry no `jsonapi`
 * member. The reads that declare `fields` — `GET /articles/:id`, `/search` and
 * `GET /articles/:id/relationships/tags` — answer `?fields[TYPE]=` by
 * projecting each resource they carry, primary data and `included` alike
 * (only `included` on the relationship endpoint, whose primary data is
 * identifiers), with `onResource: Handlers.project(query.fields)`; the other
 * reads declare no `fields`, so their clients read every attribute as
 * required.
 */
import * as R from "effect/Record";
import * as MutableHashSet from "effect/MutableHashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import { HttpApiBuilder } from "effect/http-api";
import { Atomic, Document, Handlers, Lid, Middleware, Query } from "@thomasfosterau/effect-jsonapi";
import { Api, ArticleCommentsQuery, ArticlesQuery, SearchQuery } from "./api.js";
import {
  ArticleNotFound,
  CommentNotFound,
  OperationFailed,
  PersonNotFound,
  TagNotFound,
  TitleTaken,
} from "./errors.js";
import { Article, Comment, Person, Tag } from "./resources.js";

const at = (input: string | number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(input));

/**
 * Drops every `undefined` member of a payload's `attributes`. In-process — and
 * over codec transports that preserve it — an explicit `undefined` is accepted
 * for an optional attribute, but the resource's own schema takes the key
 * absent, and under `exactOptionalPropertyTypes` the two spell differently.
 */
const definedAttributes = <A extends Record<string, unknown>>(
  attributes: A,
): { readonly [K in keyof A]: Exclude<A[K], undefined> } =>
  R.fromEntries(R.toEntries(attributes).filter(([, value]) => value !== undefined)) as {
    readonly [K in keyof A]: Exclude<A[K], undefined>;
  };

/**
 * Applies a PATCH's `attributes` over the current ones. An absent member —
 * or, in-process, an explicit `undefined` — leaves the current value; a plain
 * spread would type the result as possibly-`undefined`.
 */
const patchAttributes = <A extends Record<string, unknown>>(
  current: A,
  patch: { readonly [K in keyof A]?: A[K] | undefined } | undefined,
): A => ({ ...current, ...definedAttributes(patch ?? {}) });

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const sampleAuthor: Person = Person.make({
  id: Person.Id.make("9"),
  attributes: { firstName: "Dan", lastName: "Gebhardt", twitter: "dgeb" },
});

export const sampleTag: Tag = Tag.make({
  id: Tag.Id.make("1"),
  attributes: { name: "API design", slug: "api-design" },
});

export const sampleComments: ReadonlyArray<Comment> = [
  Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First!" },
    relationships: {
      author: { data: Person.ref(sampleAuthor.id) },
    },
  }),
  Comment.make({
    id: Comment.Id.make("12"),
    attributes: { body: "I like XML better" },
    relationships: {
      author: { data: Person.ref(sampleAuthor.id) },
    },
  }),
];

export const sampleArticle: Article = Article.make({
  id: Article.Id.make("1"),
  attributes: {
    title: "JSON:API paints my bikeshed!",
    body: "The shortest article. Ever.",
    createdAt: at("2024-01-01T00:00:00.000Z"),
  },
  relationships: {
    // `one`: inline identifier, never null
    author: { data: Person.ref(sampleAuthor.id) },
    // `many`: inline identifier array
    tags: { data: [Tag.ref(sampleTag.id)] },
    // `paginated`: no inline data — just the links clients follow
    comments: Handlers.paginatedRelationship("articles", "1", "comments"),
  },
});

const store = {
  articles: MutableHashMap.fromIterable<string, Article>([[sampleArticle.id, sampleArticle]]),
  people: MutableHashMap.fromIterable<string, Person>([[sampleAuthor.id, sampleAuthor]]),
  tags: MutableHashMap.fromIterable<string, Tag>([[sampleTag.id, sampleTag]]),
  comments: MutableHashMap.fromIterable<string, Comment>(
    sampleComments.map((comment) => [comment.id, comment]),
  ),
  // The paginated comments relationship is backed by its own index, not by
  // inline linkage on the article.
  articleComments: MutableHashMap.fromIterable<string, Array<string>>([
    [sampleArticle.id, sampleComments.map((c) => c.id)],
  ]),
};

/**
 * Removes an article outright, bypassing the API — the cleanup a conformance
 * run's write fixture hands back (`test/conformance.test.ts`), so the articles
 * the kit creates do not outlive the rules that created them.
 */
export const discardArticle = (id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    MutableHashMap.remove(store.articles, id);
    MutableHashMap.remove(store.articleComments, id);
  });

/**
 * A stored resource's relationships. Every record in the store is built with
 * them, so an absent member is a defect, and reading it fails right here
 * rather than at a later `undefined` access.
 */
const relationshipsOf = <T extends { readonly relationships?: object }>(
  resource: T,
): NonNullable<T["relationships"]> =>
  Option.getOrThrowWith(
    Option.fromNullishOr(resource.relationships),
    () => new Cause.NoSuchElementError(),
  );

const loadArticle = (id: string): Effect.Effect<Article, ArticleNotFound> => {
  const article = Option.getOrUndefined(MutableHashMap.get(store.articles, id));
  return article === undefined ? Effect.fail(new ArticleNotFound({ id })) : Effect.succeed(article);
};

// A relationship write naming a resource the store does not hold answers 404
// (JSON:API §Updating Relationships) rather than linking it.
const requirePerson = (id: string): Effect.Effect<void, PersonNotFound> =>
  MutableHashMap.has(store.people, id) ? Effect.void : Effect.fail(new PersonNotFound({ id }));

const requireComments = (
  identifiers: ReadonlyArray<{ readonly id: string }>,
): Effect.Effect<void, CommentNotFound> => {
  const missing = identifiers.find(
    (identifier) => !MutableHashMap.has(store.comments, identifier.id),
  );
  return missing === undefined ? Effect.void : Effect.fail(new CommentNotFound({ id: missing.id }));
};

// Resolve the resources referenced by the requested include paths.
// Only `one` / `optional` / `many` relationships are includable; the paginated
// `comments` relationship never appears here.
const resolveIncluded = (article: Article, include: ReadonlyArray<string> | undefined) => {
  const included: Array<Person | Tag> = [];
  if (include?.includes("author")) {
    const author = article.relationships?.author.data;
    const person =
      author === undefined
        ? undefined
        : Option.getOrUndefined(MutableHashMap.get(store.people, author.id));
    if (person !== undefined) included.push(person);
  }
  if (include?.includes("tags")) {
    Arr.forEach(article.relationships?.tags.data ?? [], (identifier) => {
      const tag = Option.getOrUndefined(MutableHashMap.get(store.tags, identifier.id));
      if (tag !== undefined) included.push(tag);
    });
  }
  return included;
};

// The comments attached to an article, via the relationship index.
const articleComments = (articleId: string): Array<Comment> =>
  (Option.getOrUndefined(MutableHashMap.get(store.articleComments, articleId)) ?? []).flatMap(
    (commentId) => {
      const comment = Option.getOrUndefined(MutableHashMap.get(store.comments, commentId));
      return comment === undefined ? [] : [comment];
    },
  );

// One offset page of an article's comments, shared by the related collection
// and the relationship endpoint: the page, the bounds it was cut at and the
// collection's total.
const articleCommentPage = (
  articleId: string,
  request: { readonly offset?: number; readonly limit?: number } | undefined,
) => {
  const all = articleComments(articleId);
  const total = all.length;
  const offset = request?.offset ?? 0;
  const limit = request?.limit ?? total;
  return { page: all.slice(offset, offset + limit), offset, limit, total };
};

// The authors of some comments, for `include=author` / `include=comments.author`.
const commentAuthors = (comments: ReadonlyArray<Comment>): Array<Person> =>
  comments.flatMap((comment) => {
    const authorId = comment.relationships?.author.data.id;
    const author =
      authorId === undefined
        ? undefined
        : Option.getOrUndefined(MutableHashMap.get(store.people, authorId));
    return author === undefined ? [] : [author];
  });

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) =>
          Handlers.data(article, {
            included:
              query.include === undefined ? undefined : resolveIncluded(article, query.include),
            self: `/articles/${article.id}`,
            onResource: Handlers.project(query.fields),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let articles = Arr.fromIterable(MutableHashMap.values(store.articles));

      // filter[author]=<person id>
      const author = query.filter?.author;
      if (author !== undefined) {
        articles = articles.filter((article) => article.relationships?.author.data.id === author);
      }

      // sort=-createdAt,title
      articles = Arr.reduce((query.sort ?? []).toReversed(), articles, (sorted, term) => {
        const ascending = Order.make<(typeof articles)[number]>((a, b) => {
          const left = a.attributes[term.field];
          const right = b.attributes[term.field];
          return left < right ? -1 : left > right ? 1 : 0;
        });
        return Arr.sort(sorted, term.direction === "desc" ? Order.flip(ascending) : ascending);
      });

      // page[offset]=0&page[limit]=10
      const total = articles.length;
      const offset = query.page?.offset ?? 0;
      const limit = query.page?.limit ?? total;
      const page = articles.slice(offset, offset + limit);

      return Effect.succeed(
        Handlers.collection(page, {
          included:
            query.include === undefined
              ? undefined
              : page.flatMap((article) => resolveIncluded(article, query.include)),
          meta: { total },
          links: Handlers.offsetPaginationLinks("/articles", { offset, limit }, total, {
            query: Query.canonicalPairs(ArticlesQuery)(query),
          }),
          jsonapi: Document.v1_1,
        }),
      );
    })
    .handle("create", ({ payload }) => {
      const title = payload.data.attributes.title;
      if (
        Arr.some(
          Arr.fromIterable(MutableHashMap.values(store.articles)),
          (existing) => existing.attributes.title === title,
        )
      ) {
        return Effect.fail(new TitleTaken({ title }));
      }
      const id = Article.Id.make(`${MutableHashMap.size(store.articles) + 1}`);
      const article = Article.make({
        id,
        attributes: payload.data.attributes,
        relationships: {
          // `author` is a required relationship — the payload always carries it.
          author: payload.data.relationships.author,
          tags: payload.data.relationships.tags ?? { data: [] },
          // `comments` can't be supplied at create time; new articles start
          // with an empty, paginated comment collection.
          comments: Handlers.paginatedRelationship("articles", id, "comments"),
        },
      });
      MutableHashMap.set(store.articles, article.id, article);
      MutableHashMap.set(store.articleComments, article.id, []);
      // The created resource carries its own `self` link: the 201's `Location`
      // header is copied from it, so the two match.
      const self = `/articles/${article.id}`;
      return Effect.succeed(
        Handlers.data({ ...article, links: { self } }, { self, jsonapi: Document.v1_1 }),
      );
    })
    .handle("update", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const relationships = relationshipsOf(article);
          const updated = Article.make({
            ...article,
            attributes: patchAttributes(article.attributes, payload.data.attributes),
            relationships: {
              author: payload.data.relationships?.author ?? relationships.author,
              tags: payload.data.relationships?.tags ?? relationships.tags,
              comments: relationships.comments,
            },
          });
          MutableHashMap.set(store.articles, updated.id, updated);
          return Handlers.data(updated, {
            self: `/articles/${updated.id}`,
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("delete", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          MutableHashMap.remove(store.articles, article.id);
          MutableHashMap.remove(store.articleComments, article.id);
        }),
      ),
    )
    // --- Related resource endpoints -----------------------------------------
    .handle("author", ({ params }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const author =
            Option.getOrUndefined(
              MutableHashMap.get(store.people, relationshipsOf(article).author.data.id),
            ) ?? null;
          return Handlers.data(author, {
            self: Handlers.relatedLink("articles", article.id, "author"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("comments", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const { page, offset, limit, total } = articleCommentPage(article.id, query.page);
          const path = Handlers.relatedLink("articles", article.id, "comments");
          return Handlers.collection(page, {
            included:
              query.include === undefined
                ? undefined
                : query.include.includes("author")
                  ? commentAuthors(page)
                  : [],
            meta: { total },
            links: Handlers.offsetPaginationLinks(path, { offset, limit }, total, {
              query: Query.canonicalPairs(ArticleCommentsQuery)(query),
            }),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // --- Relationship (linkage) endpoints ------------------------------------
    .handle("commentsRelationship", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const { page, total } = articleCommentPage(article.id, query.page);
          const include = query.include;
          return Handlers.linkage(
            page.map((comment) => Comment.ref(comment.id)),
            {
              // `undefined` without `?include=` (no `included` member). With it,
              // the comments on *this page*, never the whole relationship —
              // `Handlers.linkage` checks full linkage from the page's
              // identifiers — and, for `comments.author`, their authors.
              included:
                include === undefined
                  ? undefined
                  : [
                      ...(Arr.isReadonlyArrayNonEmpty(include) ? page : []),
                      ...(include.includes("comments.author") ? commentAuthors(page) : []),
                    ],
              self: Handlers.relationshipLink("articles", article.id, "comments"),
              related: Handlers.relatedLink("articles", article.id, "comments"),
              meta: { total },
              jsonapi: Document.v1_1,
            },
          );
        }),
      ),
    )
    .handle("tagsRelationship", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const tags = article.relationships?.tags.data ?? [];
          return Handlers.linkage(tags, {
            // `undefined` without `?include=` (no `included` member); with
            // `include=tags`, the tags the identifiers name. `Handlers.linkage`
            // checks full linkage from the identifiers themselves.
            included:
              query.include === undefined
                ? undefined
                : tags.flatMap((identifier) => {
                    const tag = Option.getOrUndefined(
                      MutableHashMap.get(store.tags, identifier.id),
                    );
                    return tag === undefined ? [] : [tag];
                  }),
            // `?fields[tags]=…` narrows the `included` tags; projecting an
            // identifier is a no-op.
            onResource: Handlers.project(query.fields),
            self: Handlers.relationshipLink("articles", article.id, "tags"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("updateAuthorRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.tap(() => requirePerson(payload.data.id)),
        Effect.map((article) => {
          const updated = Article.make({
            ...article,
            relationships: { ...relationshipsOf(article), author: { data: payload.data } },
          });
          MutableHashMap.set(store.articles, updated.id, updated);
          return Handlers.linkage(payload.data, {
            self: Handlers.relationshipLink("articles", article.id, "author"),
            related: Handlers.relatedLink("articles", article.id, "author"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("addCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.tap(() => requireComments(payload.data)),
        Effect.map((article) => {
          const linked =
            Option.getOrUndefined(MutableHashMap.get(store.articleComments, article.id)) ?? [];
          Arr.forEach(payload.data, (identifier) => {
            if (!linked.includes(identifier.id)) linked.push(identifier.id);
          });
          MutableHashMap.set(store.articleComments, article.id, linked);
          return Handlers.linkage(
            linked.map((id) => Comment.ref(id)),
            {
              self: Handlers.relationshipLink("articles", article.id, "comments"),
              related: Handlers.relatedLink("articles", article.id, "comments"),
              jsonapi: Document.v1_1,
            },
          );
        }),
      ),
    )
    .handle("removeCommentsRelationship", ({ params, payload }) =>
      loadArticle(params.id).pipe(
        Effect.map((article) => {
          const remove = MutableHashSet.fromIterable<string>(
            payload.data.map((identifier) => identifier.id),
          );
          MutableHashMap.set(
            store.articleComments,
            article.id,
            (
              Option.getOrUndefined(MutableHashMap.get(store.articleComments, article.id)) ?? []
            ).filter((id) => !MutableHashSet.has(remove, id)),
          );
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Search handlers — a heterogeneous collection of articles and people
// ---------------------------------------------------------------------------

const matches = (haystack: ReadonlyArray<string>, needle: string): boolean =>
  haystack.some((value) => value.toLowerCase().includes(needle.toLowerCase()));

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => {
    // no filter[q] → match everything
    const q = query.filter?.q ?? "";

    // search across both resource types; results stay discriminated by `type`
    const articles = Arr.fromIterable(MutableHashMap.values(store.articles)).filter((article) =>
      matches([article.attributes.title, article.attributes.body], q),
    );
    const people = Arr.fromIterable(MutableHashMap.values(store.people)).filter((person) =>
      matches([person.attributes.firstName, person.attributes.lastName], q),
    );
    const results = [...articles, ...people];

    const total = results.length;
    const offset = query.page?.offset ?? 0;
    const limit = query.page?.limit ?? total;
    const page = results.slice(offset, offset + limit);

    return Effect.succeed(
      Handlers.collection(page, {
        included:
          query.include === undefined
            ? undefined
            : page.flatMap((result) =>
                result.type === "articles" ? resolveIncluded(result, query.include) : [],
              ),
        meta: { total },
        links: Handlers.offsetPaginationLinks("/search", { offset, limit }, total, {
          query: Query.canonicalPairs(SearchQuery)(query),
        }),
        onResource: Handlers.project(query.fields),
        jsonapi: Document.v1_1,
      }),
    );
  }),
);

// ---------------------------------------------------------------------------
// Atomic operations handlers — all-or-nothing processing with lid support
// ---------------------------------------------------------------------------

/** The operation union the operations endpoint accepts. */
type AtomicOperation = Atomic.Operation<typeof Article | typeof Comment>["Type"];

/** One result entry per operation; removals and relationship updates return no data. */
type ResultEntry = { readonly data?: Article | Comment | null };

/**
 * A draft of the store: operations apply here, and the draft is committed only
 * if every operation succeeds — all-or-nothing, per the extension.
 */
interface Draft {
  readonly articles: MutableHashMap.MutableHashMap<string, Article>;
  readonly comments: MutableHashMap.MutableHashMap<string, Comment>;
  /** The paginated comments relationship index (article id → comment ids). */
  readonly articleComments: MutableHashMap.MutableHashMap<string, Array<string>>;
}

/** A malformed or dangling atomic operation, thrown inside the draft and converted to `OperationFailed`. */
class InvalidOperation extends Schema.TaggedError<
  InvalidOperation,
  { readonly brand: unique symbol }
>()("InvalidOperation", { message: Schema.String }) {}

let atomicIdCounter = 0;
const freshId = (): string => `atomic-${++atomicIdCounter}`;

/**
 * The id a ref (or update `data`) targets, resolving lids assigned by earlier
 * operations in the same request.
 */
const targetId = (
  lids: Lid.LidMap,
  target: { readonly id?: string; readonly lid?: string },
): string => {
  if (target.id !== undefined) return target.id;
  if (target.lid !== undefined) {
    const id = lids.id(target.lid);
    if (id !== undefined) return id;
    throw new Lid.UnknownLidError(target.lid);
  }
  throw new InvalidOperation({ message: "operation does not identify a target resource" });
};

const getArticle = (
  draft: Draft,
  lids: Lid.LidMap,
  target: { readonly id?: string; readonly lid?: string },
): Article => {
  const id = targetId(lids, target);
  const article = Option.getOrUndefined(MutableHashMap.get(draft.articles, id));
  if (article === undefined) throw new InvalidOperation({ message: `article "${id}" not found` });
  return article;
};

const getComment = (
  draft: Draft,
  lids: Lid.LidMap,
  target: { readonly id?: string; readonly lid?: string },
): Comment => {
  const id = targetId(lids, target);
  const comment = Option.getOrUndefined(MutableHashMap.get(draft.comments, id));
  if (comment === undefined) throw new InvalidOperation({ message: `comment "${id}" not found` });
  return comment;
};

/** The 404s an operation fails with when its linkage names an absent resource. */
type LinkageNotFound = PersonNotFound | TagNotFound | CommentNotFound;

const isLinkageNotFound = (error: unknown): error is LinkageNotFound =>
  error instanceof PersonNotFound ||
  error instanceof TagNotFound ||
  error instanceof CommentNotFound;

/**
 * Returns `identifier` when `held` has a resource with its id, and otherwise
 * throws the 404 `notFound` builds: an operation linking a resource that does
 * not exist answers 404 (JSON:API §Creating Resources, §Updating
 * Relationships) rather than linking it. `pointer` locates the identifier
 * inside `atomic:operations`. The handler fails the whole request with the
 * error, so nothing is committed.
 */
const requireHeld = <I extends { readonly id: string }>(
  held: MutableHashMap.MutableHashMap<string, unknown>,
  notFound: (fields: { readonly id: string; readonly pointer: string }) => LinkageNotFound,
  identifier: I,
  pointer: string,
): I => {
  if (!MutableHashMap.has(held, identifier.id)) throw notFound({ id: identifier.id, pointer });
  return identifier;
};

// People and tags are never written by operations, so the store is the
// reference; comments are, so an operation checks them against the draft
// (which holds comments added, and lacks comments removed, earlier in the request).
const requireAuthor = <I extends { readonly id: string }>(identifier: I, pointer: string): I =>
  requireHeld(store.people, (fields) => new PersonNotFound(fields), identifier, pointer);

const requireTags = <I extends { readonly id: string }>(
  identifiers: ReadonlyArray<I>,
  pointer: string,
): Array<I> =>
  identifiers.map((identifier, index) =>
    requireHeld(store.tags, (fields) => new TagNotFound(fields), identifier, `${pointer}/${index}`),
  );

/**
 * Applies one operation to the draft, returning its result entry.
 *
 * Pattern-matches over the operation union with Effect's `Match` module: the
 * curried `Atomic.targetsRelationship` / `Atomic.targetsResource` guards
 * narrow each case to fully typed `data` / `ref`.
 *
 * Failures throw; the handler converts them into typed `OperationFailed`
 * errors carrying the index of the operation that failed, except the
 * `LinkageNotFound` 404s, which it passes through. `at` is the operation's
 * pointer (`Atomic.operationPointer`), for locating linkage inside it.
 */
const applyOperation = (
  draft: Draft,
  lids: Lid.LidMap,
  operation: AtomicOperation,
  at: string,
): ResultEntry =>
  Match.value(operation).pipe(
    // --- relationship operations (refs carrying a `relationship` member) ----
    // replace an article's author (`one`: the new linkage is never null)
    Match.when(Atomic.targetsRelationship(Article, "author"), (op) => {
      const article = getArticle(draft, lids, op.ref);
      MutableHashMap.set(
        draft.articles,
        article.id,
        Article.make({
          ...article,
          relationships: {
            ...relationshipsOf(article),
            author: {
              data: requireAuthor(lids.identifier(Person, op.data), `${at}/data`),
            },
          },
        }),
      );
      return Atomic.emptyResult;
    }),
    // add to / replace / remove from an article's tags (`many`: inline linkage).
    // A `remove` naming a tag that does not exist succeeds: that tag is
    // already missing from the relationship (JSON:API §Updating To-Many
    // Relationships), so only `add` and `update` check their targets.
    Match.when(Atomic.targetsRelationship(Article, "tags"), (op) => {
      const article = getArticle(draft, lids, op.ref);
      const named = op.data.map((ref) => lids.identifier(Tag, ref));
      const refs = op.op === "remove" ? named : requireTags(named, `${at}/data`);
      const current = article.relationships?.tags.data ?? [];
      const next =
        op.op === "add"
          ? [...current, ...refs]
          : op.op === "remove"
            ? current.filter((existing) => !refs.some((removed) => removed.id === existing.id))
            : refs;
      MutableHashMap.set(
        draft.articles,
        article.id,
        Article.make({
          ...article,
          relationships: { ...relationshipsOf(article), tags: { data: next } },
        }),
      );
      return Atomic.emptyResult;
    }),
    // add to / replace / remove from an article's comments (`paginated`: the
    // linkage lives in the relationship index, not inline on the article).
    // As for tags, a `remove` naming a comment that does not exist succeeds.
    Match.when(Atomic.targetsRelationship(Article, "comments"), (op) => {
      const article = getArticle(draft, lids, op.ref);
      const ids: ReadonlyArray<string> = op.data.map((ref, index) => {
        const identifier = lids.identifier(Comment, ref);
        return op.op === "remove"
          ? identifier.id
          : requireHeld(
              draft.comments,
              (fields) => new CommentNotFound(fields),
              identifier,
              `${at}/data/${index}`,
            ).id;
      });
      const current =
        Option.getOrUndefined(MutableHashMap.get(draft.articleComments, article.id)) ?? [];
      const next =
        op.op === "add"
          ? [...current, ...ids.filter((id) => !current.includes(id))]
          : op.op === "remove"
            ? current.filter((id) => !ids.includes(id))
            : [...ids];
      MutableHashMap.set(draft.articleComments, article.id, next);
      return Atomic.emptyResult;
    }),
    // replace a comment's author (`one`)
    Match.when(Atomic.targetsRelationship(Comment, "author"), (op) => {
      const comment = getComment(draft, lids, op.ref);
      MutableHashMap.set(
        draft.comments,
        comment.id,
        Comment.make({
          ...comment,
          relationships: {
            author: {
              data: requireAuthor(lids.identifier(Person, op.data), `${at}/data`),
            },
          },
        }),
      );
      return Atomic.emptyResult;
    }),
    // --- resource operations -------------------------------------------------
    Match.when(Atomic.targetsResource(Article), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const id = Article.Id.make(freshId());
          const resolved = lids.resolveLinkage(Article, add.data.relationships);
          const article = Article.make({
            id,
            attributes: add.data.attributes,
            relationships: {
              // `author` is required (`one`), so the operation always carries it
              author: {
                data: requireAuthor(
                  lids.identifier(Person, add.data.relationships.author.data),
                  `${at}${Document.pointer.relationship("author")}/data`,
                ),
              },
              tags: {
                data: requireTags(
                  resolved.tags?.data ?? [],
                  `${at}${Document.pointer.relationship("tags")}/data`,
                ),
              },
              // `comments` is paginated: new articles start with an empty collection
              comments: Handlers.paginatedRelationship("articles", id, "comments"),
            },
          });
          MutableHashMap.set(draft.articles, article.id, article);
          MutableHashMap.set(draft.articleComments, article.id, []);
          if (add.data.lid !== undefined) lids.assign(add.data.lid, article.id);
          return { data: article };
        }),
        Match.when({ op: "update" }, (update) => {
          const article = getArticle(draft, lids, update.ref ?? update.data);
          const resolved = lids.resolveLinkage(Article, update.data.relationships);
          if (resolved.author !== undefined) {
            requireAuthor(
              resolved.author.data,
              `${at}${Document.pointer.relationship("author")}/data`,
            );
          }
          if (resolved.tags !== undefined) {
            requireTags(resolved.tags.data, `${at}${Document.pointer.relationship("tags")}/data`);
          }
          const updated = Article.make({
            ...article,
            attributes: patchAttributes(article.attributes, update.data.attributes),
            relationships: { ...relationshipsOf(article), ...resolved },
          });
          MutableHashMap.set(draft.articles, updated.id, updated);
          return { data: updated };
        }),
        Match.when({ op: "remove" }, (remove) => {
          const article = getArticle(draft, lids, remove.ref);
          MutableHashMap.remove(draft.articles, article.id);
          MutableHashMap.remove(draft.articleComments, article.id);
          return Atomic.emptyResult;
        }),
        Match.exhaustive,
      ),
    ),
    Match.when(Atomic.targetsResource(Comment), (op) =>
      Match.value(op).pipe(
        Match.when({ op: "add" }, (add) => {
          const comment = Comment.make({
            id: Comment.Id.make(freshId()),
            attributes: add.data.attributes,
            relationships: {
              // `author` is required (`one`)
              author: {
                data: requireAuthor(
                  lids.identifier(Person, add.data.relationships.author.data),
                  `${at}${Document.pointer.relationship("author")}/data`,
                ),
              },
            },
          });
          MutableHashMap.set(draft.comments, comment.id, comment);
          if (add.data.lid !== undefined) lids.assign(add.data.lid, comment.id);
          return { data: comment };
        }),
        Match.when({ op: "update" }, (update) => {
          const comment = getComment(draft, lids, update.ref ?? update.data);
          const resolved = lids.resolveLinkage(Comment, update.data.relationships);
          if (resolved.author !== undefined) {
            requireAuthor(
              resolved.author.data,
              `${at}${Document.pointer.relationship("author")}/data`,
            );
          }
          const updated = Comment.make({
            ...comment,
            attributes: patchAttributes(comment.attributes, update.data.attributes),
            relationships: { ...relationshipsOf(comment), ...resolved },
          });
          MutableHashMap.set(draft.comments, updated.id, updated);
          return { data: updated };
        }),
        Match.when({ op: "remove" }, (remove) => {
          const comment = getComment(draft, lids, remove.ref);
          MutableHashMap.remove(draft.comments, comment.id);
          // unlink it from any article's paginated comments relationship
          Arr.forEach(draft.articleComments, ([articleId, ids]) => {
            MutableHashMap.set(
              draft.articleComments,
              articleId,
              ids.filter((id) => id !== comment.id),
            );
          });
          return Atomic.emptyResult;
        }),
        Match.exhaustive,
      ),
    ),
    Match.exhaustive,
  );

export const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.gen(function* () {
      const draft: Draft = {
        articles: MutableHashMap.fromIterable(store.articles),
        comments: MutableHashMap.fromIterable(store.comments),
        articleComments: MutableHashMap.fromIterable(
          [...store.articleComments].map(([articleId, ids]) => [articleId, [...ids]]),
        ),
      };
      const lids = Lid.make();

      const entries: ReadonlyArray<ResultEntry> = yield* Effect.forEach(
        payload["atomic:operations"],
        (operation, index) =>
          Effect.try({
            try: () => applyOperation(draft, lids, operation, Atomic.operationPointer(index)),
            catch: (error) =>
              isLinkageNotFound(error)
                ? error
                : new OperationFailed({
                    operation: index,
                    reason: P.isError(error) ? error.message : String(error),
                  }),
          }),
        { concurrency: 1 },
      );

      // every operation succeeded — commit the draft
      store.articles = draft.articles;
      store.comments = draft.comments;
      store.articleComments = draft.articleComments;
      return Atomic.results(entries);
    }),
  ),
);

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
  Layer.provideMerge(Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] })),
);
