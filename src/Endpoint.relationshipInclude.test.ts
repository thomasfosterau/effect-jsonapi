/**
 * Compound relationship documents (#439): `Endpoint.getRelationship` with
 * `include` accepts `?include=` and serves `included` beside the linkage.
 *
 * JSON:API 1.1 §Inclusion of Related Resources: "related resources can be
 * requested from a relationship endpoint: `GET
 * /articles/1/relationships/comments?include=comments.author`. In this case,
 * the primary data would be a collection of resource identifier objects that
 * represent linkage to comments for an article, while the full comments and
 * comment authors would be returned as included data."
 *
 * The paths are the parent resource's, rooted at the relationship. The
 * type-level half is `test/relationship-include.types.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Assemble from "./Assemble.js";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    // Paginated: never an include path.
    revisions: Relationship.paginated(() => Revision),
  },
});
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    comments: Relationship.many(() => Comment),
    editor: Relationship.optional(() => Person),
    history: Relationship.paginated(() => Revision),
  },
});

// One wire resource object of each type.
const wire = {
  comments: {
    type: "comments",
    id: "5",
    attributes: { body: "First" },
    relationships: {
      author: { data: { type: "people", id: "9" } },
      revisions: { links: { related: "/comments/5/revisions" } },
    },
  },
  people: {
    type: "people",
    id: "9",
    attributes: { name: "Ada" },
    relationships: { employer: { data: { type: "companies", id: "2" } } },
  },
  companies: { type: "companies", id: "2", attributes: { name: "Acme" } },
  revisions: { type: "revisions", id: "3", attributes: { editedAt: "2026-01-01" } },
} as const;
type WireType = keyof typeof wire;
const types: ReadonlyArray<WireType> = Rec.keys(wire);

const successOf = (endpoint: { readonly success: Iterable<Schema.Top> }) =>
  // SAFETY: every endpoint under test declares exactly one success schema, a
  // JSON:API document codec; decoding unknown input is what it is for.
  [...endpoint.success][0] as Schema.Codec<unknown, unknown>;
const queryOf = (endpoint: { readonly query: Schema.Top | undefined }) =>
  // SAFETY: every endpoint under test declares a query codec.
  endpoint.query as Schema.Codec<unknown, unknown>;

// Resource linkage as a relationship document's primary data.
interface Identifier {
  readonly type: string;
  readonly id: string;
}

// The types a relationship endpoint's success document admits in `included`.
const admitted = (
  endpoint: { readonly success: Iterable<Schema.Top> },
  data: Identifier | ReadonlyArray<Identifier>,
): ReadonlyArray<WireType> =>
  types.filter((type) =>
    Exit.isSuccess(
      Schema.decodeUnknownExit(successOf(endpoint))(
        { data, included: [wire[type]] },
        { onExcessProperty: "error" },
      ),
    ),
  );

// Whether a relationship endpoint's query decodes `?include=<paths>` into an
// `include` (a query that declares none drops the key; `Middleware` answers
// it with a 400, as the HTTP cases below show).
const accepts = (endpoint: { readonly query: Schema.Top | undefined }, paths: string): boolean => {
  const decoded = Schema.decodeUnknownExit(queryOf(endpoint))({ include: paths });
  return (
    Exit.isSuccess(decoded) &&
    // SAFETY: a query codec decodes to a struct.
    Rec.has(decoded.value as Rec.ReadonlyRecord<string, unknown>, "include")
  );
};

const commentIds = [{ type: "comments", id: "5" }];

describe("`getRelationship`'s `?include=` (#439)", () => {
  it("is off by default: no `include` parameter, no `included` member", () => {
    const endpoint = Endpoint.getRelationship(Article, "comments");
    expect(accepts(endpoint, "comments")).toBe(false);
    expect(admitted(endpoint, commentIds)).toEqual([]);
    // Without `included`, the linkage document is exactly what it was.
    expect(
      Schema.decodeUnknownSync(successOf(endpoint))(
        { data: commentIds },
        { onExcessProperty: "error" },
      ),
    ).toEqual({ data: commentIds });
  });

  it("`include: true` legalises the parent's depth-2 paths rooted at the relationship", () => {
    const endpoint = Endpoint.getRelationship(Article, "comments", { include: true });
    expect(accepts(endpoint, "comments")).toBe(true);
    expect(accepts(endpoint, "comments.author")).toBe(true);
    expect(accepts(endpoint, "comments,comments.author")).toBe(true);
    // A parent path rooted at another relationship is a 400…
    expect(accepts(endpoint, "editor")).toBe(false);
    // …as is a path through a `paginated` relationship, or past depth 2.
    expect(accepts(endpoint, "comments.revisions")).toBe(false);
    expect(accepts(endpoint, "comments.author.employer")).toBe(false);
    // Paths are rooted at the parent, not at the target.
    expect(accepts(endpoint, "author")).toBe(false);
    // The document admits what those paths reach: the target and its authors.
    expect(admitted(endpoint, commentIds)).toEqual(["comments", "people"]);
  });

  it("follows the `depth` an include option names, counted from the parent", () => {
    const deep = Endpoint.getRelationship(Article, "comments", { include: { depth: 3 } });
    expect(accepts(deep, "comments.author.employer")).toBe(true);
    expect(admitted(deep, commentIds)).toEqual(["comments", "people", "companies"]);
    const shallow = Endpoint.getRelationship(Article, "comments", { include: { depth: 1 } });
    expect(accepts(shallow, "comments")).toBe(true);
    expect(accepts(shallow, "comments.author")).toBe(false);
    expect(admitted(shallow, commentIds)).toEqual(["comments"]);
  });

  it("takes an explicit `paths` allow-list rooted at the relationship", () => {
    const endpoint = Endpoint.getRelationship(Article, "comments", {
      include: { paths: ["comments.author"] },
    });
    expect(accepts(endpoint, "comments.author")).toBe(true);
    expect(accepts(endpoint, "comments")).toBe(false);
    // `comments.author` reaches the comments on the way to their authors.
    expect(admitted(endpoint, commentIds)).toEqual(["comments", "people"]);
  });

  it("takes a declared surface over the parent, whose own union it binds", () => {
    const surface = Include.make(Article, {
      comments: Include.nested(Comment, { author: Person }),
    });
    const endpoint = Endpoint.getRelationship(Article, "comments", { include: surface });
    expect(accepts(endpoint, "comments.author")).toBe(true);
    expect(accepts(endpoint, "comments.author.employer")).toBe(false);
    expect(admitted(endpoint, commentIds)).toEqual(["comments", "people"]);
  });

  it("refuses an allow-list or a surface naming a path outside the relationship", () => {
    // Compile errors too (`test/relationship-include.types.ts`); erased, they throw.
    expect(() =>
      // SAFETY: deliberately ill-typed, to reach the runtime check.
      Endpoint.getRelationship(Article, "comments", { include: { paths: ["editor"] } } as never),
    ).toThrow(/not rooted at the relationship "comments"/);
    const surface = Include.make(Article, { comments: Comment, editor: Person });
    expect(() =>
      // SAFETY: deliberately ill-typed, to reach the runtime check.
      Endpoint.getRelationship(Article, "comments", { include: surface } as never),
    ).toThrow(/"editor" are not rooted at the relationship "comments"/);
  });

  it("a to-one relationship's document admits its target", () => {
    const endpoint = Endpoint.getRelationship(Article, "editor", { include: true });
    expect(accepts(endpoint, "editor.employer")).toBe(true);
    expect(admitted(endpoint, { type: "people", id: "9" })).toEqual(["people", "companies"]);
  });

  it("a `paginated` relationship is no include path of its parent, so has none", () => {
    const endpoint = Endpoint.getRelationship(Article, "history", { include: true });
    expect(accepts(endpoint, "history")).toBe(false);
    expect(admitted(endpoint, [{ type: "revisions", id: "3" }])).toEqual([]);
  });

  it("keeps the `included` `Assemble.relationship` returns", () => {
    // #439: the endpoint schema used to have no `included`, so encoding
    // dropped it.
    const endpoint = Endpoint.getRelationship(Article, "comments", { include: true });
    const article = {
      type: "articles",
      id: "1",
      attributes: { title: "Hello" },
      relationships: { comments: { data: commentIds } },
    };
    const document = Assemble.relationship({
      parent: article,
      key: "comments",
      included: [wire.comments, wire.people],
    });
    expect(Schema.encodeUnknownSync(successOf(endpoint))(document)).toMatchObject({
      data: commentIds,
      included: [wire.comments, wire.people],
    });
  });
});

describe("a compound relationship document served over HTTP (#439)", () => {
  const Api = HttpApi.make("relationshipInclude").add(
    Group.make(
      Article,
      Endpoint.get(Article),
      Endpoint.getRelationship(Article, "comments", { include: true }),
      Endpoint.getRelationship(Article, "editor"),
    ),
  );

  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada" },
    relationships: { employer: { data: Company.ref(Company.Id.make("2")) } },
  });
  const comment = Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First" },
    relationships: {
      author: { data: Person.ref(person.id) },
      revisions: { links: { related: "/comments/5/revisions" } },
    },
  });

  const article = Article.make({
    id: Article.Id.make("1"),
    attributes: { title: "Hello" },
    relationships: {
      comments: { data: [Comment.ref(comment.id)] },
      editor: { data: Person.ref(person.id) },
      history: { links: { related: "/articles/1/history" } },
    },
  });

  // Every `include` the relationship endpoint was asked for, in order.
  const requested: Array<ReadonlyArray<string> | undefined> = [];

  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("get", () => Effect.succeed(Handlers.data(article)))
      .handle("commentsRelationship", ({ query }) =>
        Effect.sync(() => requested.push(query.include)).pipe(
          Effect.as(
            Handlers.linkage([Comment.ref(comment.id)], {
              included:
                query.include === undefined
                  ? undefined
                  : [
                      ...(Arr.isReadonlyArrayNonEmpty(query.include) ? [comment] : []),
                      ...(query.include.includes("comments.author") ? [person] : []),
                    ],
            }),
          ),
        ),
      )
      .handle("editorRelationship", () => Effect.succeed(Handlers.linkage(Person.ref(person.id)))),
  );

  const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : decodeJson(text) };
  };

  it("answers `include=comments.author` with the comments and their authors", async () => {
    const response = await serve("/articles/1/relationships/comments?include=comments.author");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: commentIds,
      included: [wire.comments, wire.people],
    });
  });

  it("answers a bare `include=` with an empty `included`, and no `include` with none", async () => {
    expect(await serve("/articles/1/relationships/comments?include=")).toEqual({
      status: 200,
      body: { data: commentIds, included: [] },
    });
    expect(await serve("/articles/1/relationships/comments")).toEqual({
      status: 200,
      body: { data: commentIds },
    });
  });

  it("answers a path outside the relationship with a 400 naming the legal ones", async () => {
    const response = await serve("/articles/1/relationships/comments?include=editor");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      errors: [
        {
          status: "400",
          source: { parameter: "include" },
          meta: { includablePaths: ["comments", "comments.author"] },
        },
      ],
    });
  });

  it("still answers `include` with a 400 on an endpoint that does not declare it", async () => {
    const response = await serve("/articles/1/relationships/editor?include=editor");
    expect(response.status).toBe(400);
  });

  it("passes the compound-document rules, which the kit probes it for", async () => {
    // The kit's compound probe asks a relationship endpoint declaring `include`
    // for its own relationship: `?include=comments` (#439).
    requested.length = 0;
    const report = await Effect.runPromise(
      // SAFETY: `ArticlesLive` and `Middleware.layer` provide every service the
      // router needs; the platform services `verify` names are never used.
      Conformance.verify(Api, {
        ids: { articles: "1" },
        only: [
          "spec/document/full-linkage",
          "spec/document/no-duplicate-resources",
          "spec/document/included-on-include",
        ],
      }).pipe(
        Effect.provide(Layer.provideMerge(ArticlesLive, Middleware.layer)),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );
    // `no-duplicate-resources` needs two resource objects in one document to
    // compare, which `?include=comments` (one comment) does not give it, so
    // it may skip; it must not fail on the identifier the member shares.
    expect(report.outcomes.map((outcome) => `${outcome.rule.id}: ${outcome._tag}`)).toEqual([
      "spec/document/full-linkage: Passed",
      expect.stringMatching(/^spec\/document\/no-duplicate-resources: (Passed|Skipped)$/),
      "spec/document/included-on-include: Passed",
    ]);
    expect(requested).toContainEqual(["comments"]);
  });
});
