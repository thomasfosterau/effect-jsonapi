/**
 * Compound relationship documents (#439): `Endpoint.getRelationship` with
 * `include` accepts `?include=` and serves `included` beside the linkage —
 * and, with `fields` (#485), `?fields[TYPE]=` narrows those members.
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
 *
 * §Sparse Fieldsets "applies to any endpoint that responds with resources as
 * primary or included data". A relationship document's primary data is
 * resource identifiers, which have no fields, so a fieldset narrows only its
 * `included` members, and the types it can name are those the include paths
 * reach — never the parent's own, which the document does not carry.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
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
import { unlinkedIncluded } from "./internal/linkage.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
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
  // Two attributes, so a sparse fieldset has one to leave out.
  attributes: { body: Schema.String, postedAt: Schema.String },
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
    attributes: { body: "First", postedAt: "2026-01-01" },
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

  it("a `paginated` relationship's own name is legal on its relationship endpoint (#483)", () => {
    // Never an include path of the parent's own read…
    expect(accepts(Endpoint.get(Article, { include: true }), "history")).toBe(false);
    // …but here its linkage is the primary data, so it can be included.
    const endpoint = Endpoint.getRelationship(Article, "history", { include: true });
    expect(accepts(endpoint, "history")).toBe(true);
    expect(admitted(endpoint, [{ type: "revisions", id: "3" }])).toEqual(["revisions"]);
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

// An attribute of each type of the graph, the parent's included.
const firstAttribute = {
  articles: "title",
  comments: "body",
  people: "name",
  companies: "name",
  revisions: "editedAt",
};

// The `fields[TYPE]` parameters, among every type of the graph, an
// endpoint's query decodes into a `fields` member (one it does not declare is
// dropped; `Middleware` answers it with a 400, as the HTTP cases below show).
const fieldsets = (endpoint: Parameters<typeof queryOf>[0]): ReadonlyArray<string> =>
  Rec.toEntries(firstAttribute)
    .filter(([type, attribute]) => {
      const decoded = Schema.decodeUnknownExit(queryOf(endpoint))({
        [`fields[${type}]`]: attribute,
      });
      return (
        Exit.isSuccess(decoded) &&
        Predicate.hasProperty(decoded.value, "fields") &&
        Predicate.hasProperty(decoded.value.fields, type)
      );
    })
    .map(([type]) => `fields[${type}]`)
    .toSorted();

// A wire resource object with only the named attributes.
const narrowed = <T extends { readonly attributes: Rec.ReadonlyRecord<string, unknown> }>(
  resource: T,
  ...names: ReadonlyArray<string>
) => ({
  ...resource,
  attributes: Rec.filter(resource.attributes, (_, key) => names.includes(key)),
});

describe("`getRelationship`'s `fields` (#485)", () => {
  it("declares a fieldset for each type the include paths reach, and no other", () => {
    // Not `articles`: the parent is no resource object of this document.
    // Not `companies`: past depth 2. Not `revisions`: behind `paginated`.
    const endpoint = Endpoint.getRelationship(Article, "comments", {
      include: true,
      fields: true,
    });
    expect(fieldsets(endpoint)).toEqual(["fields[comments]", "fields[people]"]);
    // Positive control: the parent's own read declares its type.
    expect(fieldsets(Endpoint.get(Article, { fields: true }))).toContain("fields[articles]");
    const decoded = Schema.decodeUnknownSync(queryOf(endpoint))({
      include: "comments.author",
      "fields[comments]": "body",
      "fields[people]": "name",
    });
    expect(decoded).toEqual({
      include: ["comments.author"],
      fields: { comments: ["body"], people: ["name"] },
    });
  });

  it("follows the include option: `depth`, an allow-list, a surface, a to-one", () => {
    expect(
      fieldsets(
        Endpoint.getRelationship(Article, "comments", { include: { depth: 3 }, fields: true }),
      ),
    ).toEqual(["fields[comments]", "fields[companies]", "fields[people]"]);
    expect(
      fieldsets(
        Endpoint.getRelationship(Article, "comments", { include: { depth: 1 }, fields: true }),
      ),
    ).toEqual(["fields[comments]"]);
    expect(
      fieldsets(
        Endpoint.getRelationship(Article, "comments", {
          include: { paths: ["comments"] },
          fields: true,
        }),
      ),
    ).toEqual(["fields[comments]"]);
    const surface = Include.make(Article, {
      comments: Include.nested(Comment, { author: Person }),
    });
    expect(
      fieldsets(Endpoint.getRelationship(Article, "comments", { include: surface, fields: true })),
    ).toEqual(["fields[comments]", "fields[people]"]);
    expect(
      fieldsets(Endpoint.getRelationship(Article, "editor", { include: true, fields: true })),
    ).toEqual(["fields[companies]", "fields[people]"]);
  });

  it("declares none without `include`", () => {
    // Nothing can be included, so no resource object has fields to narrow.
    expect(fieldsets(Endpoint.getRelationship(Article, "comments", { fields: true }))).toEqual([]);
    expect(fieldsets(Endpoint.getRelationship(Article, "comments", { include: true }))).toEqual([]);
  });

  it("declares the types a `paginated` relationship's paths reach (#483)", () => {
    expect(
      fieldsets(Endpoint.getRelationship(Article, "history", { include: true, fields: true })),
    ).toEqual(["fields[revisions]"]);
  });

  it("admits `included` members missing attributes, and leaves the identifiers alone", () => {
    const sparse = Endpoint.getRelationship(Article, "comments", { include: true, fields: true });
    const strict = Endpoint.getRelationship(Article, "comments", { include: true });
    const document = { data: commentIds, included: [narrowed(wire.comments, "body")] };
    expect(Exit.isSuccess(Schema.decodeUnknownExit(successOf(sparse))(document))).toBe(true);
    expect(Exit.isSuccess(Schema.decodeUnknownExit(successOf(strict))(document))).toBe(false);
    // The union is unchanged otherwise: the same types, and still none
    // without `include`.
    expect(admitted(sparse, commentIds)).toEqual(["comments", "people"]);
    expect(
      admitted(Endpoint.getRelationship(Article, "comments", { fields: true }), commentIds),
    ).toEqual([]);
  });

  it("`Assemble.relationship` applies `fields` to the `included` members only", () => {
    const endpoint = Endpoint.getRelationship(Article, "comments", { include: true, fields: true });
    const document = Assemble.relationship({
      parent: {
        type: "articles",
        id: "1",
        attributes: { title: "Hello" },
        relationships: { comments: { data: commentIds } },
      },
      key: "comments",
      included: [wire.comments, wire.people],
      fields: { comments: ["body"], articles: [] },
    });
    expect(Schema.encodeUnknownSync(successOf(endpoint))(document)).toMatchObject({
      data: commentIds,
      included: [narrowed(wire.comments, "body"), wire.people],
    });
  });
});

describe("a compound relationship document served over HTTP (#439)", () => {
  const Api = HttpApi.make("relationshipInclude").add(
    Group.make(
      Article,
      Endpoint.get(Article),
      Endpoint.getRelationship(Article, "comments", { include: true, fields: true }),
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
    attributes: { body: "First", postedAt: "2026-01-01" },
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
  // Every fieldset it was asked for, in order (#485).
  const requestedFields: Array<Handlers.Fields> = [];

  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("get", () => Effect.succeed(Handlers.data(article)))
      .handle("commentsRelationship", ({ query }) =>
        Effect.sync(() => {
          requested.push(query.include);
          if (query.fields !== undefined) requestedFields.push(query.fields);
        }).pipe(
          Effect.as(
            Handlers.linkage([Comment.ref(comment.id)], {
              included:
                query.include === undefined
                  ? undefined
                  : [
                      ...(Arr.isReadonlyArrayNonEmpty(query.include) ? [comment] : []),
                      ...(query.include.includes("comments.author") ? [person] : []),
                    ],
              onResource: Handlers.project(query.fields),
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

  // The kit's verdicts on the rules `only` names, run against this api.
  const verify = (only: ReadonlyArray<string>) =>
    Effect.runPromise(
      // SAFETY: `ArticlesLive` and `Middleware.layer` provide every service the
      // router needs; the platform services `verify` names are never used.
      Conformance.verify(Api, { ids: { articles: "1" }, only }).pipe(
        Effect.provide(Layer.provideMerge(ArticlesLive, Middleware.layer)),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );

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
    const report = await verify([
      "spec/document/full-linkage",
      "spec/document/no-duplicate-resources",
      "spec/document/included-on-include",
    ]);
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

  it("answers `fields[comments]` by narrowing the included comments alone (#485)", async () => {
    const response = await serve(
      "/articles/1/relationships/comments?include=comments.author&fields[comments]=body",
    );
    expect(response).toEqual({
      status: 200,
      body: { data: commentIds, included: [narrowed(wire.comments, "body"), wire.people] },
    });
  });

  it("answers a fieldset for the parent's type with a 400 (#485)", async () => {
    // The parent is no resource object of a relationship document.
    const response = await serve("/articles/1/relationships/comments?fields[articles]=title");
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      errors: [{ status: "400", source: { parameter: "fields[articles]" } }],
    });
  });

  it("passes the sparse-fieldset rule on its `included` members, which the kit probes it for", async () => {
    // #485: the only endpoint declaring `fields`, so the rule can only be
    // judged here: `?include=comments&fields[comments]=body`.
    requestedFields.length = 0;
    const report = await verify([
      "spec/query/sparse-fieldsets-primary",
      "spec/query/sparse-fieldsets-included",
    ]);
    // Its primary data is identifiers, which carry no attributes to project.
    expect(report.outcomes.map((outcome) => `${outcome.rule.id}: ${outcome._tag}`)).toEqual([
      "spec/query/sparse-fieldsets-primary: Skipped",
      "spec/query/sparse-fieldsets-included: Passed",
    ]);
    expect(requestedFields).toContainEqual({ comments: ["body"] });
  });
});

// #483: on a `paginated` relationship's own endpoint, its name and the paths
// rooted at it are legal, as on a `many`. A thread's comments are paginated;
// the comments themselves are those of the article above.
const Thread = Resource.make("threads", {
  attributes: { subject: Schema.String },
  relationships: { comments: Relationship.paginated(() => Comment) },
});
// The wire comment `wire.comments` is, under another id.
const wireComment = (id: string) => ({
  ...wire.comments,
  id,
  relationships: {
    ...wire.comments.relationships,
    revisions: { links: { related: `/comments/${id}/revisions` } },
  },
});
const threadComments = [
  { type: "comments", id: "5" },
  { type: "comments", id: "6" },
];

describe("`getRelationship`'s `?include=` on a `paginated` relationship (#483)", () => {
  it("`include: true` legalises the name and the depth-2 paths rooted at it", () => {
    const endpoint = Endpoint.getRelationship(Thread, "comments", { include: true });
    expect(accepts(endpoint, "comments")).toBe(true);
    expect(accepts(endpoint, "comments.author")).toBe(true);
    // A `paginated` relationship further along is still never crossed, and
    // depth is still counted from the parent.
    expect(accepts(endpoint, "comments.revisions")).toBe(false);
    expect(accepts(endpoint, "comments.author.employer")).toBe(false);
    expect(admitted(endpoint, threadComments)).toEqual(["comments", "people"]);
    // The parent's own read still has no path through it.
    expect(accepts(Endpoint.get(Thread, { include: true }), "comments")).toBe(false);
  });

  it("follows `depth` and an explicit `paths` allow-list, as on a `many`", () => {
    const deep = Endpoint.getRelationship(Thread, "comments", { include: { depth: 3 } });
    expect(accepts(deep, "comments.author.employer")).toBe(true);
    expect(admitted(deep, threadComments)).toEqual(["comments", "people", "companies"]);
    const shallow = Endpoint.getRelationship(Thread, "comments", { include: { depth: 1 } });
    expect(accepts(shallow, "comments")).toBe(true);
    expect(accepts(shallow, "comments.author")).toBe(false);
    expect(admitted(shallow, threadComments)).toEqual(["comments"]);
    const listed = Endpoint.getRelationship(Thread, "comments", {
      include: { paths: ["comments.author"] },
    });
    expect(accepts(listed, "comments.author")).toBe(true);
    expect(accepts(listed, "comments")).toBe(false);
    expect(admitted(listed, threadComments)).toEqual(["comments", "people"]);
    expect(() =>
      // SAFETY: deliberately ill-typed, to reach the runtime check.
      Endpoint.getRelationship(Thread, "comments", { include: { paths: ["subject"] } } as never),
    ).toThrow(/not rooted at the relationship "comments" of "threads"/);
  });

  it("declares a fieldset for each type the paths reach", () => {
    const endpoint = Endpoint.getRelationship(Thread, "comments", { include: true, fields: true });
    expect(fieldsets(endpoint)).toEqual(["fields[comments]", "fields[people]"]);
    expect(
      Schema.decodeUnknownSync(queryOf(endpoint))({
        include: "comments.author",
        "fields[people]": "name",
      }),
    ).toEqual({ include: ["comments.author"], fields: { people: ["name"] } });
  });

  it("checks full linkage against the page of identifiers, not the whole relationship", () => {
    // `included` is seeded from the primary data, which is the current page:
    // a comment on another page is unreachable from it.
    const page = [Comment.ref(Comment.Id.make("5"))];
    expect(Handlers.linkage(page, { included: [wire.comments] }).included).toEqual([wire.comments]);
    const offPage = wireComment("6");
    expect(() => Handlers.linkage(page, { included: [offPage] })).toThrow();
    // `Assemble.relationship` reads the linkage off the parent, which for a
    // `paginated` relationship carries none: hand it the page.
    const thread = {
      type: "threads",
      id: "1",
      attributes: { subject: "Hello" },
      relationships: { comments: { data: page, links: { related: "/threads/1/comments" } } },
    };
    const document = Assemble.relationship({
      parent: thread,
      key: "comments",
      included: [wire.comments],
    });
    expect(document.data).toEqual(page);
    expect(unlinkedIncluded({ ...document })).toEqual([]);
    expect(
      unlinkedIncluded({
        ...Assemble.relationship({ parent: thread, key: "comments", included: [offPage] }),
      }),
    ).toHaveLength(1);
  });
});

describe("a paginated compound relationship document served over HTTP (#483)", () => {
  const Api = HttpApi.make("paginatedRelationshipInclude").add(
    Group.make(
      Thread,
      Endpoint.get(Thread),
      Endpoint.getRelationship(Thread, "comments", {
        include: true,
        fields: true,
        page: Query.Page.Offset,
      }),
    ),
  );

  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada" },
    relationships: { employer: { data: Company.ref(Company.Id.make("2")) } },
  });
  const comments = ["5", "6"].map((id) =>
    Comment.make({
      id: Comment.Id.make(id),
      attributes: { body: "First", postedAt: "2026-01-01" },
      relationships: {
        author: { data: Person.ref(person.id) },
        revisions: { links: { related: `/comments/${id}/revisions` } },
      },
    }),
  );
  const thread = Thread.make({
    id: Thread.Id.make("1"),
    attributes: { subject: "Hello" },
    relationships: {
      comments: {
        links: {
          self: "/threads/1/relationships/comments",
          related: "/threads/1/comments",
        },
      },
    },
  });

  const ThreadsLive = HttpApiBuilder.group(Api, "threads", (handlers) =>
    handlers
      .handle("get", () => Effect.succeed(Handlers.data(thread)))
      .handle("commentsRelationship", ({ query }) => {
        // The page of linkage, and — for `?include=` — the comments on it
        // (and their authors), never the whole relationship.
        const offset = query.page?.offset ?? 0;
        const page = comments.slice(offset, offset + (query.page?.limit ?? comments.length));
        const include = query.include;
        return Effect.succeed(
          Handlers.linkage(
            page.map((comment) => Comment.ref(comment.id)),
            {
              included:
                include === undefined
                  ? undefined
                  : [
                      ...(include.includes("comments") ? page : []),
                      ...(include.includes("comments.author") ? [...page, person] : []),
                    ],
              onResource: Handlers.project(query.fields),
            },
          ),
        );
      }),
  );

  const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
  const serve = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ThreadsLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : decodeJson(text) };
  };

  it("answers `include=comments.author` with the page's comments and their authors", async () => {
    const response = await serve(
      "/threads/1/relationships/comments?include=comments.author&page[limit]=1",
    );
    expect(response).toEqual({
      status: 200,
      body: { data: [threadComments[0]], included: [wire.comments, wire.people] },
    });
    const second = await serve(
      "/threads/1/relationships/comments?include=comments&page[offset]=1&page[limit]=1",
    );
    expect(second).toEqual({
      status: 200,
      body: { data: [threadComments[1]], included: [wireComment("6")] },
    });
  });

  it("narrows the included members with `fields`", async () => {
    const response = await serve(
      "/threads/1/relationships/comments?include=comments&fields[comments]=body&page[limit]=1",
    );
    expect(response).toEqual({
      status: 200,
      body: { data: [threadComments[0]], included: [narrowed(wire.comments, "body")] },
    });
    // An empty fieldset asks for no attributes (#488).
    const empty = await serve(
      "/threads/1/relationships/comments?include=comments&fields[comments]=&page[limit]=1",
    );
    expect(empty).toEqual({
      status: 200,
      body: { data: [threadComments[0]], included: [narrowed(wire.comments)] },
    });
  });

  it("answers a path outside the relationship with a 400 naming the legal ones", async () => {
    const response = await serve("/threads/1/relationships/comments?include=comments.revisions");
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

  it("passes the compound-document rules, which the kit probes it for", async () => {
    const report = await Effect.runPromise(
      // SAFETY: `ThreadsLive` and `Middleware.layer` provide every service the
      // router needs; the platform services `verify` names are never used.
      Conformance.verify(Api, {
        ids: { threads: "1" },
        only: ["spec/document/full-linkage", "spec/document/included-on-include"],
      }).pipe(
        Effect.provide(Layer.provideMerge(ThreadsLive, Middleware.layer)),
        Effect.scoped,
      ) as Effect.Effect<Conformance.Report, never, never>,
    );
    expect(report.outcomes.map((outcome) => `${outcome.rule.id}: ${outcome._tag}`)).toEqual([
      "spec/document/full-linkage: Passed",
      "spec/document/included-on-include: Passed",
    ]);
  });
});
