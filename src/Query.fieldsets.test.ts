/**
 * `fields: true` declares a sparse fieldset for every type an include path
 * the endpoint legalises can reach (#311), not only for the resource and its
 * direct relationship targets — and for no type the response can never carry
 * (#311, owner decision for 0.17.0): not a direct target a declared
 * `Include.Surface` leaves out, nor a target reachable only through a
 * `paginated` relationship.
 *
 * JSON:API 1.1 §Sparse Fieldsets: "A client MAY request that an endpoint
 * return only specific fields in the response on a per-type basis by
 * including a `fields[TYPE]` query parameter." Since #261 a `fields[TYPE]` the
 * endpoint does not declare is a 400, so a type the endpoint can return in
 * `included` must be declared, or a client could include it but never trim it.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Include from "./Include.js";
import { admitsNoValue } from "./internal/vocabulary.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

// No attributes, so its sparse fieldset has no field to select.
const Label = Resource.make("labels", { attributes: {} });
const Revision = Resource.make("revisions", { attributes: { editedAt: Schema.String } });
const Company = Resource.make("companies", { attributes: { name: Schema.String } });
const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString, email: Schema.String },
  relationships: { employer: Relationship.one(() => Company) },
});
const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    label: Relationship.optional(() => Label),
    // Paginated: never an include path, so `revisions` is reachable by none.
    revisions: Relationship.paginated(() => Revision),
  },
});
const Tag = Resource.make("tags", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    comments: Relationship.many(() => Comment),
    tags: Relationship.many(() => Tag),
    // Paginated: a direct target that never appears in `included`.
    history: Relationship.paginated(() => Revision),
  },
});

// A self-referencing resource, as `examples/northwind` declares one.
const Territory = Resource.make("territories", { attributes: { region: Schema.String } });
const employeeAttributes = { name: Schema.String };
interface Employee extends Resource.Resource<
  "employees",
  typeof employeeAttributes,
  {
    readonly reportsTo: Relationship.optional<Employee>;
    readonly territories: Relationship.many<typeof Territory>;
  }
> {}
const Employee: Employee = Resource.make("employees", {
  attributes: employeeAttributes,
  relationships: {
    reportsTo: Relationship.optional(() => Employee),
    territories: Relationship.many(() => Territory),
  },
});

// The `fields[TYPE]` parameters a query schema declares on the wire.
const declared = (query: { readonly from: { readonly fields: Schema.Struct.Fields } }) =>
  Arr.sort(
    Arr.filter(Rec.keys(query.from.fields), (key) => key.startsWith("fields[")),
    Order.String,
  );

// The `fields[TYPE]` keys a query schema's type declares on the wire.
type WireFieldsets<Q extends { readonly Encoded: object }> = Extract<
  keyof Q["Encoded"],
  `fields[${string}]`
>;

// Asserts that `query` declares exactly `keys` as `fields[TYPE]` parameters,
// at runtime and in its type alike: each listed key must be one of the type's
// (the constraint), the type may declare no other (the intersection names the
// keys the list is missing), and the runtime schema must declare exactly the
// list. So the runtime walk and `Query.FieldsetResources` cannot drift apart.
const expectFieldsets = <
  Q extends {
    readonly Encoded: object;
    readonly from: { readonly fields: Schema.Struct.Fields };
  },
  const K extends ReadonlyArray<WireFieldsets<Q>>,
>(
  query: Q,
  keys: K &
    ([Exclude<WireFieldsets<Q>, K[number]>] extends [never]
      ? unknown
      : { readonly missing: Exclude<WireFieldsets<Q>, K[number]> }),
): void => {
  expect(declared(query)).toEqual(Arr.sort(keys, Order.String));
};

describe("Query.schema `fields: true` — the types the include paths reach (#311)", () => {
  it("declares a fieldset for every type a depth-2 path reaches under `include: true`", () => {
    // `revisions` (behind `history` and `comments.revisions`, both paginated)
    // is on no include path and never in `included`.
    const query = Query.schema(Article, { include: true, fields: true });
    expectFieldsets(query, [
      "fields[articles]",
      "fields[comments]",
      "fields[labels]",
      "fields[people]",
      "fields[tags]",
    ]);
    expect(
      Schema.decodeUnknownSync(query)({
        include: "comments.author",
        "fields[people]": "name",
      }),
    ).toEqual({ include: ["comments.author"], fields: { people: ["name"] } });
  });

  it("gives a reached type with no attribute the empty vocabulary #261 rejects", () => {
    // `labels` (via `comments.label`) is declared, but its fieldset has no
    // field to select: the middleware reads it as supporting no value.
    const query = Query.schema(Article, { include: true, fields: true });
    expect(admitsNoValue(query.ast, "fields[labels]")).toBe(true);
    expect(admitsNoValue(query.ast, "fields[people]")).toBe(false);
    expect(() => Schema.decodeUnknownSync(query)({ "fields[labels]": "name" })).toThrow(
      'This endpoint supports no sparse fieldset for type "labels".',
    );
  });

  it("declares the resource and its non-paginated direct targets when `include` is off", () => {
    // The default `included` union: `history`'s `revisions` is paginated, so
    // it is not declared.
    expectFieldsets(Query.schema(Article, { fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
    expectFieldsets(Query.schema(Article, { include: false, fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
  });

  it("never declares a target reachable only through a paginated relationship", () => {
    // `revisions` is a direct target of `Article` and of `Comment`, both
    // through a paginated relationship, so no configuration declares it.
    const Archive = Resource.make("archives", {
      attributes: { name: Schema.String },
      relationships: { revisions: Relationship.paginated(() => Revision) },
    });
    expectFieldsets(Query.schema(Archive, { fields: true }), ["fields[archives]"]);
    expectFieldsets(Query.schema(Archive, { include: { depth: 3 }, fields: true }), [
      "fields[archives]",
    ]);
    expectFieldsets(Query.schema(Comment, { include: true, fields: true }), [
      "fields[comments]",
      "fields[companies]",
      "fields[labels]",
      "fields[people]",
    ]);
  });

  it("follows the `depth` an include option names", () => {
    expectFieldsets(Query.schema(Article, { include: { depth: 1 }, fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
    expectFieldsets(Query.schema(Article, { include: { depth: 3 }, fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[companies]",
      "fields[labels]",
      "fields[people]",
      "fields[tags]",
    ]);
  });

  it("follows an explicit `paths` allow-list, every resource on the way down included", () => {
    // `comments.author.employer` reaches `comments`, `people` and `companies`;
    // `labels` is on no listed path. The non-paginated direct targets stay
    // declared (`tags`): the default `included` union admits them.
    expectFieldsets(
      Query.schema(Article, { include: { paths: ["comments.author.employer"] }, fields: true }),
      [
        "fields[articles]",
        "fields[comments]",
        "fields[companies]",
        "fields[people]",
        "fields[tags]",
      ],
    );
  });

  it("declares exactly what a declared `Include.Surface` reaches", () => {
    // The surface's `included` union is `comments | people`, so the direct
    // target `tags` the surface leaves out is not declared.
    const surface = Include.make(Article, {
      comments: Include.nested(Comment, { author: Person }),
    });
    expectFieldsets(Query.schema(Article, { include: surface, fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[people]",
    ]);
    // A surface naming every direct target declares them all again.
    const wide = Include.make(Article, { comments: Comment, tags: Tag });
    expectFieldsets(Query.schema(Article, { include: wide, fields: true }), [
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
  });

  it("walks each member of a heterogeneous endpoint", () => {
    // `Comment`'s paginated `revisions` is not declared.
    expectFieldsets(Query.schema([Tag, Comment], { include: true, fields: true }), [
      "fields[comments]",
      "fields[companies]",
      "fields[labels]",
      "fields[people]",
      "fields[tags]",
    ]);
    // Under a surface, every member is declared, plus what the surface's
    // paths reach from each: `Comment`'s direct target `labels` is left out.
    const surface = Include.make(Comment, { author: Person });
    expectFieldsets(Query.schema([Tag, Comment], { include: surface, fields: true }), [
      "fields[comments]",
      "fields[people]",
      "fields[tags]",
    ]);
  });

  it("never declares a target one member reaches only through a paginated relationship", () => {
    // `posts.author` is a to-one `people`, so `author` and `author.employer`
    // are legal paths; `drafts.author` is a paginated `revisions`, which no
    // path may cross, so walking those paths from `drafts` reaches nothing.
    const Post = Resource.make("posts", {
      attributes: { title: Schema.String },
      relationships: { author: Relationship.one(() => Person) },
    });
    const Draft = Resource.make("drafts", {
      attributes: { title: Schema.String },
      relationships: { author: Relationship.paginated(() => Revision) },
    });
    expectFieldsets(Query.schema([Post, Draft], { include: true, fields: true }), [
      "fields[companies]",
      "fields[drafts]",
      "fields[people]",
      "fields[posts]",
    ]);
  });

  it("never declares a target one member reaches through a paginated relationship at the second hop", () => {
    // `drafts.author` is a to-one `writers`, so `author.employer` reaches
    // `companies` from `posts`; `writers.employer` is a paginated `archives`,
    // which no path may cross at any hop.
    const Archive = Resource.make("archives", { attributes: { label: Schema.String } });
    const Writer = Resource.make("writers", {
      attributes: { name: Schema.String },
      relationships: { employer: Relationship.paginated(() => Archive) },
    });
    const Post = Resource.make("posts", {
      attributes: { title: Schema.String },
      relationships: { author: Relationship.one(() => Person) },
    });
    const Draft = Resource.make("drafts", {
      attributes: { title: Schema.String },
      relationships: { author: Relationship.one(() => Writer) },
    });
    expectFieldsets(Query.schema([Post, Draft], { include: true, fields: true }), [
      "fields[companies]",
      "fields[drafts]",
      "fields[people]",
      "fields[posts]",
      "fields[writers]",
    ]);
  });

  it("stays bounded on a self-referencing graph", () => {
    const Order = Resource.make("orders", {
      attributes: { shipped: Schema.Boolean },
      relationships: { employee: Relationship.one(() => Employee) },
    });
    expectFieldsets(Query.schema(Order, { include: true, fields: true }), [
      "fields[employees]",
      "fields[orders]",
      "fields[territories]",
    ]);
  });
});

describe("Query.schema `fields: true` — a family's member types (#350)", () => {
  // `nodes` is a family name, never a wire type: what the wire carries for a
  // relationship targeting the family are `editors` and `reviewers`. So the
  // family is replaced by its members, and `fields[nodes]` is not declared
  // (owner decision on #350): the #261 middleware answers it with a 400.
  const Node = Resource.make("nodes", { attributes: { name: Schema.String } });
  const Editor = Resource.extend(Node, "editors", {
    inheritId: true,
    attributes: { level: Schema.String },
  });
  const Reviewer = Resource.extend(Node, "reviewers", {
    inheritId: true,
    attributes: { score: Schema.String },
  });
  const AnyNode = Resource.family(Node, [Editor, Reviewer]);
  const Holder = Resource.make("holders", {
    attributes: { label: Schema.String },
    relationships: { node: Relationship.one(() => AnyNode) },
  });
  const Board = Resource.make("boards", {
    attributes: { title: Schema.String },
    relationships: {
      holders: Relationship.many(() => Holder),
      // Paginated: never an include path, so its family reaches nothing.
      archive: Relationship.paginated(() => AnyNode),
    },
  });

  it("declares each member type of a family-valued relationship's target, not the family", () => {
    const query = Query.schema(Holder, { fields: true });
    expectFieldsets(query, ["fields[editors]", "fields[holders]", "fields[reviewers]"]);
    // Each member's fieldset is its own attributes, inherited ones included.
    expect(
      Schema.decodeUnknownSync(query)({
        "fields[editors]": "name,level",
        "fields[reviewers]": "score",
      }),
    ).toEqual({ fields: { editors: ["name", "level"], reviewers: ["score"] } });
    expect(() => Schema.decodeUnknownSync(query)({ "fields[editors]": "score" })).toThrow();
  });

  it("declares the members of a family an include path reaches, and not before", () => {
    expectFieldsets(Query.schema(Board, { fields: true }), ["fields[boards]", "fields[holders]"]);
    expectFieldsets(Query.schema(Board, { include: true, fields: true }), [
      "fields[boards]",
      "fields[editors]",
      "fields[holders]",
      "fields[reviewers]",
    ]);
  });

  it("never declares the members of a family reachable only through a paginated relationship", () => {
    const Archive = Resource.make("archives", {
      attributes: { name: Schema.String },
      relationships: { nodes: Relationship.paginated(() => AnyNode) },
    });
    expectFieldsets(Query.schema(Archive, { include: true, fields: true }), ["fields[archives]"]);
  });

  it("declares the members of a name-only family, not its name", () => {
    const Photo = Resource.make("photos", { attributes: { url: Schema.String } });
    const Video = Resource.make("videos", { attributes: { url: Schema.String } });
    const Gallery = Resource.make("galleries", {
      attributes: { title: Schema.String },
      relationships: { items: Relationship.many(() => Resource.family("media", [Photo, Video])) },
    });
    expectFieldsets(Query.schema(Gallery, { fields: true }), [
      "fields[galleries]",
      "fields[photos]",
      "fields[videos]",
    ]);
  });

  it("declares the members of a family that is the primary resource", () => {
    expectFieldsets(Query.schema(AnyNode, { fields: true }), [
      "fields[editors]",
      "fields[reviewers]",
    ]);
  });

  // A base-anchored family's name is its base's real type. The family itself
  // declares nothing, but the base reached in its own right is declared as
  // itself, over its own attributes.
  it("keeps a real type that shares a base-anchored family's name", () => {
    const Pair = Resource.make("pairs", {
      attributes: { label: Schema.String },
      relationships: {
        node: Relationship.one(() => AnyNode),
        base: Relationship.one(() => Node),
      },
    });
    const query = Query.schema(Pair, { fields: true });
    expectFieldsets(query, [
      "fields[editors]",
      "fields[nodes]",
      "fields[pairs]",
      "fields[reviewers]",
    ]);
    expect(Schema.decodeUnknownSync(query)({ "fields[nodes]": "name" })).toEqual({
      fields: { nodes: ["name"] },
    });
    // `level` is an `editors` attribute, not a `nodes` one.
    expect(() => Schema.decodeUnknownSync(query)({ "fields[nodes]": "level" })).toThrow();
  });

  // A family can be a member of another family: the inner family's members
  // are what the wire carries, so they are declared, and neither family is.
  it("declares the members of a nested family, recursively", () => {
    const Other = Resource.make("others", { attributes: { rank: Schema.String } });
    const Outer = Resource.family("outer", [AnyNode, Other]);
    const Nest = Resource.make("nests", {
      attributes: { label: Schema.String },
      relationships: { o: Relationship.one(() => Outer) },
    });
    const query = Query.schema(Nest, { fields: true });
    expectFieldsets(query, [
      "fields[editors]",
      "fields[nests]",
      "fields[others]",
      "fields[reviewers]",
    ]);
    expect(
      Schema.decodeUnknownSync(query)({ "fields[editors]": "level", "fields[others]": "rank" }),
    ).toEqual({ fields: { editors: ["level"], others: ["rank"] } });
    // The outer family as the primary resource. (A name-only family's
    // synthesised relationships are typed as the open record, so its type
    // declares any key: the runtime keys are compared directly. #363 tracks
    // that widening; fixing it should tighten this to an exact type pin.)
    expect(declared(Query.schema(Outer, { fields: true }))).toEqual([
      "fields[editors]",
      "fields[others]",
      "fields[reviewers]",
    ]);
  });
});

describe("`fields[TYPE]` for a type an include path reaches, over HTTP (#311)", () => {
  const surface = Include.make(Article, {
    comments: Include.nested(Comment, { author: Person }),
  });
  // The issue's endpoint: the graph to depth 2, no projection.
  const get = Endpoint.get(Article, { include: true, fields: true });
  const Api = HttpApi.make("fieldsetsIncludeDepth").add(
    Group.make(
      Article,
      get,
      // `include` off: the resource and its non-paginated direct targets.
      Endpoint.get(Article, { name: "getShallow", path: "/shallow/:id", fields: true }),
      // A declared surface, whose handler projects the fieldsets: the default
      // document of an endpoint declaring `fields` admits partial attributes (#322).
      Endpoint.list(Article, { include: surface, fields: true }),
    ),
  );

  const comment = Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First" },
    relationships: {
      author: { data: { type: "people", id: Person.Id.make("9") } },
      label: { data: null },
      revisions: { links: { related: "/comments/5/revisions" } },
    },
  });
  const person = Person.make({
    id: Person.Id.make("9"),
    attributes: { name: "Ada", email: "ada@example.com" },
    relationships: { employer: { data: { type: "companies", id: Company.Id.make("1") } } },
  });
  const article = Article.make({
    id: Article.Id.make("1"),
    attributes: { title: "Hello" },
    relationships: {
      comments: { data: [{ type: "comments", id: Comment.Id.make("5") }] },
      tags: { data: [] },
      history: { links: { related: "/articles/1/history" } },
    },
  });

  // The decoded `query` each handler call received.
  const queries: Array<unknown> = [];
  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers
      .handle("get", ({ query }) => {
        queries.push(query);
        return Effect.succeed({ data: article, included: [comment] });
      })
      .handle("getShallow", ({ query }) => {
        queries.push(query);
        return Effect.succeed({ data: article });
      })
      .handle("list", ({ query }) => {
        queries.push(query);
        return Effect.succeed(
          Handlers.collection([article], {
            included: [comment, person],
            onResource: Handlers.project(query.fields),
          }),
        );
      }),
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

  const rejected = (parameter: string) => ({
    errors: [
      expect.objectContaining({
        status: "400",
        detail: expect.stringContaining(`does not support the "${parameter}" parameter`),
        source: { parameter },
      }),
    ],
  });

  it("accepts and decodes `fields[TYPE]` for a type only a depth-2 path reaches", async () => {
    queries.length = 0;
    const response = await serve("/articles/1?include=comments.author&fields[people]=name");
    expect(response.status).toBe(200);
    expect(queries).toEqual([{ include: ["comments.author"], fields: { people: ["name"] } }]);
  });

  it("applies the fieldset to the depth-2 `included` members a projecting handler returns", async () => {
    const response = await serve(
      "/articles?include=comments.author&fields[people]=name&fields[comments]=body",
    );
    expect(response.status).toBe(200);
    expect(response.body.included).toEqual([
      expect.objectContaining({ type: "comments", id: "5", attributes: { body: "First" } }),
      expect.objectContaining({ type: "people", id: "9", attributes: { name: "Ada" } }),
    ]);
  });

  // `revisions` is behind a paginated relationship, `companies` one hop past
  // the surface's `comments.author`, and `tags` a direct target the surface
  // leaves out.
  it.each(["fields[revisions]", "fields[companies]", "fields[tags]"])(
    "rejects a type a declared surface's response can never carry: %s",
    async (parameter) => {
      const response = await serve(`/articles?include=comments&${parameter}=name`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(rejected(parameter));
    },
  );

  // `revisions` is the target of `Article`'s paginated `history` and of
  // `Comment`'s paginated `revisions`: never an include path, never in
  // `included`, so a 400 whether `include` is on or off.
  it.each(["/articles/1", "/shallow/1"])(
    "rejects a type reachable only through a paginated relationship: %s",
    async (path) => {
      const response = await serve(`${path}?fields[revisions]=editedAt`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(rejected("fields[revisions]"));
    },
  );

  // A non-paginated direct target stays declared without a surface: the
  // default `included` union admits it, and a server MAY include it by
  // default.
  it.each(["/articles/1", "/shallow/1"])(
    "keeps a non-paginated direct target without a surface: %s",
    async (path) => {
      queries.length = 0;
      const response = await serve(`${path}?fields[tags]=name`);
      expect(response.status).toBe(200);
      expect(queries).toEqual([{ fields: { tags: ["name"] } }]);
    },
  );

  // `labels` is declared (depth 2, `comments.label`) but has no field to
  // select, so no value of `fields[labels]` decodes: the #261 empty-vocabulary
  // 400, an empty value included. The response is the same as for an
  // undeclared type, so the endpoint's query is checked to declare
  // `fields[labels]` and to read it as an empty vocabulary: this is that 400,
  // not the undeclared-type one.
  it.each(["/articles/1?fields[labels]=name", "/articles/1?fields[labels]="])(
    "rejects a declared reached type with no attribute as an empty vocabulary: %s",
    async (url) => {
      // The endpoint's query, as the middleware reads it (`endpoint.query.ast`).
      const ast = get.query?.ast;
      const wire = ast === undefined ? undefined : SchemaAST.toEncoded(ast);
      expect(
        wire !== undefined && SchemaAST.isObjects(wire)
          ? wire.propertySignatures.map((property) => property.name)
          : [],
      ).toContain("fields[labels]");
      expect(ast !== undefined && admitsNoValue(ast, "fields[labels]")).toBe(true);
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(rejected("fields[labels]"));
    },
  );
});
