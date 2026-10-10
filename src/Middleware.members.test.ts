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
import * as Query from "./Query.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";

// Owner decision on #321: a request naming a member of the `filter` or
// `page` family that the endpoint does not declare — `filter[stauts]` beside
// a declared `filter[status]`, `page[sise]` beside `page[size]` — is a 400
// naming it, exactly as a family the endpoint does not declare at all is
// (#261). The query schema would otherwise drop it, and the client would get
// an unfiltered or unpaginated collection. JSON:API 1.1 §Implementation-
// Specific Query Parameters: a server that "does not know how to process it
// as a query parameter from this specification … MUST return `400 Bad
// Request`."

const Ticket = Resource.make("tickets", {
  attributes: {
    title: Resource.attribute(Schema.String, { filter: true }),
    status: Schema.String,
  },
});

// The query a hand-built endpoint declares, each renamed or opened on the
// wire in its own way.
const handBuilt = {
  // `state` sent as `filter[status]`.
  renamed: Schema.Struct({ state: Schema.optionalKey(Schema.String) }).pipe(
    Schema.encodeKeys({ state: "filter[status]" }),
  ),
  // `offset` / `limit` sent as `page[offset]` / `page[limit]`.
  "bracket-page": Query.bracketPageKeys(Schema.Struct(Query.Page.offset({ maxLimit: 100 }))),
  // An open record of `filter[…]` and one of `page[…]`: every member.
  "open-filter": Schema.Record(
    Schema.TemplateLiteral(["filter[", Schema.String, "]"]),
    Schema.String,
  ),
  "open-page": Schema.Record(Schema.TemplateLiteral(["page[", Schema.String]), Schema.String),
} as const;

const handBuiltEndpoint = <const N extends keyof typeof handBuilt>(name: N) =>
  HttpApiEndpoint.get(name, `/hand-built/${name}`, {
    query: handBuilt[name],
    success: Schema.Unknown,
  })
    .middleware(Middleware.ContentNegotiation)
    .middleware(Middleware.SchemaErrors);

const MembersApi = HttpApi.make("members")
  .add(
    Group.make(
      Ticket,
      // An explicit filter map, and offset pagination.
      Endpoint.list(Ticket, { filter: { status: Schema.String }, page: Query.Page.Offset }),
    ),
  )
  .add(
    HttpApiGroup.make("strategies").add(
      HttpApiEndpoint.get("number", "/by-number", {
        query: Query.schema(Ticket, { page: Query.Page.Number }),
        success: Schema.Unknown,
      }).middleware(Middleware.SchemaErrors),
      HttpApiEndpoint.get("cursor", "/by-cursor", {
        query: Query.schema(Ticket, { page: Query.Page.Cursor }),
        success: Schema.Unknown,
      }).middleware(Middleware.SchemaErrors),
      HttpApiEndpoint.get("grammar", "/grammar", {
        query: Query.schema(Ticket, { filter: true }),
        success: Schema.Unknown,
      }).middleware(Middleware.SchemaErrors),
    ),
  )
  .add(
    HttpApiGroup.make("handBuilt").add(
      handBuiltEndpoint("renamed"),
      handBuiltEndpoint("bracket-page"),
      handBuiltEndpoint("open-filter"),
      handBuiltEndpoint("open-page"),
    ),
  );

// The decoded `query` each handler call received.
const queries: Array<unknown> = [];
const echo = ({ query }: { readonly query: unknown }) => {
  queries.push(query);
  return Effect.succeed(query);
};

const MembersLive = Layer.mergeAll(
  HttpApiBuilder.group(MembersApi, "tickets", (handlers) =>
    handlers.handle("list", ({ query }) => {
      queries.push(query);
      return Effect.succeed({ data: [] });
    }),
  ),
  HttpApiBuilder.group(MembersApi, "strategies", (handlers) =>
    handlers.handleAll({ number: echo, cursor: echo, grammar: echo }),
  ),
  HttpApiBuilder.group(MembersApi, "handBuilt", (handlers) =>
    handlers.handleAll({
      renamed: echo,
      "bracket-page": echo,
      "open-filter": echo,
      "open-page": echo,
    }),
  ),
);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

