import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { SqliteClient } from "@effect/sql-sqlite-node";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpApi } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Conformance from "./Conformance.js";
import type * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { make as Resource } from "./Resource.js";
import * as ResourceService from "./ResourceService.js";
import * as SqlService from "./SqlService.js";

const Person = Resource("people", { attributes: { name: Schema.NonEmptyString } });
const Tag = Resource("tags", { attributes: { label: Schema.String } });
const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString.annotate({ sqlColumn: "headline" }),
    rank: Schema.Int,
    published: Schema.optionalKey(Schema.Date),
  },
  relationships: {
    author: Relationship.one(() => Person, { key: "authorId" }),
    editor: Relationship.optional(() => Person),
    tags: Relationship.many(() => Tag),
  },
});

class NotFound extends ApiError.make<NotFound>()("NotFound", {
  status: 404,
  fields: { id: Schema.String },
}) {}

const Api = HttpApi.make("blog")
  .add(
    Group.resource(Article, {
      errors: [NotFound],
      page: Query.Page.Offset,
      endpoints: { list: { filter: { author: Schema.optionalKey(Schema.String) } } },
    }),
  )
  .add(
    Group.resource(Person, {
      errors: [NotFound],
      endpoints: { create: false, update: false, delete: false },
      relationships: false,
    }),
  );

const notFound = (id: string) => new NotFound({ id });
const at = (input: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(input));

// A fresh in-memory database with the blog's schema and rows.
const database = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE people (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
    yield* sql`CREATE TABLE tags (id TEXT PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      headline TEXT NOT NULL,
      rank INTEGER NOT NULL,
      published TEXT,
      authorId TEXT NOT NULL,
      editor TEXT
    )`;
    yield* sql`CREATE TABLE article_tags (article_id TEXT NOT NULL, tag_id TEXT NOT NULL)`;
    yield* sql`INSERT INTO people (id, name) VALUES ('1', 'Dan'), ('2', 'Tyler')`;
    yield* sql`INSERT INTO tags (id, label) VALUES ('t1', 'news'), ('t2', 'opinion')`;
    yield* sql`INSERT INTO articles (headline, rank, published, authorId, editor) VALUES
      ('Bravo', 2, '2024-01-02T00:00:00.000Z', '1', NULL),
      ('Alpha', 1, NULL, '2', '1'),
      ('Charlie', 3, NULL, '1', NULL)`;
    yield* sql`INSERT INTO article_tags (article_id, tag_id) VALUES ('1', 't1'), ('1', 't2'), ('3', 't2')`;
  }),
).pipe(Layer.provideMerge(SqliteClient.layer({ filename: ":memory:" })));

const services = Effect.fn("services")(function* () {
  const articles = yield* SqlService.make(Article, {
    table: "articles",
    notFound,
    relationships: { tags: { table: "article_tags", from: "article_id", to: "tag_id" } },
  });
  const people = yield* SqlService.make(Person, { table: "people", notFound });
  const tags = yield* SqlService.make(Tag, { table: "tags", notFound });
  return { articles, people, tags };
});

const ids = (page: ResourceService.Page<{ readonly id: string }>) =>
  page.items.map((item) => item.id);

