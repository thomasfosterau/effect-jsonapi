/**
 * A read endpoint that declares `fields` binds, by default, a document whose
 * resource objects admit any subset of their attributes (#322): the primary
 * data and every `included` member of a type `?fields[TYPE]=` can name — the
 * set `Query.FieldsetResources` computes.
 *
 * JSON:API 1.1 §Sparse Fieldsets: "If a client requests a restricted set of
 * fields for a given resource type, an endpoint MUST NOT include additional
 * fields in resource objects of that type in its response." So a handler that
 * answers with `Handlers.project(query.fields)` must encode, and a client must
 * decode the projected document.
 *
 * An endpoint without `fields` keeps exactly the document it had. The
 * type-level half is `test/sparse-default.types.ts`.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiClient, OpenApi } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.String, email: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Tag = Resource.make("tags", { attributes: { name: Schema.String, colour: Schema.String } });
const Article = Resource.make("articles", {
  attributes: {
    title: Schema.String,
    body: Schema.String,
    // Already optional: stays exactly as declared.
    subtitle: Schema.optionalKey(Schema.String),
  },
  relationships: {
    author: Relationship.one(() => Person),
    tags: Relationship.many(() => Tag),
  },
});
const Node = Resource.make("nodes", { attributes: { name: Schema.String, note: Schema.String } });
const Editor = Resource.extend(Node, "editors", { inheritId: true });
const Reviewer = Resource.extend(Node, "reviewers", { inheritId: true });
const AnyNode = Resource.family(Node, [Editor, Reviewer]);
// A relationship targeting the family: its `included` members are the
// family's members, each under its own type (#350).
const Holder = Resource.make("holders", {
  attributes: { label: Schema.String },
  relationships: { node: Relationship.one(() => AnyNode) },
});

// One wire resource object of each type, every attribute present.
const wire = {
  articles: {
    type: "articles",
    id: "1",
    attributes: { title: "Hello", body: "World" },
    relationships: {
      author: { data: { type: "people", id: "9" } },
      tags: { data: [{ type: "tags", id: "3" }] },
    },
  },
  people: {
    type: "people",
    id: "9",
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: { type: "companies", id: "2" } } },
  },
  tags: { type: "tags", id: "3", attributes: { name: "news", colour: "red" } },
  companies: { type: "companies", id: "2", attributes: { name: "Acme" } },
  editors: { type: "editors", id: "7", attributes: { name: "Eve", note: "lead" } },
  holders: {
    type: "holders",
    id: "1",
    attributes: { label: "L" },
    relationships: { node: { data: { type: "editors", id: "7" } } },
  },
} as const;

// A wire resource object with only the named attributes.
const only = <O extends { readonly attributes: Readonly<Record<string, unknown>> }>(
  object: O,
  ...names: ReadonlyArray<keyof O["attributes"] & string>
) => ({
  ...object,
  attributes: Rec.fromEntries(names.map((name) => [name, object.attributes[name]] as const)),
});

// An endpoint's success document schema, for decoding wire documents.
const successOf = (endpoint: { readonly success: Iterable<Schema.Top> }) =>
  // SAFETY: every endpoint under test declares exactly one success schema, a
  // JSON:API document codec; decoding unknown input is what it is for.
  [...endpoint.success][0] as Schema.Codec<unknown, unknown>;

// A wire resource object or document, as a client receives it.
type Wire = Readonly<Record<string, unknown>>;

// Whether an endpoint's success document decodes `document`.
const decodes = (endpoint: { readonly success: Iterable<Schema.Top> }, document: Wire) =>
  Exit.isSuccess(Schema.decodeUnknownExit(successOf(endpoint))(document));

// Whether the document admits `primary` (wrapped in an array for a collection)
// and the `included` members.
const admitsPartial = (
  endpoint: { readonly success: Iterable<Schema.Top> },
  primary: Wire,
  collection: boolean,
  included: ReadonlyArray<Wire> = [],
) => decodes(endpoint, { data: collection ? [primary] : primary, included });

describe("the default document of an endpoint declaring `fields` is partial (#322)", () => {
  const partialArticle = only(wire.articles, "title");
  const partialPerson = only(wire.people, "name");

  it.each([
    ["get", Endpoint.get(Article, { fields: true }), false],
    ["get with `include`", Endpoint.get(Article, { include: true, fields: true }), false],
    ["list", Endpoint.list(Article, { fields: true }), true],
    ["list with `include`", Endpoint.list(Article, { include: true, fields: true }), true],
  ] as const)("%s admits a partial primary resource and `included` member", (_, endpoint, many) => {
    expect(admitsPartial(endpoint, partialArticle, many, [partialPerson])).toBe(true);
    // Every attribute present still decodes.
    expect(admitsPartial(endpoint, wire.articles, many, [wire.people])).toBe(true);
  });

  it("a declared `Include.Surface` makes its own union partial", () => {
    const surface = Include.make(Article, {
      author: Include.nested(Person, { employer: Company }),
    });
    const endpoint = Endpoint.get(Article, { include: surface, fields: true });
    expect(
      admitsPartial(endpoint, partialArticle, false, [partialPerson, only(wire.companies)]),
    ).toBe(true);
    // The surface still decides the members: `tags` is not one of them.
    expect(admitsPartial(endpoint, partialArticle, false, [wire.tags])).toBe(false);
  });

  it("`related` makes the target and its `included` partial", () => {
    expect(
      admitsPartial(
        Endpoint.related(Article, "author", { include: true, fields: true }),
        partialPerson,
        false,
        [only(wire.companies)],
      ),
    ).toBe(true);
    expect(decodes(Endpoint.related(Article, "author", { fields: true }), { data: null })).toBe(
      true,
    );
    expect(
      admitsPartial(
        Endpoint.related(Article, "tags", { fields: true }),
        only(wire.tags, "name"),
        true,
      ),
    ).toBe(true);
  });

  it("`collection` makes every member and its `included` partial", () => {
    const endpoint = Endpoint.collection([Article, Person], {
      name: "search",
      path: "/search",
      fields: true,
    });
    expect(decodes(endpoint, { data: [partialArticle, partialPerson], included: [] })).toBe(true);
    expect(admitsPartial(endpoint, partialArticle, true, [only(wire.companies)])).toBe(true);
  });

  it("`polymorphic` makes every family member partial", () => {
    expect(
      admitsPartial(Endpoint.polymorphic(AnyNode, { fields: true }), only(wire.editors), false),
    ).toBe(true);
  });

  it("`polymorphic` with `include` makes a member reached at depth 2 partial", () => {
    // `editors.author` is a `people`, whose `employer` is a `companies`: the
    // `author.employer` path reaches it, beyond the members' direct targets.
    const Owned = Resource.make("owned", {
      attributes: { name: Schema.String },
      relationships: { author: Relationship.one(() => Person) },
    });
    const Draft = Resource.extend(Owned, "drafts", { inheritId: true });
    const Memo = Resource.extend(Owned, "memos", { inheritId: true });
    const endpoint = Endpoint.polymorphic(Resource.family(Owned, [Draft, Memo]), {
      include: true,
      fields: true,
    });
    const draft = {
      type: "drafts",
      id: "5",
      attributes: {},
      relationships: { author: { data: { type: "people", id: "9" } } },
    };
    expect(admitsPartial(endpoint, draft, false, [partialPerson, only(wire.companies)])).toBe(true);
    expect(admitsPartial(endpoint, draft, false, [wire.companies])).toBe(true);
  });

  describe("a family reached as a relationship target is partial through its members (#350)", () => {
    // `holders.node` targets the `nodes` family. `nodes` is a family name,
    // never a wire type: the `included` members are `editors` and
    // `reviewers`, which `fields: true` declares, so they are partial.
    const holder = only(wire.holders);
    const reviewer = { type: "reviewers", id: "8", attributes: { name: "Rue", note: "second" } };

    it.each([
      ["get", Endpoint.get(Holder, { fields: true }), false],
      ["get with `include`", Endpoint.get(Holder, { include: true, fields: true }), false],
      ["list", Endpoint.list(Holder, { fields: true }), true],
    ] as const)("%s", (_, endpoint, many) => {
      // Whole members still decode.
      expect(admitsPartial(endpoint, holder, many, [wire.editors, reviewer])).toBe(true);
      // Every member is partial…
      expect(
        admitsPartial(endpoint, holder, many, [only(wire.editors, "name"), only(reviewer)]),
      ).toBe(true);
      // …and still decodes as itself, `type` and `id` intact.
      const decoded = Schema.decodeUnknownSync(successOf(endpoint))({
        data: many ? [holder] : holder,
        included: [only(wire.editors, "note")],
      });
      expect(decoded).toMatchObject({
        included: [{ type: "editors", id: "7", attributes: { note: "lead" } }],
      });
      // A type outside the family is still no member.
      expect(admitsPartial(endpoint, holder, many, [only(wire.tags)])).toBe(false);
    });

    it("`related` makes the family target partial", () => {
      const endpoint = Endpoint.related(Holder, "node", { fields: true });
      expect(admitsPartial(endpoint, only(wire.editors, "note"), false)).toBe(true);
      expect(admitsPartial(endpoint, only(reviewer), false)).toBe(true);
      expect(decodes(endpoint, { data: null })).toBe(true);
    });

    it("without `fields` the members stay strict", () => {
      expect(admitsPartial(Endpoint.get(Holder), wire.holders, false, [wire.editors])).toBe(true);
      expect(
        admitsPartial(Endpoint.get(Holder), wire.holders, false, [only(wire.editors, "name")]),
      ).toBe(false);
      expect(admitsPartial(Endpoint.related(Holder, "node"), only(wire.editors), false)).toBe(
        false,
      );
    });
  });

  describe("keeps the resource's typed document `meta`", () => {
    const Counted = Resource.make("counted", {
      attributes: { name: Schema.String },
      meta: Schema.Struct({ revision: Schema.Number }),
    });
    const counted = { type: "counted", id: "1", attributes: {} };

    it.each([
      ["get", Endpoint.get(Counted, { fields: true }), false],
      ["get with `include`", Endpoint.get(Counted, { include: true, fields: true }), false],
      ["list", Endpoint.list(Counted, { fields: true }), true],
    ] as const)("%s", (_, endpoint, many) => {
      const data = many ? [counted] : counted;
      expect(decodes(endpoint, { data, meta: { revision: 3 } })).toBe(true);
      expect(decodes(endpoint, { data, meta: { revision: "3" } })).toBe(false);
    });
  });

  it("`Endpoint.resource` / `Group.resource` default `fields` on, so their reads are partial", () => {
    // Whether the generated endpoint `name` admits the partial resources.
    const admits = (
      endpoints: ReadonlyArray<{
        readonly identifier: string;
        readonly success: Iterable<Schema.Top>;
      }>,
      name: string,
      primary: Wire,
      collection: boolean,
    ) =>
      Arr.filter(endpoints, (endpoint) => endpoint.identifier === name).map((endpoint) =>
        admitsPartial(endpoint, primary, collection, collection ? [partialPerson] : []),
      );
    const endpoints = Endpoint.resource(Article);
    expect(admits(endpoints, "get", partialArticle, false)).toEqual([true]);
    expect(admits(endpoints, "list", partialArticle, true)).toEqual([true]);
    expect(admits(endpoints, "author", partialPerson, false)).toEqual([true]);
    // The write documents are not read endpoints: they stay strict.
    expect(admits(endpoints, "create", partialArticle, false)).toEqual([false]);
    expect(admits(endpoints, "update", partialArticle, false)).toEqual([false]);
    // `fields: false` keeps the reads strict.
    const strict = Endpoint.resource(Article, { fields: false });
    expect(admits(strict, "get", partialArticle, false)).toEqual([false]);
    expect(admits(strict, "list", partialArticle, true)).toEqual([false]);
    expect(admits(strict, "author", partialPerson, false)).toEqual([false]);
  });

  describe("a type one member reaches only through a paginated relationship (#320)", () => {
    // `posts.author` is a to-one `people`, so `author` is a legal path;
    // `drafts.author` is a paginated `revisions`, which no path may cross. So
    // `revisions` is neither an `included` member nor a `fields[TYPE]` type:
    // the partial set follows `Query.FieldsetResources`, which stops there.
    const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
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
    const revision = { type: "revisions", id: "4", attributes: { editedAt: "2026-01-01" } };

    it.each([
      [
        "collection",
        Endpoint.collection([Post, Draft], {
          name: "entries",
          path: "/entries",
          include: true,
          fields: true,
        }),
        true,
      ],
      [
        "polymorphic",
        Endpoint.polymorphic(Resource.family(Entry, [Post, Draft]), {
          include: true,
          fields: true,
        }),
        false,
      ],
      [
        "polymorphic, the paginated member first",
        Endpoint.polymorphic(Resource.family(Entry, [Draft, Post]), {
          include: true,
          fields: true,
        }),
        false,
      ],
    ] as const)("`%s` neither admits it nor makes it partial", (_, endpoint, many) => {
      // Positive control: the member reached through the to-one is partial.
      expect(admitsPartial(endpoint, only(post), many, [partialPerson, only(wire.companies)])).toBe(
        true,
      );
      expect(admitsPartial(endpoint, only(post), many, [revision])).toBe(false);
      expect(admitsPartial(endpoint, only(post), many, [only(revision)])).toBe(false);
    });
  });

  it("leaves everything but `attributes` as declared", () => {
    const endpoint = Endpoint.get(Article, { fields: true });
    // `type`, `id` and the relationship linkage are still checked.
    expect(admitsPartial(endpoint, { ...partialArticle, id: 1 }, false)).toBe(false);
    expect(
      admitsPartial(
        endpoint,
        { ...partialArticle, relationships: { author: { data: { type: "tags", id: "3" } } } },
        false,
      ),
    ).toBe(false);
    // An attribute's own schema still applies when it is present.
    expect(admitsPartial(endpoint, { ...partialArticle, attributes: { title: 1 } }, false)).toBe(
      false,
    );
  });
});

describe("an endpoint without `fields` keeps its document (#322)", () => {
  const partialArticle = only(wire.articles, "title");

  it.each([
    ["get", Endpoint.get(Article), false],
    ["get with `fields: false`", Endpoint.get(Article, { include: true, fields: false }), false],
    ["list", Endpoint.list(Article, { include: true }), true],
    [
      "strict `success` override",
      Endpoint.get(Article, { fields: true, success: Article.document() }),
      false,
    ],
  ] as const)("%s rejects a partial primary resource", (_, endpoint, many) => {
    expect(admitsPartial(endpoint, partialArticle, many)).toBe(false);
    expect(admitsPartial(endpoint, wire.articles, many)).toBe(true);
  });

  it("`related`, `collection` and `polymorphic` reject partial resources", () => {
    expect(
      admitsPartial(Endpoint.related(Article, "author"), only(wire.people, "name"), false),
    ).toBe(false);
    expect(
      admitsPartial(
        Endpoint.collection([Article, Person], { name: "search", path: "/search" }),
        partialArticle,
        true,
      ),
    ).toBe(false);
    expect(admitsPartial(Endpoint.polymorphic(AnyNode), only(wire.editors), false)).toBe(false);
  });

  it("renders the same OpenAPI document with `fields: false` as with the strict document", () => {
    const strict = OpenApi.fromApi(
      HttpApi.make("strict").add(
        Group.make(
          Article,
          Endpoint.get(Article, { success: Article.document() }),
          Endpoint.list(Article, { sort: true, success: Article.collection() }),
        ),
      ),
    );
    const off = OpenApi.fromApi(
      HttpApi.make("strict").add(
        Group.make(
          Article,
          Endpoint.get(Article, { fields: false }),
          Endpoint.list(Article, { sort: true, fields: false }),
        ),
      ),
    );
    const absent = OpenApi.fromApi(
      HttpApi.make("strict").add(
        Group.make(Article, Endpoint.get(Article), Endpoint.list(Article, { sort: true })),
      ),
    );
    expect(off).toEqual(strict);
    expect(absent).toEqual(strict);
    // Negative control: `fields: true` renders a different document.
    const partial = OpenApi.fromApi(
      HttpApi.make("strict").add(
        Group.make(
          Article,
          Endpoint.get(Article, { fields: true }),
          Endpoint.list(Article, { sort: true }),
        ),
      ),
    );
    expect(partial).not.toEqual(strict);
  });
});

describe("a projected answer over HTTP (#322)", () => {
  const Api = HttpApi.make("sparseDefault")
    .add(
      Group.make(
        Article,
        Endpoint.get(Article, { include: true, fields: true }),
        Endpoint.list(Article, { include: true, fields: true }),
        Endpoint.related(Article, "author", { include: true, fields: true }),
        Endpoint.related(Article, "tags", { fields: true }),
      ),
    )
    .add(
      Group.make(
        "search",
        Endpoint.collection([Article, Person], { name: "search", path: "/search", fields: true }),
      ),
    )
    .add(Group.make(AnyNode, Endpoint.polymorphic(AnyNode, { fields: true })))
    .add(
      Group.make(
        Holder,
        Endpoint.get(Holder, { include: true, fields: true }),
        Endpoint.related(Holder, "node", { fields: true }),
      ),
    );

  const company = Company.make({ id: Company.Id.make("2"), attributes: { name: "Acme" } });
  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: { type: "companies", id: Company.Id.make("2") } } },
  });
  const tag = Tag.make({ id: Tag.Id.make("3"), attributes: { name: "news", colour: "red" } });
  const article = Article.make({
    id: Article.Id.make("1"),
    attributes: { title: "Hello", body: "World" },
    relationships: {
      author: { data: { type: "people", id: Person.Id.make("9") } },
      tags: { data: [{ type: "tags", id: Tag.Id.make("3") }] },
    },
  });
  const editor = Editor.make({
    id: Editor.Id.make("7"),
    attributes: { name: "Eve", note: "lead" },
  });

  // Every handler projects the requested fieldsets with no cast: the
  // `Handlers.Projected` documents fit the default documents.
  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("get", ({ query }) =>
        Effect.succeed(
          Handlers.data(article, {
            included: [person, company],
            onResource: Handlers.project(query.fields),
          }),
        ),
      )
      .handle("list", ({ query }) =>
        Effect.succeed(
          Handlers.collection([article], {
            included: [person],
            onResource: Handlers.project(query.fields),
          }),
        ),
      )
      .handle("author", ({ query }) =>
        Effect.succeed(
          Handlers.data(person, {
            included: [company],
            onResource: Handlers.project(query.fields),
          }),
        ),
      )
      .handle("tags", ({ query }) =>
        Effect.succeed(Handlers.collection([tag], { onResource: Handlers.project(query.fields) })),
      ),
  );
  const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
    handlers.handle("search", ({ query }) =>
      Effect.succeed(
        Handlers.collection([article, person], { onResource: Handlers.project(query.fields) }),
      ),
    ),
  );
  const NodesLive = HttpApiBuilder.group(Api, "nodes", (handlers) =>
    handlers.handle("get", ({ query }) =>
      Effect.succeed(Handlers.data(editor, { onResource: Handlers.project(query.fields) })),
    ),
  );

  const holder = Holder.make({
    id: Holder.Id.make("1"),
    attributes: { label: "L" },
    relationships: { node: { data: { type: "editors", id: Editor.Id.make("7") } } },
  });
  const HoldersLive = HttpApiBuilder.group(Api, "holders", (handlers) =>
    handlers
      .handle("get", ({ query }) =>
        Effect.succeed(
          Handlers.data(holder, {
            included: [editor],
            onResource: Handlers.project(query.fields),
          }),
        ),
      )
      .handle("node", ({ query }) =>
        Effect.succeed(Handlers.data(editor, { onResource: Handlers.project(query.fields) })),
      ),
  );

  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide([ArticlesLive, SearchLive, NodesLive, HoldersLive]),
    Layer.provide(Middleware.layer),
    Layer.provide(platformLayer),
  );

  // Runs `request` against the api, served in memory.
  const fetchApp = (request: Request): Promise<Response> => {
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    // Read the body before the handler is disposed.
    return handler(request)
      .then(async (response) => new Response(await response.text(), response))
      .finally(dispose);
  };

  const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));
  const serve = async (url: string) => {
    const response = await fetchApp(new Request(`http://localhost${url}`));
    const text = await response.text();
    return { status: response.status, body: text === "" ? undefined : decodeJson(text) };
  };

  it.each([
    [
      "/articles/1?fields[articles]=title",
      { data: only(wire.articles, "title"), included: [wire.people, wire.companies] },
    ],
    [
      "/articles/1?include=author.employer&fields[articles]=title&fields[people]=name",
      { data: only(wire.articles, "title"), included: [only(wire.people, "name"), wire.companies] },
    ],
    [
      "/articles?fields[articles]=title,body&fields[people]=email",
      { data: [only(wire.articles, "title", "body")], included: [only(wire.people, "email")] },
    ],
    [
      "/articles/1/author?fields[people]=name&fields[companies]=name",
      { data: only(wire.people, "name"), included: [wire.companies] },
    ],
    ["/articles/1/tags?fields[tags]=colour", { data: [only(wire.tags, "colour")] }],
    [
      "/search?fields[articles]=body&fields[people]=name",
      { data: [only(wire.articles, "body"), only(wire.people, "name")] },
    ],
    ["/nodes/7?fields[editors]=note", { data: only(wire.editors, "note") }],
    // A family-valued relationship's members are trimmed by their own types (#350).
    [
      "/holders/1?fields[editors]=note",
      { data: wire.holders, included: [only(wire.editors, "note")] },
    ],
    [
      "/holders/1?include=node&fields[holders]=label&fields[editors]=name&fields[reviewers]=note",
      { data: wire.holders, included: [only(wire.editors, "name")] },
    ],
    ["/holders/1/node?fields[editors]=name", { data: only(wire.editors, "name") }],
    // The family name is still declared, and names no resource object, so it
    // trims nothing (the alias question on #350 is the owner's).
    ["/holders/1?fields[nodes]=name", { data: wire.holders, included: [wire.editors] }],
  ])("answers 200 omitting the excluded attributes: %s", async (url, expected) => {
    const response = await serve(url);
    expect(response.status).toBe(200);
    expect(response.body).toEqual(expected);
  });

  // An `HttpClient` that sends every request to the in-memory api.
  const inMemory = HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request);
      const response = yield* Effect.tryPromise(() => fetchApp(web));
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie),
  );

  it("decodes the projected documents through `HttpApiClient`", async () => {
    const [single, many, related] = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api, { baseUrl: "http://localhost" });
        return [
          yield* client.articles.get({
            params: { id: Article.Id.make("1") },
            query: { include: ["author"], fields: { articles: ["title"], people: ["name"] } },
          }),
          yield* client.articles.list({ query: { fields: { articles: ["body"] } } }),
          yield* client.articles.author({
            params: { id: Article.Id.make("1") },
            query: { fields: { people: ["email"] } },
          }),
        ] as const;
      }).pipe(Effect.provideService(HttpClient.HttpClient, inMemory)),
    );
    expect(single.data.attributes).toEqual({ title: "Hello" });
    expect(single.included?.[0]?.attributes).toEqual({ name: "Ada" });
    expect(many.data[0]?.attributes).toEqual({ body: "World" });
    expect(related.data?.attributes).toEqual({ email: "ada@example.com" });
  });
});