const serve = async (
  url: string,
  middlewareLayer: Layer.Layer<ContentNegotiation | SchemaErrors> = Middleware.layer,
) => {
  const appLayer = HttpApiBuilder.layer(MembersApi).pipe(
    Layer.provide(MembersLive),
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

// The 400 for an undeclared member: it names the parameter as the request
// spelt it, and the members of its family the endpoint does declare.
const undeclaredMember = (parameter: string, declared: ReadonlyArray<string>) => ({
  status: "400",
  code: "bad_request",
  title: "Bad Request",
  detail:
    `This endpoint does not support the "${parameter}" parameter: of the ` +
    `"${parameter.startsWith("page") ? "page" : "filter"}" family it supports only ` +
    `${declared.map((name) => `"${name}"`).join(", ")}. JSON:API requires a server to ` +
    "reject a query parameter from the specification that it does not know how to process.",
  source: { parameter },
});

const OFFSET = ["page[offset]", "page[limit]"];

describe("an undeclared member of a declared `filter` map or `page` key set (#321)", () => {
  // Every way the middleware is provided: the default layer, `layerWith`
  // (with an allow-list, which admits none of these), and
  // `SchemaErrorsLive` beside the live negotiation.
  const layers = [
    ["Middleware.layer", Middleware.layer],
    ["Middleware.layerWith", Middleware.layerWith({ allowedQueryParameters: ["lang"] })],
    [
      "SchemaErrorsLive",
      Layer.mergeAll(Middleware.ContentNegotiationLive, Middleware.SchemaErrorsLive),
    ],
  ] as const;

  const rejected: ReadonlyArray<
    readonly [
      what: string,
      url: string,
      errors: ReadonlyArray<readonly [parameter: string, declared: ReadonlyArray<string>]>,
    ]
  > = [
    [
      "a misspelt filter key",
      "/tickets?filter[stauts]=open",
      [["filter[stauts]", ["filter[status]"]]],
    ],
    [
      "a filter key the map does not declare, beside one it does",
      "/tickets?filter[status]=open&filter[title]=x",
      [["filter[title]", ["filter[status]"]]],
    ],
    [
      "a nested member of a declared filter key",
      "/tickets?filter[status][eq]=open",
      [["filter[status][eq]", ["filter[status]"]]],
    ],
    [
      "a bare `filter` beside a filter map",
      "/tickets?filter=open",
      [["filter", ["filter[status]"]]],
    ],
    ["a misspelt offset page key", "/tickets?page[sise]=10", [["page[sise]", OFFSET]]],
    ["a page key of another strategy", "/tickets?page[size]=10", [["page[size]", OFFSET]]],
    ["a bare `page` beside declared page keys", "/tickets?page=2", [["page", OFFSET]]],
    [
      "a misspelt number page key",
      "/by-number?page[sise]=10",
      [["page[sise]", ["page[number]", "page[size]"]]],
    ],
    [
      "an offset key on a number-paginated endpoint",
      "/by-number?page[limit]=10",
      [["page[limit]", ["page[number]", "page[size]"]]],
    ],
    [
      "a misspelt cursor page key",
      "/by-cursor?page[cursr]=abc",
      [["page[cursr]", ["page[cursor]", "page[size]"]]],
    ],
    [
      "every undeclared member at once, in request order",
      "/tickets?page[sise]=1&filter[stauts]=open&page[limit]=1",
      [
        ["page[sise]", OFFSET],
        ["filter[stauts]", ["filter[status]"]],
      ],
    ],
    // Renamed on the wire: members count by the name the request sends.
    [
      "the decoded name of a renamed filter member",
      "/hand-built/renamed?filter[state]=open",
      [["filter[state]", ["filter[status]"]]],
    ],
    [
      "an undeclared member beside `bracketPageKeys`",
      "/hand-built/bracket-page?page[size]=10",
      [["page[size]", OFFSET]],
    ],
  ];

  describe.each(layers)("under %s", (_, middleware) => {
    it.each(rejected)("rejects %s, naming it", async (_, url, errors) => {
      queries.length = 0;
      const response = await serve(url, middleware);
      expect(response.status).toBe(400);
      expect(response.contentType).toContain("application/vnd.api+json");
      expect(response.body).toEqual({
        errors: errors.map(([parameter, declared]) => undeclaredMember(parameter, declared)),
      });
      expect(queries).toEqual([]);
    });
  });

  it.each([
    [
      "a declared filter key and declared offset page keys",
      "/tickets?filter[status]=open&page[offset]=0&page[limit]=5",
      { filter: { status: "open" }, page: { offset: 0, limit: 5 } },
    ],
    [
      "declared number page keys",
      "/by-number?page[number]=2&page[size]=5",
      { page: { number: 2, size: 5 } },
    ],
    [
      "declared cursor page keys",
      "/by-cursor?page[cursor]=abc&page[size]=5",
      { page: { cursor: "abc", size: 5 } },
    ],
    [
      "a renamed filter member, by its wire name",
      "/hand-built/renamed?filter[status]=open",
      { state: "open" },
    ],
    [
      "`bracketPageKeys` members, by their wire names",
      "/hand-built/bracket-page?page[offset]=1&page[limit]=2",
      { offset: 1, limit: 2 },
    ],
    [
      "any member of an open `filter[` record",
      "/hand-built/open-filter?filter[anything]=x&filter[else]=y",
      { "filter[anything]": "x", "filter[else]": "y" },
    ],
    [
      "any member of an open `page[` record",
      "/hand-built/open-page?page[anything]=x",
      { "page[anything]": "x" },
    ],
  ] as const)("supports %s", async (_, url, query) => {
    queries.length = 0;
    const response = await serve(url);
    expect(response.status).toBe(200);
    expect(queries).toEqual([query]);
  });

  // The open grammar validates every bracket suffix itself: the support
  // check admits the whole family, and a malformed member is the grammar's
  // own 400, as before.
  describe("`filter: true` is unchanged", () => {
    it("supports a nested member of the grammar", async () => {
      queries.length = 0;
      const response = await serve("/grammar?filter[title][eq]=x");
      expect(response.status).toBe(200);
      expect(queries).toEqual([
        { filter: { _tag: "Compare", op: "eq", field: "title", value: "x" } },
      ]);
    });

    it.each([
      ["a field the grammar does not filter on", "/grammar?filter[status]=open"],
      ["an operator the grammar does not define", "/grammar?filter[title][bogus]=x"],
      ["a bare `filter`", "/grammar?filter=x"],
    ])("leaves %s to the grammar's own rejection", async (_, url) => {
      const response = await serve(url);
      expect(response.status).toBe(400);
      expect(
        response.body.errors.filter(({ detail }: { readonly detail: string }) =>
          detail.startsWith("This endpoint does not support"),
        ),
      ).toEqual([]);
    });
  });

  it("does not apply to `fields[TYPE]`, which keeps its own per-type message", async () => {
    const response = await serve("/tickets?fields[tickets]=title");
    expect(response.status).toBe(400);
    expect(response.body.errors[0].detail).toContain(
      'does not support the "fields[tickets]" parameter: it supports no sparse fieldset',
    );
  });

  it("keeps the family message on an endpoint that declares no member of it", async () => {
    const response = await serve("/by-number?filter[status]=open");
    expect(response.status).toBe(400);
    expect(response.body.errors[0].detail).toContain(
      'does not support the "filter" parameter family',
    );
  });
});

describe("Middleware.checkQueryParameters on members (#321)", () => {
  const check = Middleware.checkQueryParameters;

  it("admits a `page` or `filter` member only by its own name or a declared prefix", () => {
    const declared = ["page[limit]", "page[offset]", "filter[status]"];
    expect(check(["page[limit]", "page[offset]", "filter[status]"], { declared })).toBeUndefined();
    expect(
      check(["page[size]", "page", "filter[stauts]", "filter", "filter[status][eq]"], { declared })
        ?.errors,
    ).toEqual([
      undeclaredMember("page[size]", ["page[limit]", "page[offset]"]),
      undeclaredMember("page", ["page[limit]", "page[offset]"]),
      undeclaredMember("filter[stauts]", ["filter[status]"]),
      undeclaredMember("filter", ["filter[status]"]),
      undeclaredMember("filter[status][eq]", ["filter[status]"]),
    ]);
    expect(
      check(["filter[any][x]", "page[y]"], { declared: ["filter[", "page["] }),
    ).toBeUndefined();
  });

  // A prefix never admits the bare family name; the detail names it as the
  // open family it is.
  it("names a declared prefix as its open family", () => {
    expect(check(["filter"], { declared: ["filter["] })?.errors).toEqual([
      undeclaredMember("filter", ["filter[…]"]),
    ]);
  });

  it("still admits a whole implementation-specific family by any declared member", () => {
    expect(check(["search[other]"], { declared: ["search[term]"] })).toBeUndefined();
  });
});