describe("SqlService.make", () => {
  it.effect("reads a row, its to-one columns and its join-table members", () =>
    Effect.gen(function* () {
      const { articles } = yield* services();
      const article = yield* articles.find(Article.Id.make("1"), {});
      expect(article).toEqual({
        type: "articles",
        id: "1",
        attributes: { title: "Bravo", rank: 2, published: at("2024-01-02T00:00:00.000Z") },
        relationships: {
          author: { data: { type: "people", id: "1" } },
          editor: { data: null },
          tags: {
            data: [
              { type: "tags", id: "t1" },
              { type: "tags", id: "t2" },
            ],
          },
        },
      });
      const missing = yield* Effect.flip(articles.find(Article.Id.make("9"), {}));
      expect(missing).toEqual(notFound("9"));
    }).pipe(Effect.provide(database)),
  );

  it.effect("loads a batch in one statement per table", () =>
    Effect.gen(function* () {
      const { articles } = yield* services();
      const found = yield* ResourceService.includeTarget(articles)(["3", "1", "9"]);
      expect(found.map((article) => article.id).toSorted()).toEqual(["1", "3"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("filters by a field map, sorts and pages", () =>
    Effect.gen(function* () {
      const { articles } = yield* services();
      const list = articles.list;
      expect(
        ids(yield* list({ filter: { author: "1" }, sort: [{ field: "rank", direction: "desc" }] })),
      ).toEqual(["3", "1"]);
      const page = yield* list({
        sort: [{ field: "title", direction: "asc" }],
        page: { offset: 1, limit: 1 },
      });
      expect(ids(page)).toEqual(["1"]);
      expect(page.total).toBe(3);
      expect(ids(yield* list({ page: { number: 2, size: 2 } }))).toEqual(["3"]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("translates a Filter grammar tree", () =>
    Effect.gen(function* () {
      const { articles } = yield* services();
      const where = (node: Filter.Node) =>
        Effect.map(
          articles.list({ filter: node as never, sort: [{ field: "rank", direction: "asc" }] }),
          ids,
        );
      expect(yield* where({ _tag: "Compare", op: "gte", field: "rank", value: 2 })).toEqual([
        "1",
        "3",
      ]);
      expect(yield* where({ _tag: "In", field: "title", values: ["Alpha", "Charlie"] })).toEqual([
        "2",
        "3",
      ]);
      expect(yield* where({ _tag: "IsNull", field: "editor", negated: false })).toEqual(["1", "3"]);
      expect(yield* where({ _tag: "Text", op: "contains", field: "title", value: "ar" })).toEqual([
        "3",
      ]);
      // Case-sensitive, as `LIKE` is not.
      expect(yield* where({ _tag: "Text", op: "startsWith", field: "title", value: "b" })).toEqual(
        [],
      );
      expect(yield* where({ _tag: "Text", op: "endsWith", field: "title", value: "" })).toEqual([
        "2",
        "1",
        "3",
      ]);
      expect(
        yield* where({
          _tag: "Or",
          members: [
            { _tag: "Compare", op: "eq", field: "author", value: "2" },
            {
              _tag: "Not",
              member: {
                _tag: "Compare",
                op: "lt",
                field: "published",
                value: at("2025-01-01"),
              },
            },
          ],
        }),
      ).toEqual(["2"]);
      expect(yield* where({ _tag: "And", members: [] })).toEqual(["2", "1", "3"]);
      expect(yield* where({ _tag: "Or", members: [] })).toEqual([]);
    }).pipe(Effect.provide(database)),
  );

  it.effect("writes rows, columns and join-table members", () =>
    Effect.gen(function* () {
      const { articles } = yield* services();
      const created = yield* articles.create({
        type: "articles",
        attributes: { title: "Delta", rank: 4 },
        relationships: {
          author: { data: { type: "people", id: Person.Id.make("2") } },
          tags: { data: [{ type: "tags", id: Tag.Id.make("t1") }] },
        },
      });
      expect(created.id).toBe("4");
      expect(created.relationships?.tags.data).toEqual([{ type: "tags", id: "t1" }]);

      const updated = yield* articles.update(Article.Id.make("4"), {
        type: "articles",
        id: Article.Id.make("4"),
        attributes: { title: "Echo" },
        relationships: { editor: { data: { type: "people", id: Person.Id.make("1") } } },
      });
      expect(updated.attributes).toEqual({ title: "Echo", rank: 4 });
      expect(updated.relationships?.editor.data).toEqual({ type: "people", id: "1" });

      yield* articles.addToRelationship(Article.Id.make("4"), "tags", [
        { type: "tags", id: "t1" },
        { type: "tags", id: "t2" },
      ]);
      yield* articles.removeFromRelationship(Article.Id.make("4"), "tags", [
        { type: "tags", id: "t1" },
      ]);
      yield* articles.setRelationship(Article.Id.make("4"), "author", { type: "people", id: "1" });
      const linked = yield* articles.find(Article.Id.make("4"), {});
      expect(linked.relationships?.tags.data).toEqual([{ type: "tags", id: "t2" }]);
      expect(linked.relationships?.author.data).toEqual({ type: "people", id: "1" });

      yield* articles.delete(Article.Id.make("4"));
      expect(yield* Effect.flip(articles.find(Article.Id.make("4"), {}))).toEqual(notFound("4"));
      const sql = yield* SqlClient.SqlClient;
      expect(yield* sql`SELECT * FROM article_tags WHERE article_id = '4'`).toEqual([]);
    }).pipe(Effect.provide(database)),
  );
});

// The blog served over the database.
const live = Layer.unwrap(
  Effect.map(services(), ({ articles, people, tags }) =>
    Layer.mergeAll(
      ResourceService.layer(Api, "articles", Article, articles, {
        include: {
          people: ResourceService.includeTarget(people),
          tags: ResourceService.includeTarget(tags),
        },
        missingTarget: (identifier) => notFound(identifier.id),
      }),
      ResourceService.layer(Api, "people", Person, people),
    ),
  ),
).pipe(Layer.provideMerge(Middleware.layer), Layer.provide(database));

const failedRules = (options: Conformance.Options) =>
  // SAFETY: `live` and `Middleware.layer` provide every service the router
  // needs; the platform services `verify` names are never used.
  (
    Conformance.verify(Api, {
      tiers: ["spec"],
      ids: { articles: "1", people: "1" },
      ...options,
    }).pipe(Effect.provide(live), Effect.scoped) as Effect.Effect<Conformance.Report>
  ).pipe(
    Effect.map((report) =>
      report.outcomes
        .filter((outcome) => P.isTagged(outcome, "Failed"))
        .map((outcome) => outcome.rule.id),
    ),
  );

describe("SqlService under the conformance kit", () => {
  it.effect("passes every spec read rule", () =>
    Effect.map(failedRules({}), (failed) => expect(failed).toEqual([])),
  );

  it.effect("passes every spec write rule", () =>
    Effect.map(
      failedRules({
        mutating: true,
        writes: {
          articles: {
            create: () => ({
              type: "articles",
              attributes: { title: "Probe", rank: 9 },
              relationships: { author: { data: { type: "people", id: "1" } } },
            }),
            update: () => ({ attributes: { title: "Probe (updated)" } }),
          },
        },
      }),
      (failed) => expect(failed).toEqual([]),
    ),
  );
});
