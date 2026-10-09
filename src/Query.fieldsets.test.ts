/**
 * `fields: true` declares a sparse fieldset for every type an include path
 * the endpoint legalises can reach (#311), not only for the resource and its
 * direct relationship targets.
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

describe("Query.schema `fields: true` — the types the include paths reach (#311)", () => {
  it("declares a fieldset for every type a depth-2 path reaches under `include: true`", () => {
    const query = Query.schema(Article, { include: true, fields: true });
    expect(declared(query)).toEqual([
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

  it("keeps the resource and its direct targets when `include` is off", () => {
    expect(declared(Query.schema(Article, { fields: true }))).toEqual([
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
    expect(declared(Query.schema(Article, { include: false, fields: true }))).toEqual([
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
  });

  it("follows the `depth` an include option names", () => {
    expect(declared(Query.schema(Article, { include: { depth: 1 }, fields: true }))).toEqual([
      "fields[articles]",
      "fields[comments]",
      "fields[tags]",
    ]);
    expect(declared(Query.schema(Article, { include: { depth: 3 }, fields: true }))).toEqual([
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
    // `labels` is on no listed path. The direct targets stay declared.
    expect(
      declared(
        Query.schema(Article, { include: { paths: ["comments.author.employer"] }, fields: true }),
      ),
    ).toEqual([
      "fields[articles]",
      "fields[comments]",
      "fields[companies]",
      "fields[people]",
      "fields[tags]",
    ]);
  });

  it("follows a declared `Include.Surface`", () => {
    const surface = Include.make(Article, {
      comments: Include.nested(Comment, { author: Person }),
    });
    expect(declared(Query.schema(Article, { include: surface, fields: true }))).toEqual([
      "fields[articles]",
      "fields[comments]",
      "fields[people]",
      "fields[tags]",
    ]);
  });

  it("walks each member of a heterogeneous endpoint", () => {
    expect(declared(Query.schema([Tag, Comment], { include: true, fields: true }))).toEqual([
      "fields[comments]",
      "fields[companies]",
      "fields[labels]",
      "fields[people]",
      "fields[revisions]",
      "fields[tags]",
    ]);
  });

  it("stays bounded on a self-referencing graph", () => {
    const Order = Resource.make("orders", {
      attributes: { shipped: Schema.Boolean },
      relationships: { employee: Relationship.one(() => Employee) },
    });
    expect(declared(Query.schema(Order, { include: true, fields: true }))).toEqual([
      "fields[employees]",
      "fields[orders]",
      "fields[territories]",
    ]);
  });
});

describe("`fields[TYPE]` for a type an include path reaches, over HTTP (#311)", () => {
  const surface = Include.make(Article, {
    comments: Include.nested(Comment, { author: Person }),
  });
  const Api = HttpApi.make("fieldsetsIncludeDepth").add(
    Group.make(
      Article,
      // The issue's endpoint: the graph to depth 2, no projection.
      Endpoint.get(Article, { include: true, fields: true }),
      // A declared surface, whose handler projects the fieldsets. A projected
      // resource's attributes are partial, which the default document (every
      // required attribute present) does not admit (#322), hence the open `success`.
      Endpoint.list(Article, { include: surface, fields: true, success: Schema.Unknown }),
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

  // `revisions` is behind a paginated relationship, and `companies` one hop
  // past the surface's `comments.author`.
  it.each(["fields[revisions]", "fields[companies]"])(
    "still rejects a type no include path reaches: %s",
    async (parameter) => {
      const response = await serve(`/articles?include=comments&${parameter}=name`);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(rejected(parameter));
    },
  );

  // `labels` is declared (depth 2, `comments.label`) but has no field to
  // select, so no value of `fields[labels]` decodes: the #261 empty-vocabulary
  // 400, an empty value included.
  it.each(["/articles/1?fields[labels]=name", "/articles/1?fields[labels]="])(
    "rejects a reached type with no attribute as an empty vocabulary: %s",
    async (url) => {
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(response.body).toEqual(rejected("fields[labels]"));
    },
  );
});
