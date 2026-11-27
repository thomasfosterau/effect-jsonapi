/**
 * Custom filter operators and filter dialects: declared on a resource, decoded
 * and encoded by `Query.Filter` and `Query.schema`, and served over HTTP.
 */
import { assert, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as P from "effect/Predicate";
import type * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import * as Query from "./Query.js";
import { platformLayer } from "./Registry.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const like = Filter.operator("like", { appliesTo: ["string"] });
const anyOf = Filter.operator("anyOf", { list: true });
// A literal of its own: a distance in metres, whatever the field's type.
const within = Filter.operator("within", { literal: Schema.FiniteFromString });

const Place = Resource.make("places", {
  attributes: {
    name: Schema.String.pipe(Filter.able(["eq", like])),
    kind: Resource.attribute(Schema.Literals(["cafe", "park"]), { filter: ["eq", anyOf] }),
    location: Schema.String.pipe(Filter.able([within])),
    rating: Schema.Finite.pipe(Filter.able(["gt"])),
  },
});

const codec = Query.Filter(Place);
const decode = Schema.decodeUnknownSync(codec);
const encode = Schema.encodeSync(codec);

const firstKey = (path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string => {
  const segment = path?.[0];
  return String(P.isObject(segment) ? segment.key : segment);
};
const failuresOf =
  (schema: Schema.Decoder<unknown>) =>
  (
    record: R.ReadonlyRecord<string, unknown>,
  ): ReadonlyArray<{ readonly key: string; readonly message: string }> => {
    const result = Schema.decodeResult(schema)(record);
    assert(Result.isFailure(result), "expected the decode to fail");
    return SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.map(
      (issue) => ({ key: firstKey(issue.path), message: issue.message }),
    );
  };
const failures = failuresOf(codec);

describe("Filter.operator", () => {
  it("refuses a malformed or taken name, and an empty appliesTo", () => {
    expect(() => Filter.operator("not a name")).toThrow(/letters, digits and _/);
    expect(() => Filter.operator("contains")).toThrow(/taken by the built-in vocabulary/);
    expect(() => Filter.operator("OR")).toThrow(/taken by the built-in vocabulary/);
    expect(() => Filter.operator("x", { appliesTo: [] as never })).toThrow(/appliesTo names/);
    expect(Filter.isCustomOperator(like)).toBe(true);
    expect(Filter.isCustomOperator("like")).toBe(false);
    expect(Filter.isOperator("like")).toBe(false);
  });

  it("declares the operator by name, carrying its definition", () => {
    const fields = Resource.filterable(Place);
    expect(fields.name.operators).toEqual(["eq", "like"]);
    expect(fields.name.custom).toEqual([like]);
    expect(fields.kind.custom).toEqual([anyOf]);
    expect("custom" in fields.rating).toBe(false);
  });

  it("refuses a declaration the operator does not apply to", () => {
    expect(() =>
      Resource.make("bad", { attributes: { n: Schema.Finite.pipe(Filter.able([like])) } }),
    ).toThrow(/declares filter operator like, which applies to string attributes only/);
    const other = Filter.operator("like");
    expect(() => Schema.String.pipe(Filter.able([like, other]))).toThrow(
      /two custom operators named "like"/,
    );
  });
});

describe("custom operators in the bracket grammar", () => {
  it("decodes a scalar, a list and an own-literal operator to Custom nodes", () => {
    expect(decode({ "filter[name][like]": "%x%" })).toEqual(Filter.custom(like, "name", "%x%"));
    expect(decode({ "filter[kind][anyOf]": "park,cafe" })).toEqual(
      Filter.custom(anyOf, "kind", ["cafe", "park"]),
    );
    expect(decode({ "filter[kind][anyOf]": ["park", "park"] })).toEqual(
      Filter.custom(anyOf, "kind", ["park"]),
    );
    expect(decode({ "filter[location][within]": "250" })).toEqual(
      Filter.custom(within, "location", 250),
    );
    expect(
      decode({
        "filter[c][condition][path]": "name",
        "filter[c][condition][operator]": "like",
        "filter[c][condition][value]": "a\\,b",
      }),
    ).toEqual(Filter.custom(like, "name", "a,b"));
  });

  it("rejects a custom operator another field declares, and a bad literal", () => {
    expect(failures({ "filter[rating][like]": "x" })).toEqual([
      {
        key: "filter[rating][like]",
        message: 'Operator "like" is not declared on field "rating"; declared operators are gt',
      },
    ]);
    expect(failures({ "filter[name][nope]": "x" })[0]?.message).toMatch(
      /expected one of eq, .*, endsWith, like, anyOf, within$/,
    );
    expect(failures({ "filter[kind][anyOf]": "cafe,pub" })[0]?.message).toMatch(
      /^Invalid literal "pub" for field "kind"/,
    );
    expect(failures({ "filter[location][within]": "far" })[0]?.key).toBe(
      "filter[location][within]",
    );
  });

  it("encodes canonically, list literals sorted and deduplicated", () => {
    expect(encode(Filter.custom(like, "name", "%a,b"))).toEqual({
      "filter[name][like]": "%a\\,b",
    });
    expect(encode(Filter.custom(anyOf, "kind", ["park", "cafe", "park"]))).toEqual({
      "filter[kind][anyOf]": "cafe,park",
    });
    expect(encode(Filter.custom(within, "location", 1.5))).toEqual({
      "filter[location][within]": "1.5",
    });
    expect(() => encode(Filter.custom(anyOf, "kind", "cafe" as never))).toThrow(
      /takes a list of literals/,
    );
    expect(() => encode(Filter.custom(like, "rating" as "name", "x"))).toThrow(/not declared/);
  });

  it("normalises and validates Custom nodes outside a codec", () => {
    const fields = Resource.filterable(Place);
    expect(Filter.normalise(Filter.custom(anyOf, "kind", ["park", "cafe"]), fields)).toEqual(
      Filter.custom(anyOf, "kind", ["cafe", "park"]),
    );
    expect(Schema.is(Filter.Ast)(Filter.custom(like, "name", "x"))).toBe(true);
  });

  it("types each Custom node over its field and literal", () => {
    type Customs = Extract<Query.FilterAst<typeof Place>, { readonly _tag: "Custom" }>;
    expectTypeOf<Customs>().toEqualTypeOf<
      | Filter.Custom<"name", "like", string>
      | Filter.Custom<"kind", "anyOf", readonly ["cafe" | "park", ...Array<"cafe" | "park">]>
      | Filter.Custom<"location", "within", number>
    >();
    expectTypeOf<Resource.FilterOperators<typeof Place, "name">>().toEqualTypeOf<"eq" | "like">();
  });
});

// `filter=field:operator:value`, `;`-separated conditions ANDed: a minimal
// expression dialect in the bare `filter` key.
const colon = Filter.dialect({
  name: "colon",
  decode: (input, context) => {
    const raw = input["filter"];
    if (!P.isString(raw))
      return Result.fail([{ key: "filter", message: "Expected one filter expression" }]);
    const nodes: Array<Filter.Node> = [];
    const issues: Array<Filter.DialectIssue> = [];
    raw.split(";").forEach((part) => {
      const [field = "", operator = "", value = ""] = part.split(":");
      Result.match(context.condition({ field, operator, values: value.split("|") }, "filter"), {
        onSuccess: (node) => nodes.push(node),
        onFailure: (issue) => issues.push(issue),
      });
    });
    const [first, ...rest] = issues;
    if (first !== undefined) return Result.fail([first, ...rest]);
    return Result.succeed(nodes.length === 1 ? nodes[0] : Filter.and(...nodes));
  },
  encode: (root) => {
    const parts = (node: Filter.WireNode): ReadonlyArray<string> =>
      P.isTagged(node, "Condition")
        ? [`${node.field}:${node.operator}:${node.values.join("|")}`]
        : node.members.flatMap(parts);
    return { filter: parts(root).join(";") };
  },
});

describe("Filter.Dialect", () => {
  it("is the bracket grammar by default", () => {
    expect(Filter.isDialect(Filter.bracket)).toBe(true);
    expect(Filter.bracket.name).toBe("bracket");
    const explicit = Query.Filter(Place, { dialect: Filter.bracket });
    expect(Schema.encodeSync(explicit)(Filter.gt("rating", 3))).toEqual(
      encode(Filter.gt("rating", 3)),
    );
  });

  it("decodes and encodes through another dialect, under the wire names and checks", () => {
    const filter = Query.Filter(Place, { dialect: colon });
    expect(Schema.decodeSync(filter)({ filter: "kind:anyOf:park|cafe;rating:gt:4" })).toEqual(
      Filter.and(Filter.custom(anyOf, "kind", ["cafe", "park"]), Filter.gt("rating", 4)),
    );
    expect(
      Schema.encodeSync(filter)(
        Filter.and(Filter.gt("rating", 4), Filter.custom(like, "name", "a")),
      ),
    ).toEqual({ filter: "name:like:a;rating:gt:4" });
    expect(failuresOf(filter)({ filter: "rating:lt:4;nope:eq:1" })).toEqual([
      {
        key: "filter",
        message: 'Operator "lt" is not declared on field "rating"; declared operators are gt',
      },
      { key: "filter", message: 'Unknown filter field "nope"' },
    ]);
  });
});

const Api = HttpApi.make("places").add(Group.make(Place, Endpoint.list(Place, { filter: colon })));
const seen: Array<unknown> = [];
const PlacesLive = HttpApiBuilder.group(Api, "places", (handlers) =>
  handlers.handle("list", ({ query }) => {
    seen.push(query.filter);
    return Effect.succeed(Handlers.collection([]));
  }),
);

const request = async (path: string) => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(PlacesLive),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    ),
  );
  const response = await handler(
    new Request(`http://localhost${path}`, { headers: { accept: MEDIA_TYPE } }),
  )
    .then(async (answer) => ({ status: answer.status, text: await answer.text() }))
    .finally(dispose);
  return { status: response.status, body: Schema.decodeSync(Json)(response.text) };
};
const Json = Schema.fromJsonString(Schema.Any);

describe("an endpoint on a dialect", () => {
  it("hands the handler the decoded tree, and answers a 400 naming the key", async () => {
    seen.length = 0;
    expect((await request("/places?filter=name:like:%25x")).status).toBe(200);
    expect(seen).toEqual([Filter.custom(like, "name", "%x")]);
    const bad = await request("/places?filter=name:gt:x");
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0].source).toEqual({ parameter: "filter" });
  });
});
