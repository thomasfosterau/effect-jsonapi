/**
 * The default document of a read endpoint whose `include` option is `true` or
 * a `Query.IncludeOptions` admits in `included` every resource its legal
 * include paths reach (#320), not only the resource's direct targets — so an
 * advertised path such as `comments.author` can be answered.
 *
 * JSON:API 1.1 §Inclusion of Related Resources: "If a server is unable to
 * identify a relationship path or does not support inclusion of resources
 * from a path, it MUST respond with 400 Bad Request." An endpoint whose
 * `include` schema decodes a path supports it, so its document must carry the
 * resources the path brings in.
 *
 * An endpoint with `include` off, or with a declared `Include.Surface`, keeps
 * the union it had. The type-level half is
 * `test/include-depth-included.types.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Archive = Resource.make("archives", { attributes: { label: Schema.String } });
// Paginated: no path crosses `employer` here, at any hop.
const Writer = Resource.make("writers", {
  attributes: { name: Schema.String },
  relationships: { employer: Relationship.paginated(() => Archive) },
});
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String, email: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.String },
  relationships: {
    author: Relationship.one(() => Person),
    // Paginated: never an include path, so `revisions` is reached by none.
    revisions: Relationship.paginated(() => Revision),
  },
});
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    comments: Relationship.many(() => Comment),
    history: Relationship.paginated(() => Revision),
  },
});

// One wire resource object of each type.
const wire = {
  articles: {
    type: "articles",
    id: "1",
    attributes: { title: "Hello" },
    relationships: {
      comments: { data: [{ type: "comments", id: "5" }] },
      history: { links: { related: "/articles/1/history" } },
    },
  },
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
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: { type: "companies", id: "2" } } },
  },
  companies: { type: "companies", id: "2", attributes: { name: "Acme" } },
  revisions: { type: "revisions", id: "3", attributes: { editedAt: "2026-01-01" } },
  writers: {
    type: "writers",
    id: "4",
    attributes: { name: "Grace" },
    relationships: { employer: { links: { related: "/writers/4/employer" } } },
  },
  archives: { type: "archives", id: "6", attributes: { label: "Old" } },
} as const;
type WireType = keyof typeof wire;
const types: ReadonlyArray<WireType> = Rec.keys(wire);

// An endpoint's success document schema, for decoding wire documents.
const successOf = (endpoint: { readonly success: Iterable<Schema.Top> }) =>
  // SAFETY: every endpoint under test declares exactly one success schema, a
  // JSON:API document codec; decoding unknown input is what it is for.
  [...endpoint.success][0] as Schema.Codec<unknown, unknown>;

// The types an endpoint's success document admits in `included`: each type's
// wire object is decoded as the sole `included` member of a document whose
// primary data is `primary` (wrapped in an array for a collection).
const admitted = (
  endpoint: { readonly success: Iterable<Schema.Top> },
  primary: object,
  collection: boolean,
): ReadonlyArray<WireType> => {
  const success = successOf(endpoint);
  return types.filter((type) =>
    Exit.isSuccess(
      Schema.decodeUnknownExit(success)({
        data: collection ? [primary] : primary,
        included: [wire[type]],
      }),
    ),
  );
};

describe("the default `included` union reaches every legal include path (#320)", () => {
  it("`get` with `include: true` admits the depth-2 `comments.author` target", () => {
    expect(admitted(Endpoint.get(Article, { include: true }), wire.articles, false)).toEqual([
      "comments",
      "people",
    ]);
  });

  it("`list` with `include: true` admits the depth-2 `comments.author` target", () => {
    expect(admitted(Endpoint.list(Article, { include: true }), wire.articles, true)).toEqual([
      "comments",
      "people",
    ]);
  });

  it("follows the `depth` an include option names", () => {
    expect(
      admitted(Endpoint.get(Article, { include: { depth: 3 } }), wire.articles, false),
    ).toEqual(["comments", "people", "companies"]);
  });

  it("keeps the direct targets beside an explicit `paths` allow-list", () => {
    // A server MAY include the direct targets by default, so they stay.
    expect(
      admitted(Endpoint.get(Article, { include: { paths: ["comments"] } }), wire.articles, false),
    ).toEqual(["comments"]);
  });

  it("`related` walks the target's graph", () => {
    // Comment's paths: `author`, `author.employer`.
    expect(
      admitted(Endpoint.related(Article, "comments", { include: true }), wire.comments, true),
    ).toEqual(["people", "companies"]);
  });

  it("a to-one `related` walks the target's graph", () => {
    // `parent` is a `Comment`, whose `author.employer` reaches `companies`.
    const Reply = Resource.make("replies", {
      attributes: { body: Schema.String },
      relationships: { parent: Relationship.one(() => Comment) },
    });
    expect(
      admitted(Endpoint.related(Reply, "parent", { include: true }), wire.comments, false),
    ).toEqual(["people", "companies"]);
    // Negative control: without `include`, only the target's direct targets.
    expect(admitted(Endpoint.related(Reply, "parent"), wire.comments, false)).toEqual(["people"]);
  });

  it("`collection` walks every member's graph", () => {
    // Article reaches `comments`, `comments.author`; Person reaches `employer`.
    expect(
      admitted(
        Endpoint.collection([Article, Person], { name: "search", path: "/search", include: true }),
        wire.articles,
        true,
      ),
    ).toEqual(["comments", "people", "companies"]);
  });

  it("`polymorphic` walks every member's graph", () => {
    const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
    const Author = Resource.extend(Node, "authors", {
      inheritId: true,
      relationships: { comments: Relationship.many(() => Comment) },
    });
    const Editor = Resource.extend(Node, "editors", { inheritId: true });
    const AnyNode = Resource.family(Node, [Author, Editor]);
    const primary = { type: "editors", id: "1", attributes: { name: "E" } };
    // Author's paths: `comments`, `comments.author`.
    expect(admitted(Endpoint.polymorphic(AnyNode, { include: true }), primary, false)).toEqual([
      "comments",
      "people",
    ]);
    expect(admitted(Endpoint.polymorphic(AnyNode), primary, false)).toEqual(["comments"]);
    // The depth-2 path comes from a member other than the first.
    const EditorFirst = Resource.family(Node, [Editor, Author]);
    expect(admitted(Endpoint.polymorphic(EditorFirst, { include: true }), primary, false)).toEqual([
      "comments",
      "people",
    ]);
  });

  describe("a target one member reaches only through a paginated relationship", () => {
    // `posts.author` is a to-one `people`, so `author` and `author.employer`
    // are legal paths; `drafts.author` is a paginated `revisions`, which no
    // path may cross, so walking those paths from `drafts` reaches nothing.
    const Entry = Resource.make("entries", { attributes: { title: Schema.String } });
    const Post = Resource.extend(Entry, "posts", {
      inheritId: true,
      relationships: { author: Relationship.one(() => Person) },
    });
    const Draft = Resource.extend(Entry, "drafts", {
      inheritId: true,
      relationships: { author: Relationship.paginated(() => Revision) },
    });
    const post = {
      type: "posts",
      id: "1",
      attributes: { title: "T" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    };

    it("is not admitted by `collection`", () => {
      expect(
        admitted(
          Endpoint.collection([Post, Draft], { name: "entries", path: "/entries", include: true }),
          post,
          true,
        ),
      ).toEqual(["people", "companies"]);
    });

    // The type of `collection`'s `included` agrees (#337,
    // `test/include-depth-included.types.ts`).
    it.each([
      ["without `include`", {}, ["people"]],
      ["with `fields: true`", { fields: true }, ["people"]],
      [
        "with `include: true` and `fields: true`",
        { include: true, fields: true },
        ["people", "companies"],
      ],
    ] as const)("is not admitted by `collection` %s", (_, options, expected) => {
      expect(
        admitted(
          Endpoint.collection([Post, Draft], { name: "entries", path: "/entries", ...options }),
          post,
          true,
        ),
      ).toEqual(expected);
    });

    it("is not admitted by `polymorphic`", () => {
      const postFirst = Resource.family(Entry, [Post, Draft]);
      const draftFirst = Resource.family(Entry, [Draft, Post]);
      expect(admitted(Endpoint.polymorphic(postFirst, { include: true }), post, false)).toEqual([
        "people",
        "companies",
      ]);
      expect(admitted(Endpoint.polymorphic(draftFirst, { include: true }), post, false)).toEqual([
        "people",
        "companies",
      ]);
    });
  });

  describe("a target one member reaches only through a paginated relationship at the second hop", () => {
    // `posts.author` is a to-one `people` and `drafts.author` a to-one
    // `writers`, so `author.employer` is a legal path: from `posts` it reaches
    // `companies`, but `writers.employer` is a paginated `archives`, which no
    // path may cross at any hop.
    const Entry = Resource.make("entries", { attributes: { title: Schema.String } });
    const Post = Resource.extend(Entry, "posts", {
      inheritId: true,
      relationships: { author: Relationship.one(() => Person) },
    });
    const Draft = Resource.extend(Entry, "drafts", {
      inheritId: true,
      relationships: { author: Relationship.one(() => Writer) },
    });
    const post = {
      type: "posts",
      id: "1",
      attributes: { title: "T" },
      relationships: { author: { data: { type: "people", id: "9" } } },
    };

    it("is not admitted by `collection`", () => {
      expect(
        admitted(
          Endpoint.collection([Post, Draft], { name: "entries", path: "/entries", include: true }),
          post,
          true,
        ),
      ).toEqual(["people", "companies", "writers"]);
    });

    it("is not admitted by `polymorphic`", () => {
      const family = Resource.family(Entry, [Post, Draft]);
      expect(admitted(Endpoint.polymorphic(family, { include: true }), post, false)).toEqual([
        "people",
        "companies",
        "writers",
      ]);
    });
  });

  it("`Endpoint.resource` derives the same union for its `get` and `list`", () => {
    const endpoints = Endpoint.resource(Article, { include: true });
    const named = (name: string) =>
      Option.getOrThrow(Arr.findFirst(endpoints, (endpoint) => endpoint.identifier === name));
    expect(admitted(named("get"), wire.articles, false)).toEqual(["comments", "people"]);
    expect(admitted(named("list"), wire.articles, true)).toEqual(["comments", "people"]);
  });
});

describe("an endpoint that turns no include path on keeps its union (#320)", () => {
  it.each([
    ["get", Endpoint.get(Article), false],
    ["get with `include: false`", Endpoint.get(Article, { include: false }), false],
    ["list", Endpoint.list(Article, { fields: true }), true],
  ] as const)("%s admits the direct targets only", (_, endpoint, collection) => {
    expect(admitted(endpoint, wire.articles, collection)).toEqual(["comments"]);
  });

  it("`related` without `include` admits the target's direct targets only", () => {
    expect(admitted(Endpoint.related(Article, "comments"), wire.comments, true)).toEqual([
      "people",
    ]);
  });

  it("`collection` without `include` admits the members' direct targets only", () => {
    expect(
      admitted(
        Endpoint.collection([Article, Person], { name: "search", path: "/search" }),
        wire.articles,
        true,
      ),
    ).toEqual(["comments", "companies"]);
  });

  it("a declared `Include.Surface` keeps its own union", () => {
    const surface = Include.make(Article, { comments: Comment });
    expect(admitted(Endpoint.get(Article, { include: surface }), wire.articles, false)).toEqual([
      "comments",
    ]);
  });

  it("the document is unchanged on the wire", () => {
    // The resource's own `document()`, the default before #320.
    const roundTrip = (endpoint: { readonly success: Iterable<Schema.Top> }) => {
      const success = successOf(endpoint);
      return Schema.encodeUnknownSync(success)(
        Schema.decodeUnknownSync(success)({ data: wire.articles, included: [wire.comments] }),
      );
    };
    expect(roundTrip(Endpoint.get(Article))).toEqual(
      roundTrip(Endpoint.get(Article, { success: Article.document() })),
    );
  });
});

describe("a declared surface on `collection` / `polymorphic` derives their union (#336)", () => {
  // A depth-2 surface: `comments.author` is advertised, so `people` must be
  // admitted; `companies`, a direct target of `Person.employer` the surface
  // never names, is not — the union narrows to what the surface names, as on
  // `get`.
  const surface = Include.make(Article, {
    comments: Include.nested(Comment, { author: Person }),
  });
  const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
  const Author = Resource.extend(Node, "authors", {
    inheritId: true,
    relationships: { comments: Relationship.many(() => Comment) },
  });
  const Editor = Resource.extend(Node, "editors", {
    inheritId: true,
    relationships: { employer: Relationship.one(() => Company) },
  });
  const AnyNode = Resource.family(Node, [Author, Editor]);
  const nodeSurface = Include.make(Author, {
    comments: Include.nested(Comment, { author: Person }),
  });
  const editor = {
    type: "editors",
    id: "1",
    attributes: { name: "E" },
    relationships: { employer: { data: { type: "companies", id: "2" } } },
  };

  it.each([
    ["", {}],
    ["with `fields: true`", { fields: true }],
  ] as const)("`collection` admits exactly the surface's union %s", (_, options) => {
    const search = Endpoint.collection([Article, Person], {
      name: "search",
      path: "/search",
      include: surface,
      ...options,
    });
    expect(admitted(search, wire.articles, true)).toEqual(["comments", "people"]);
  });

  it.each([
    ["", {}],
    ["with `fields: true`", { fields: true }],
  ] as const)("`polymorphic` admits exactly the surface's union %s", (_, options) => {
    expect(
      admitted(Endpoint.polymorphic(AnyNode, { include: nodeSurface, ...options }), editor, false),
    ).toEqual(["comments", "people"]);
  });

  it.each([
    [
      "`collection`",
      Endpoint.collection([Article, Person], {
        name: "search",
        path: "/search",
        include: surface,
        fields: true,
      }),
      [wire.articles],
    ],
    [
      "`polymorphic`",
      Endpoint.polymorphic(AnyNode, { include: nodeSurface, fields: true }),
      editor,
    ],
  ] as const)(
    "%s with `fields: true`: a surface member a fieldset names is partial",
    (_, endpoint, data) => {
      const sparse = { ...wire.people, attributes: { name: "Ada" } };
      expect(
        Exit.isSuccess(Schema.decodeUnknownExit(successOf(endpoint))({ data, included: [sparse] })),
      ).toBe(true);
    },
  );
});

describe("a depth-2 include path answered over HTTP (#320)", () => {
  const Api = HttpApi.make("includeDepthIncluded").add(
    Group.make(
      Article,
      Endpoint.get(Article, { include: true, fields: true }),
      Endpoint.list(Article, { include: true, fields: true }),
    ),
  );

  const comment = Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First" },
    relationships: {
      author: { data: { type: "people", id: Person.Id.make("9") } },
      revisions: { links: { related: "/comments/5/revisions" } },
    },
  });
  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: { type: "companies", id: Company.Id.make("2") } } },
  });
  const article = Article.make({
    id: Article.Id.make("1"),
    attributes: { title: "Hello" },
    relationships: {
      comments: { data: [{ type: "comments", id: Comment.Id.make("5") }] },
      history: { links: { related: "/articles/1/history" } },
    },
  });

  // The handlers return the depth-2 `people` resource the path brings in: a
  // compile error before #320, and a 500 when forced. They project the
  // requested fieldsets, which the default document admits (#322).
  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("get", ({ query }) =>
        Effect.succeed(
          Handlers.data(article, {
            included: [comment, person],
            onResource: Handlers.project(query.fields),
          }),
        ),
      )
      .handle("list", ({ query }) =>
        Effect.succeed(
          Handlers.collection([article], {
            included: [comment, person],
            onResource: Handlers.project(query.fields),
          }),
        ),
      ),
  );
  // `fields[people]=name` omits `email` (§Sparse Fieldsets, #322).
  const projectedPerson = { ...wire.people, attributes: { name: "Ada" } };

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

  it("`get` answers `include=comments.author` with the people it reaches", async () => {
    const response = await serve("/articles/1?include=comments.author&fields[people]=name");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: wire.articles,
      included: [wire.comments, projectedPerson],
    });
  });

  it("`list` answers `include=comments.author` with the people it reaches", async () => {
    const response = await serve("/articles?include=comments.author&fields[people]=name");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [wire.articles],
      included: [wire.comments, projectedPerson],
    });
  });
});
