import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import type { ContentNegotiation, SchemaErrors } from "./Middleware.js";
import * as Middleware from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

// #329: JSON:API 1.1 defines only the bare `include` and `sort` parameters,
// so a bracketed one — `include[]`, `include[x]`, `sort[title]`,
// `sort[x][y]` — is a parameter the server does not know how to process. It
// is a 400 naming it under the general rule (§Implementation-Specific Query
// Parameters: a server that "does not know how to process it as a query
// parameter from this specification … MUST return `400 Bad Request`"),
// whether or not the endpoint declares the bare family. The query schema
// would otherwise drop it, and the handler would see `{}`.

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Post = Resource.make("posts", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

// Hand-built query schemas that declare a bracketed member literally:
// declared means supported, so that very name decodes, and nothing else of
// the family does.
const handBuilt = {
  // The bare `sort` and a literal `sort[x]`.
  "sort-member": Schema.Struct({
    sort: Schema.optionalKey(Schema.String),
    "sort[x]": Schema.optionalKey(Schema.String),
  }),
  // A literal `include[x]` alone, no bare `include`.
  "include-member": Schema.Struct({ "include[x]": Schema.optionalKey(Schema.String) }),
} as const;

const handBuiltEndpoint = <const N extends keyof typeof handBuilt>(name: N) =>
  HttpApiEndpoint.get(name, `/hand-built/${name}`, {
    query: handBuilt[name],
    success: Schema.Unknown,
  })
    .middleware(Middleware.ContentNegotiation)
    .middleware(Middleware.SchemaErrors);

const BracketedApi = HttpApi.make("bracketed")
  .add(
    Group.make(
      Post,
      Endpoint.get(Post, { include: true }),
      Endpoint.list(Post, { include: true, sort: true }),
    ),
  )
  // Neither family declared anywhere.
  .add(Group.make(Person, Endpoint.get(Person), Endpoint.list(Person)))
  .add(
    HttpApiGroup.make("handBuilt").add(
      handBuiltEndpoint("sort-member"),
      handBuiltEndpoint("include-member"),
    ),
  );

// The decoded `query` each handler call received.
const queries: Array<unknown> = [];
const echo = ({ query }: { readonly query: unknown }) => {
  queries.push(query);
  return Effect.succeed(query);
};

const BracketedLive = Layer.mergeAll(
  HttpApiBuilder.group(BracketedApi, "posts", (handlers) =>
    handlers
      .handle("get", ({ params, query }) => {
        queries.push(query);
        return Effect.succeed({
          data: Post.make({ id: params.id, attributes: { title: "Hello" } }),
        });
      })
      .handle("list", ({ query }) => {
        queries.push(query);
        return Effect.succeed({ data: [] });
      }),
  ),
  HttpApiBuilder.group(BracketedApi, "people", (handlers) =>
    handlers
      .handle("get", ({ params }) =>
        Effect.succeed({ data: Person.make({ id: params.id, attributes: { name: "Ada" } }) }),
      )
      .handle("list", () => Effect.succeed({ data: [] })),
  ),
  HttpApiBuilder.group(BracketedApi, "handBuilt", (handlers) =>
    handlers.handleAll({ "sort-member": echo, "include-member": echo }),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

const serve = async (
  url: string,
  middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors> = Middleware.layer,
) => {
  const appLayer = HttpApiBuilder.layer(BracketedApi).pipe(
    Layer.provide(BracketedLive),
    Layer.provide(middlewareLayer),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(new Request(`http://localhost${url}`)).finally(dispose);
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: text === "" ? undefined : decodeJson(text),
  };
};

const GENERAL_RULE =
  "JSON:API requires a server to reject a query parameter from the specification " +
  "that it does not know how to process.";

const familyOf = (parameter: string): "include" | "sort" =>
  parameter.startsWith("include") ? "include" : "sort";

// The 400 for a bracketed `include` / `sort` on an endpoint that declares
// the bare parameter: JSON:API defines no bracketed member of either.
const bracketed = (parameter: string) => ({
  status: "400",
  code: "bad_request",
  title: "Bad Request",
  detail:
    `This endpoint does not support the "${parameter}" parameter: JSON:API defines only ` +
    `the bare "${familyOf(parameter)}" parameter, which this endpoint supports. ${GENERAL_RULE}`,
  source: { parameter },
});

// The 400 on an endpoint that does not support the family at all (#261),
// unchanged by #329.
const unsupported = (parameter: string) => ({
  status: "400",
  code: "bad_request",
  title: "Bad Request",
  detail: expect.stringContaining(`does not support the "${familyOf(parameter)}" parameter.`),
  source: { parameter },
});

// Every way the middleware is provided: the default layer, `layerWith`
// (with an allow-list, which admits none of these), and `SchemaErrorsLive`
// beside the live negotiation.
const layers = [
  ["Middleware.layer", Middleware.layer],
  ["Middleware.layerWith", Middleware.layerWith({ allowedQueryParameters: ["lang"] })],
  [
    "SchemaErrorsLive",
    Layer.mergeAll(Middleware.ContentNegotiationLive, Middleware.SchemaErrorsLive),
  ],
] as const;

describe("a bracketed `include` / `sort` (#329)", () => {
  const onDeclaring: ReadonlyArray<
    readonly [what: string, url: string, rejected: ReadonlyArray<string>]
  > = [
    ["`include[]` on a fetch that declares `include`", "/posts/1?include[]=author", ["include[]"]],
    [
      "`include[x]` on a fetch that declares `include`",
      "/posts/1?include[x]=author",
      ["include[x]"],
    ],
    ["a deeper `include[x][y]`", "/posts?include[x][y]=author", ["include[x][y]"]],
    ["`sort[title]` on a collection that declares `sort`", "/posts?sort[title]=1", ["sort[title]"]],
    ["`sort[x][y]` on a collection that declares `sort`", "/posts?sort[x][y]=1", ["sort[x][y]"]],
    ["`sort[]` on a collection that declares `sort`", "/posts?sort[]=title", ["sort[]"]],
    ["an empty value", "/posts?sort[title]=", ["sort[title]"]],
    [
      "a bracketed member beside the declared bare parameter, which stays supported",
      "/posts?include=author&include[]=author&sort=title&sort[title]=1",
      ["include[]", "sort[title]"],
    ],
  ];

  const onUndeclaring: ReadonlyArray<readonly [what: string, url: string, parameter: string]> = [
    ["`include[]` on a fetch that declares no `include`", "/people/1?include[]=x", "include[]"],
    [
      "`sort[title]` on a collection that declares no `sort`",
      "/people?sort[title]=1",
      "sort[title]",
    ],
    ["`sort[x][y]` on a single-resource fetch", "/posts/1?sort[x][y]=1", "sort[x][y]"],
  ];

  describe.each(layers)("under %s", (_, middleware) => {
    it.each(onDeclaring)("rejects %s, naming it", async (_, url, rejected) => {
      queries.length = 0;
      const response = await serve(url, middleware);
      expect(response.status).toBe(400);
      expect(response.contentType).toContain("application/vnd.api+json");
      expect(response.body).toEqual({ errors: rejected.map(bracketed) });
      expect(queries).toEqual([]);
    });

    it.each(onUndeclaring)("rejects %s with the family's message", async (_, url, parameter) => {
      queries.length = 0;
      const response = await serve(url, middleware);
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: [unsupported(parameter)] });
      expect(queries).toEqual([]);
    });
  });

  it("still decodes the bare parameters", async () => {
    queries.length = 0;
    expect((await serve("/posts/1?include=author")).status).toBe(200);
    expect((await serve("/posts?include=author&sort=-title")).status).toBe(200);
    expect(queries).toEqual([
      { include: ["author"] },
      { include: ["author"], sort: [{ field: "title", direction: "desc" }] },
    ]);
  });

  // A hand-built query schema that declares a bracketed member literally
  // supports that very name, as a declared `filter[status]` does (#321):
  // declaring it is how an endpoint "knows how to process" it.
  describe("a hand-built schema that declares a bracketed member", () => {
    it("decodes the member it declares", async () => {
      queries.length = 0;
      const response = await serve("/hand-built/sort-member?sort=a&sort[x]=b");
      expect(response.status).toBe(200);
      expect(queries).toEqual([{ sort: "a", "sort[x]": "b" }]);
    });

    it("rejects any other bracketed member", async () => {
      const response = await serve("/hand-built/sort-member?sort[y]=b");
      expect(response.status).toBe(400);
      expect(response.body).toEqual({ errors: [bracketed("sort[y]")] });
    });

    it("rejects the bare parameter when only a member is declared, listing the member", async () => {
      const response = await serve("/hand-built/include-member?include=author");
      expect(response.status).toBe(400);
      expect(response.body.errors).toEqual([
        expect.objectContaining({
          detail:
            'This endpoint does not support the "include" parameter: of the "include" family ' +
            `it supports only "include[x]". ${GENERAL_RULE}`,
          source: { parameter: "include" },
        }),
      ]);
    });
  });
});

describe("Middleware.checkQueryParameters on a bracketed `include` / `sort` (#329)", () => {
  const check = Middleware.checkQueryParameters;

  it("rejects a bracketed member beside the declared bare parameter", () => {
    const declared = ["include", "sort"];
    expect(check(["include", "sort"], { declared })).toBeUndefined();
    expect(check(["include[]", "include[x]", "sort[title]", "sort[x][y]"], { declared })).toEqual({
      errors: ["include[]", "include[x]", "sort[title]", "sort[x][y]"].map(bracketed),
    });
  });

  it("admits a bracketed member that `declared` lists by name, or by a prefix", () => {
    expect(check(["sort[x]"], { declared: ["sort", "sort[x]"] })).toBeUndefined();
    expect(check(["include[x][y]"], { declared: ["include["] })).toBeUndefined();
    expect(check(["sort[y]"], { declared: ["sort", "sort[x]"] })?.errors).toEqual([
      bracketed("sort[y]"),
    ]);
  });
});
