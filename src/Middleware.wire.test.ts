import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { SchemaErrors } from "./Middleware.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";

// #316: a body, header or path-parameter schema that renames a key with
// `Schema.encodeKeys` rejects a value after the rename under its decoded
// name, which no member, header or parameter of the request carries. The
// 400's `source` names the key the request sent instead, as #305 does for a
// query parameter.

// A count the struct-level check below caps, by its decoded name.
const capped = Schema.makeFilter(
  ({ count }: { readonly count: number }) =>
    count > 10 ? { path: ["count"], issue: "too big" } : undefined,
  { identifier: "countCap", title: "count cap", description: "rejects a count above 10" },
);

const Body = Schema.Struct({
  // A top-level member renamed on the wire, checked as a whole struct too.
  count: Schema.FiniteFromString,
  // A nested member renamed on the wire, inside a member that is not.
  data: Schema.Struct({ size: Schema.FiniteFromString }).pipe(
    Schema.encodeKeys({ size: "item-size" }),
  ),
})
  .pipe(Schema.encodeKeys({ count: "itemCount" }))
  .check(capped);

const Headers = Schema.Struct({
  trace: Schema.optionalKey(Schema.FiniteFromString),
  span: Schema.optionalKey(Schema.FiniteFromString),
}).pipe(Schema.encodeKeys({ trace: "x-trace" }));

const Params = Schema.Struct({ id: Schema.FiniteFromString }).pipe(
  Schema.encodeKeys({ id: "itemId" }),
);

const Api = HttpApi.make("wire").add(
  HttpApiGroup.make("items")
    .add(
      HttpApiEndpoint.post("create", "/items", {
        payload: Body,
        headers: Headers,
        success: Schema.String,
      }).middleware(Middleware.SchemaErrors),
    )
    .add(
      HttpApiEndpoint.get("get", "/items/:itemId", {
        params: Params,
        success: Schema.String,
      }).middleware(Middleware.SchemaErrors),
    ),
);

const ItemsLive = HttpApiBuilder.group(Api, "items", (handlers) =>
  handlers.handle("create", () => Effect.succeed("ok")).handle("get", () => Effect.succeed("ok")),
);

const request = async (
  url: string,
  init: RequestInit = {},
  middlewareLayer: Layer.Layer<SchemaErrors> = Middleware.SchemaErrorsLive,
) => {
  const appLayer = HttpApiBuilder.layer(Api).pipe(
    Layer.provide(ItemsLive),
    Layer.provide(middlewareLayer),
    Layer.provide(platformLayer),
  );
  const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
  const response = await handler(new Request(`http://localhost${url}`, init)).finally(dispose);
  return { status: response.status, body: decodeJson(await response.text()) };
};

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Any));

// The body as the request spells it: the wire side of `Body`.
const WireBody = Schema.toEncoded(Body);
const encodeBody = Schema.encodeSync(Schema.fromJsonString(WireBody));

const post = (body: typeof WireBody.Type, headers: Record<string, string> = {}) =>
  request("/items", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: encodeBody(body),
  });

const valid: typeof WireBody.Type = { itemCount: "1", data: { "item-size": "2" } };

const rejected = (detail: string, source: Record<string, string>) => ({
  status: 400,
  body: {
    errors: [{ status: "400", code: "bad_request", title: "Bad Request", detail, source }],
  },
});

describe("a 400 for a key renamed on the wire names it as the request sent it (#316)", () => {
  it("accepts a request that sends every key by its wire name", async () => {
    expect(await post(valid, { "x-trace": "3" })).toEqual({ status: 200, body: "ok" });
  });

  it("points at a renamed body member by its wire name", async () => {
    expect(await post({ ...valid, itemCount: "x" })).toEqual(
      rejected("Expected a finite number", { pointer: "/itemCount" }),
    );
  });

  it("points at a nested renamed body member by its wire name", async () => {
    expect(await post({ ...valid, data: { "item-size": "x" } })).toEqual(
      rejected("Expected a finite number", { pointer: "/data/item-size" }),
    );
  });

  it("points at a renamed body member a struct-level check rejects by its wire name", async () => {
    expect(await post({ ...valid, itemCount: "11" })).toEqual(
      rejected("too big", { pointer: "/itemCount" }),
    );
  });

  it("names a renamed header by its wire name", async () => {
    expect(await post(valid, { "x-trace": "y" })).toEqual(
      rejected("Expected a finite number", { header: "x-trace" }),
    );
  });

  it("names a header the schema does not rename by its own name, as before", async () => {
    expect(await post(valid, { span: "y" })).toEqual(
      rejected("Expected a finite number", { header: "span" }),
    );
  });

  it("names a renamed path parameter by its wire name", async () => {
    expect(await request("/items/x")).toEqual(
      rejected("Expected a finite number", { parameter: "itemId" }),
    );
  });
});

describe("Middleware.schemaErrorDocument on a renamed body or header (#316)", () => {
  // The decode failure of a result the test expects to fail.
  const failure = <A>(result: Result.Result<A, Schema.SchemaError>) =>
    Result.match(result, {
      onFailure: (error) => error,
      onSuccess: () => expect.unreachable("expected a decode failure"),
    });

  it("names the wire key the issue's reproduction sends", () => {
    const Payload = Schema.Struct({
      data: Schema.Struct({ count: Schema.FiniteFromString }).pipe(
        Schema.encodeKeys({ count: "itemCount" }),
      ),
    });
    expect(
      Middleware.schemaErrorDocument(
        "Payload",
        failure(Schema.decodeUnknownResult(Payload)({ data: { itemCount: "x" } })),
      ).errors[0]?.source,
    ).toEqual({ pointer: "/data/itemCount" });
    const Trace = Schema.Struct({ trace: Schema.FiniteFromString }).pipe(
      Schema.encodeKeys({ trace: "x-trace" }),
    );
    expect(
      Middleware.schemaErrorDocument(
        "Headers",
        failure(Schema.decodeUnknownResult(Trace)({ "x-trace": "y" })),
      ).errors[0]?.source,
    ).toEqual({ header: "x-trace" });
    expect(
      Middleware.schemaErrorDocument(
        "Body",
        failure(Schema.decodeUnknownResult(Payload)({ data: { itemCount: "x" } })),
      ).errors[0]?.source,
    ).toEqual({ pointer: "/data/itemCount" });
  });
});
