/**
 * Request bodies that send `attributes` / `relationships` members a resource
 * doesn't declare (#270, #292). Every write body member struct, whether it
 * declares fields or none, answers 400 with a `source.pointer` at each
 * undeclared member, through the real middleware stack, instead of dropping
 * the member (a struct with fields, before #292) or handing it to the handler
 * (a struct with none, before #270). A non-object member answers 400
 * `Expected object` at the member, a `null` included (#286). The members
 * JSON:API allows around them (`meta`, `jsonapi`, `links`) are still accepted,
 * the OpenAPI document still describes each member's properties, and encoding
 * (what a client does) rejects an undeclared member as decoding does. A member
 * reports at most `maxUndeclaredMemberErrors` (default 12) of them at their own
 * pointers, and one summary error at the member for the rest (#308).
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { HttpClient, HttpClientRequest, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import * as Client from "./Client.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import { layerWith } from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { annotate, attribute, extend, family, make as Resource } from "./Resource.js";
import type { Any } from "./Resource.js";
import { platformLayer } from "./Registry.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Owner = Resource("owners", { attributes: { name: Schema.String } });
// Declares no attributes.
const Flag = Resource("flags", {
  attributes: {},
  relationships: { owner: Relationship.optional(() => Owner) },
});
// Declares no relationships.
const Note = Resource("notes", { attributes: { body: Schema.String } });
// Served through the flat `createInput` / `updateInput` payloads.
const Memo = Resource("memos", { attributes: { body: Schema.String } });
// Reports two undeclared members per member, not the default 12 (#308).
const Capped = Resource("capped", {
  attributes: { body: Schema.String },
  relationships: { owner: Relationship.optional(() => Owner) },
  maxUndeclaredMemberErrors: 2,
});

const Api = HttpApi.make("undeclared")
  .add(Group.make(Flag, Endpoint.create(Flag), Endpoint.update(Flag)))
  .add(Group.make(Note, Endpoint.create(Note), Endpoint.update(Note)))
  .add(
    Group.make(
      Memo,
      Endpoint.create(Memo, { payload: Memo.createInput }),
      Endpoint.update(Memo, { payload: Memo.updateInput }),
    ),
  )
  .add(Group.make(Capped, Endpoint.create(Capped), Endpoint.update(Capped)))
  .add(Group.make("operations", Endpoint.operations([Flag, Note])));

// Every resource `data` a handler is handed, so a test can assert what reached it.
interface Received {
  readonly type: string;
  readonly attributes?: object;
  readonly relationships?: object;
}
// Every flat payload a `memos` handler is handed.
const receivedFlat: Array<object> = [];
const received: Array<Received> = [];

const FlagsLive = HttpApiBuilder.group(Api, "flags", (handlers) =>
  handlers
    .handle("create", ({ payload }) => {
      received.push(payload.data);
      return Effect.succeed({ data: Flag.make({ id: Flag.Id.make("1"), attributes: {} }) });
    })
    .handle("update", ({ params, payload }) => {
      received.push(payload.data);
      return Effect.succeed({ data: Flag.make({ id: params.id, attributes: {} }) });
    }),
);

const NotesLive = HttpApiBuilder.group(Api, "notes", (handlers) =>
  handlers
    .handle("create", ({ payload }) => {
      received.push(payload.data);
      return Effect.succeed({
        data: Note.make({ id: Note.Id.make("1"), attributes: payload.data.attributes }),
      });
    })
    .handle("update", ({ params, payload }) => {
      received.push(payload.data);
      return Effect.succeed({ data: Note.make({ id: params.id, attributes: { body: "b" } }) });
    }),
);

const MemosLive = HttpApiBuilder.group(Api, "memos", (handlers) =>
  handlers
    .handle("create", ({ payload }) => {
      receivedFlat.push(payload);
      return Effect.succeed({
        data: Memo.make({ id: Memo.Id.make("1"), attributes: { body: payload.body } }),
      });
    })
    .handle("update", ({ params, payload }) => {
      receivedFlat.push(payload);
      return Effect.succeed({ data: Memo.make({ id: params.id, attributes: { body: "b" } }) });
    }),
);

const CappedLive = HttpApiBuilder.group(Api, "capped", (handlers) =>
  handlers
    .handle("create", ({ payload }) => {
      received.push(payload.data);
      return Effect.succeed({
        data: Capped.make({ id: Capped.Id.make("1"), attributes: payload.data.attributes }),
      });
    })
    .handle("update", ({ params, payload }) => {
      received.push(payload.data);
      return Effect.succeed({ data: Capped.make({ id: params.id, attributes: { body: "b" } }) });
    }),
);

const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) => {
    // These tests send only resource `add` / `update` operations.
    received.push(
      ...payload["atomic:operations"].flatMap((operation) =>
        operation.op === "remove" || Atomic.isRelationshipOperation(operation)
          ? []
          : [operation.data],
      ),
    );
    return Effect.succeed({ "atomic:results": payload["atomic:operations"].map(() => ({})) });
  }),
);

const AppLive = HttpApiBuilder.layer(Api).pipe(
  Layer.provide([FlagsLive, NotesLive, MemosLive, CappedLive, OperationsLive]),
  Layer.provide(layerWith({ extensions: [Atomic.EXTENSION_URI] })),
  Layer.provide(platformLayer),
);

const send = async (method: "POST" | "PATCH", path: string, body: string) => {
  const mediaType = path === "/operations" ? Atomic.MEDIA_TYPE : MEDIA_TYPE;
  const { dispose, handler } = HttpRouter.toWebHandler(AppLive);
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": mediaType, accept: mediaType },
      body,
    }),
  ).finally(dispose);
  return { status: response.status, text: await response.text() };
};

const ErrorDocument = Schema.fromJsonString(
  Schema.Struct({
    errors: Schema.Array(
      Schema.Struct({
        status: Schema.String,
        code: Schema.String,
        title: Schema.String,
        detail: Schema.String,
        // Absent on an error at the body itself: a flat payload's summary (#308).
        source: Schema.optionalKey(Schema.Struct({ pointer: Schema.String })),
      }),
    ),
  }),
);
const errorsOf = (text: string) => Schema.decodeUnknownSync(ErrorDocument)(text).errors;

const polluted = (): boolean =>
  Object.prototype.hasOwnProperty.call(Object.prototype, "polluted") || Reflect.has({}, "polluted");

// A body is spelled as text so an own `__proto__` key survives to the server
// exactly as a client's JSON would carry it (`JSON.parse` makes it an own key).
const ownerLinkage = '{"data":{"type":"owners","id":"1"}}';
const memberValue = '{"polluted":true}';

type Case = readonly [
  name: string,
  method: "POST" | "PATCH",
  path: string,
  body: (member: string) => string,
  pointer: (member: string) => string,
];

const op = (operation: string) => `{"atomic:operations":[${operation}]}`;

const cases: ReadonlyArray<Case> = [
  [
    "createPayload attributes (no attributes declared)",
    "POST",
    "/flags",
    (m) => `{"data":{"type":"flags","attributes":{"${m}":${memberValue}}}}`,
    (m) => `/data/attributes/${m}`,
  ],
  [
    "updatePayload attributes (no attributes declared)",
    "PATCH",
    "/flags/1",
    (m) => `{"data":{"type":"flags","id":"1","attributes":{"${m}":${memberValue}}}}`,
    (m) => `/data/attributes/${m}`,
  ],
  [
    "createPayload relationships (no relationships declared)",
    "POST",
    "/notes",
    (m) =>
      `{"data":{"type":"notes","attributes":{"body":"b"},"relationships":{"${m}":${ownerLinkage}}}}`,
    (m) => `/data/relationships/${m}`,
  ],
  [
    "updatePayload relationships (no relationships declared)",
    "PATCH",
    "/notes/1",
    (m) => `{"data":{"type":"notes","id":"1","relationships":{"${m}":${ownerLinkage}}}}`,
    (m) => `/data/relationships/${m}`,
  ],
  [
    "atomic add attributes (no attributes declared)",
    "POST",
    "/operations",
    (m) => op(`{"op":"add","data":{"type":"flags","attributes":{"${m}":${memberValue}}}}`),
    (m) => `/atomic:operations/0/data/attributes/${m}`,
  ],
  [
    "atomic update attributes (no attributes declared)",
    "POST",
    "/operations",
    (m) =>
      op(`{"op":"update","data":{"type":"flags","id":"1","attributes":{"${m}":${memberValue}}}}`),
    (m) => `/atomic:operations/0/data/attributes/${m}`,
  ],
  [
    "atomic add relationships (no relationships declared)",
    "POST",
    "/operations",
    (m) =>
      op(
        `{"op":"add","data":{"type":"notes","attributes":{"body":"b"},"relationships":{"${m}":${ownerLinkage}}}}`,
      ),
    (m) => `/atomic:operations/0/data/relationships/${m}`,
  ],
  [
    "atomic update relationships (no relationships declared)",
    "POST",
    "/operations",
    (m) =>
      op(
        `{"op":"update","data":{"type":"notes","id":"1","relationships":{"${m}":${ownerLinkage}}}}`,
      ),
    (m) => `/atomic:operations/0/data/relationships/${m}`,
  ],
  // Members that declare fields (#292): the declared member is sent too.
  [
    "createPayload attributes (attributes declared)",
    "POST",
    "/notes",
    (m) => `{"data":{"type":"notes","attributes":{"body":"b","${m}":${memberValue}}}}`,
    (m) => `/data/attributes/${m}`,
  ],
  [
    "updatePayload attributes (attributes declared)",
    "PATCH",
    "/notes/1",
    (m) => `{"data":{"type":"notes","id":"1","attributes":{"body":"b","${m}":${memberValue}}}}`,
    (m) => `/data/attributes/${m}`,
  ],
  [
    "createPayload relationships (relationships declared)",
    "POST",
    "/flags",
    (m) =>
      `{"data":{"type":"flags","attributes":{},"relationships":{"owner":${ownerLinkage},"${m}":${ownerLinkage}}}}`,
    (m) => `/data/relationships/${m}`,
  ],
  [
    "updatePayload relationships (relationships declared)",
    "PATCH",
    "/flags/1",
    (m) =>
      `{"data":{"type":"flags","id":"1","relationships":{"owner":${ownerLinkage},"${m}":${ownerLinkage}}}}`,
    (m) => `/data/relationships/${m}`,
  ],
  [
    "atomic add attributes (attributes declared)",
    "POST",
    "/operations",
    (m) =>
      op(`{"op":"add","data":{"type":"notes","attributes":{"body":"b","${m}":${memberValue}}}}`),
    (m) => `/atomic:operations/0/data/attributes/${m}`,
  ],
  [
    "atomic update attributes (attributes declared)",
    "POST",
    "/operations",
    (m) =>
      op(
        `{"op":"update","data":{"type":"notes","id":"1","attributes":{"body":"b","${m}":${memberValue}}}}`,
      ),
    (m) => `/atomic:operations/0/data/attributes/${m}`,
  ],
  [
    "atomic add relationships (relationships declared)",
    "POST",
    "/operations",
    (m) =>
      op(
        `{"op":"add","data":{"type":"flags","attributes":{},"relationships":{"owner":${ownerLinkage},"${m}":${ownerLinkage}}}}`,
      ),
    (m) => `/atomic:operations/0/data/relationships/${m}`,
  ],
  [
    "atomic update relationships (relationships declared)",
    "POST",
    "/operations",
    (m) =>
      op(
        `{"op":"update","data":{"type":"flags","id":"1","relationships":{"owner":${ownerLinkage},"${m}":${ownerLinkage}}}}`,
      ),
    (m) => `/atomic:operations/0/data/relationships/${m}`,
  ],
  // The flat payloads: `createInput` is the create attributes struct itself,
  // `updateInput` the update attributes plus `id`.
  [
    "createInput (flat create payload)",
    "POST",
    "/memos",
    (m) => `{"body":"b","${m}":${memberValue}}`,
    (m) => `/${m}`,
  ],
  [
    "updateInput (flat update payload)",
    "PATCH",
    "/memos/1",
    (m) => `{"id":"1","body":"b","${m}":${memberValue}}`,
    (m) => `/${m}`,
  ],
];

const members = ["isAdmin", "__proto__", "constructor"] as const;

describe("a request body member the resource doesn't declare (#270, #292)", () => {
  describe.each(cases)("%s", (_, method, path, body, pointer) => {
    it.each(members)("answers 400 at the member %s and never calls the handler", async (m) => {
      received.length = 0;
      receivedFlat.length = 0;
      const response = await send(method, path, body(m));
      expect(response.status).toBe(400);
      const errors = errorsOf(response.text);
      // An atomic operation decodes against a union of every resource's
      // operations, and a rejected union reports an error per candidate (the
      // other resource's `data/type`, an update's missing `ref`). So the
      // assertion is on the errors at the member; elsewhere that is all of them.
      const atMember = errors.filter(({ source }) => source?.pointer === pointer(m));
      expect(path === "/operations" ? atMember : errors).toEqual([
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: "Expected no excess property",
          source: { pointer: pointer(m) },
        },
      ]);
      expect(received).toEqual([]);
      expect(receivedFlat).toEqual([]);
      expect(polluted()).toBe(false);
    });
  });

  // Below the cap (#308), so every one is reported.
  it("reports each undeclared member below the cap at its own pointer", async () => {
    const response = await send(
      "POST",
      "/flags",
      '{"data":{"type":"flags","attributes":{"a":1,"b/c":2,"a~b/c":3}}}',
    );
    expect(response.status).toBe(400);
    expect(errorsOf(response.text).map(({ source }) => source)).toEqual([
      { pointer: "/data/attributes/a" },
      { pointer: "/data/attributes/b~1c" },
      { pointer: "/data/attributes/a~0b~1c" },
    ]);
  });

  it("reports each undeclared member beside a declared one below the cap at its own pointer (#292)", async () => {
    received.length = 0;
    const response = await send(
      "POST",
      "/notes",
      '{"data":{"type":"notes","attributes":{"body":"b","a":1,"b/c":2,"a~b/c":3}}}',
    );
    expect(response.status).toBe(400);
    expect(errorsOf(response.text).map(({ detail, source }) => [detail, source?.pointer])).toEqual([
      ["Expected no excess property", "/data/attributes/a"],
      ["Expected no excess property", "/data/attributes/b~1c"],
      ["Expected no excess property", "/data/attributes/a~0b~1c"],
    ]);
    expect(received).toEqual([]);
  });
});

describe("the errors a 400 reports for undeclared members are capped (#308)", () => {
  // `n` undeclared members, `k0` … `k<n-1>`, as the inside of a JSON object.
  const keys = (n: number): string =>
    Array.from({ length: n }, (_, index) => `"k${index}":1`).join(",");
  const pointersTo = (member: string, n: number): ReadonlyArray<string> =>
    Array.from({ length: n }, (_, index) => `${member}/k${index}`);

  // Every write body member, with a body that sends `members` in it.
  const sites: ReadonlyArray<
    readonly [
      name: string,
      method: "POST" | "PATCH",
      path: string,
      body: (members: string) => string,
      member: string,
    ]
  > = [
    [
      "createPayload attributes",
      "POST",
      "/notes",
      (ms) => `{"data":{"type":"notes","attributes":{"body":"b",${ms}}}}`,
      "/data/attributes",
    ],
    [
      "updatePayload attributes",
      "PATCH",
      "/notes/1",
      (ms) => `{"data":{"type":"notes","id":"1","attributes":{${ms}}}}`,
      "/data/attributes",
    ],
    [
      "createPayload relationships",
      "POST",
      "/flags",
      (ms) => `{"data":{"type":"flags","attributes":{},"relationships":{${ms}}}}`,
      "/data/relationships",
    ],
    [
      "updatePayload relationships",
      "PATCH",
      "/notes/1",
      (ms) => `{"data":{"type":"notes","id":"1","relationships":{${ms}}}}`,
      "/data/relationships",
    ],
    ["createInput", "POST", "/memos", (ms) => `{"body":"b",${ms}}`, ""],
    ["updateInput", "PATCH", "/memos/1", (ms) => `{"id":"1",${ms}}`, ""],
    [
      "atomic add attributes",
      "POST",
      "/operations",
      (ms) => op(`{"op":"add","data":{"type":"notes","attributes":{"body":"b",${ms}}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic update attributes",
      "POST",
      "/operations",
      (ms) => op(`{"op":"update","data":{"type":"flags","id":"1","attributes":{${ms}}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic add relationships",
      "POST",
      "/operations",
      (ms) => op(`{"op":"add","data":{"type":"flags","attributes":{},"relationships":{${ms}}}}`),
      "/atomic:operations/0/data/relationships",
    ],
    [
      "atomic update relationships",
      "POST",
      "/operations",
      (ms) => op(`{"op":"update","data":{"type":"notes","id":"1","relationships":{${ms}}}}`),
      "/atomic:operations/0/data/relationships",
    ],
  ];

  // The [detail, pointer] of each error at or under the member. An atomic
  // operation also reports the other resource's rejected candidate (see above).
  const reportedAt = (text: string, member: string) =>
    errorsOf(text)
      .filter(({ source }) => member === "" || source?.pointer.startsWith(member))
      .map(({ detail, source }) => [detail, source?.pointer]);
  // A flat payload's member is the body itself: its summary is an error with
  // no `source`, as the middleware renders any error at the whole body.
  const memberPointer = (member: string) => (member === "" ? undefined : member);
  const excess = (member: string, n: number) =>
    pointersTo(member, n).map((pointer) => ["Expected no excess property", pointer]);

  describe.each(sites)("%s", (_, method, path, body, member) => {
    it("10,000 undeclared members: 12 at their own pointers, one summary, a bounded body", async () => {
      received.length = 0;
      receivedFlat.length = 0;
      const request = body(keys(10_000));
      const response = await send(method, path, request);
      expect(response.status).toBe(400);
      expect(reportedAt(response.text, member)).toEqual([
        ...excess(member, 12),
        ["9988 more undeclared members not listed", memberPointer(member)],
      ]);
      // The request is ~100 KB; the 400 stays a few KB however many keys come.
      expect(request.length).toBeGreaterThan(90_000);
      expect(response.text.length).toBeLessThan(path === "/operations" ? 8_192 : 4_096);
      expect(received).toEqual([]);
      expect(receivedFlat).toEqual([]);
    });

    it("exactly 12 undeclared members: each at its own pointer, no summary", async () => {
      const response = await send(method, path, body(keys(12)));
      expect(response.status).toBe(400);
      expect(reportedAt(response.text, member)).toEqual(excess(member, 12));
    });

    it("13 undeclared members: 12 at their own pointers, and 1 more", async () => {
      const response = await send(method, path, body(keys(13)));
      expect(response.status).toBe(400);
      expect(reportedAt(response.text, member)).toEqual([
        ...excess(member, 12),
        ["1 more undeclared member not listed", memberPointer(member)],
      ]);
    });
  });

  it("the summary renders as a 400 error object at the member", async () => {
    const response = await send("POST", "/notes", sites[0][3](keys(13)));
    expect(errorsOf(response.text).at(-1)).toEqual({
      status: "400",
      code: "bad_request",
      title: "Bad Request",
      detail: "1 more undeclared member not listed",
      source: { pointer: "/data/attributes" },
    });
  });

  it("a configured cap is honoured over HTTP, on create and on update", async () => {
    received.length = 0;
    const create = await send(
      "POST",
      "/capped",
      `{"data":{"type":"capped","attributes":{"body":"b",${keys(5)}}}}`,
    );
    const update = await send(
      "PATCH",
      "/capped/1",
      `{"data":{"type":"capped","id":"1","relationships":{${keys(3)}}}}`,
    );
    expect([create.status, update.status]).toEqual([400, 400]);
    expect(reportedAt(create.text, "/data/attributes")).toEqual([
      ...excess("/data/attributes", 2),
      ["3 more undeclared members not listed", "/data/attributes"],
    ]);
    expect(reportedAt(update.text, "/data/relationships")).toEqual([
      ...excess("/data/relationships", 2),
      ["1 more undeclared member not listed", "/data/relationships"],
    ]);
    expect(received).toEqual([]);
  });
});

describe("the maxUndeclaredMemberErrors option (#308)", () => {
  const issuesOf = (result: Result.Result<unknown, Schema.SchemaError>) =>
    Result.match(result, {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });
  const extras = (n: number): Record<string, number> =>
    Rec.fromEntries(Array.from({ length: n }, (_, index) => [`k${index}`, 1] as const));
  // What a member with five undeclared members reports under a cap of 2.
  const cappedAt = (path: ReadonlyArray<string>) => [
    { path: [...path, "k0"], message: "Expected no excess property" },
    { path: [...path, "k1"], message: "Expected no excess property" },
    { path, message: "3 more undeclared members not listed" },
  ];

  // Every write body member `Capped` derives, with five undeclared members.
  const sites: ReadonlyArray<
    readonly [string, Schema.Codec<unknown, unknown>, object, ReadonlyArray<string>]
  > = [
    [
      "createPayload attributes",
      Capped.createPayload,
      { data: { type: "capped", attributes: { body: "b", ...extras(5) } } },
      ["data", "attributes"],
    ],
    [
      "createPayload relationships",
      Capped.createPayload,
      { data: { type: "capped", attributes: { body: "b" }, relationships: extras(5) } },
      ["data", "relationships"],
    ],
    [
      "updatePayload attributes",
      Capped.updatePayload,
      { data: { type: "capped", id: "1", attributes: extras(5) } },
      ["data", "attributes"],
    ],
    [
      "updatePayload relationships",
      Capped.updatePayload,
      { data: { type: "capped", id: "1", relationships: extras(5) } },
      ["data", "relationships"],
    ],
    ["createInput", Capped.createInput, { body: "b", ...extras(5) }, []],
    ["updateInput", Capped.updateInput, { id: "1", ...extras(5) }, []],
    [
      "atomic add attributes",
      Atomic.AddOperation(Capped),
      { op: "add", data: { type: "capped", attributes: { body: "b", ...extras(5) } } },
      ["data", "attributes"],
    ],
    [
      "atomic add relationships",
      Atomic.AddOperation(Capped),
      { op: "add", data: { type: "capped", attributes: { body: "b" }, relationships: extras(5) } },
      ["data", "relationships"],
    ],
    [
      "atomic update attributes",
      Atomic.UpdateOperation(Capped),
      { op: "update", data: { type: "capped", id: "1", attributes: extras(5) } },
      ["data", "attributes"],
    ],
    [
      "atomic update relationships",
      Atomic.UpdateOperation(Capped),
      { op: "update", data: { type: "capped", id: "1", relationships: extras(5) } },
      ["data", "relationships"],
    ],
  ];

  it.each(sites)("%s: decode and encode both honour it", (_, schema, value, path) => {
    // `Client` and `HttpBody` encode a payload through `Schema.toCodecJson`.
    const codec = Schema.toCodecJson(schema);
    expect(issuesOf(Schema.decodeUnknownResult(codec)(value))).toEqual(cappedAt(path));
    expect(issuesOf(Schema.encodeUnknownResult(codec)(value))).toEqual(cappedAt(path));
  });

  it("a Client fails the call with the capped issues before sending anything", async () => {
    const sent: Array<HttpClientRequest.HttpClientRequest> = [];
    const recording = HttpClient.make((request) => {
      sent.push(request);
      return Effect.die("no request should be sent");
    });
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.make(Api, { baseUrl: "http://localhost" });
        return yield* client.capped.create({
          payload: { data: { type: "capped", attributes: { body: "b", ...extras(5) } } },
        });
      }).pipe(Effect.provideService(HttpClient.HttpClient, recording), Effect.flip),
    );
    expect(Schema.isSchemaError(error)).toBe(true);
    expect(
      Schema.isSchemaError(error)
        ? SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues
        : [],
    ).toEqual(cappedAt(["data", "attributes"]));
    expect(sent).toEqual([]);
  });

  it("is 12 by default, and is read back from the definition", () => {
    expect(Note.maxUndeclaredMemberErrors).toBe(12);
    expect(Capped.maxUndeclaredMemberErrors).toBe(2);
  });

  it("Infinity reports every undeclared member, with no summary", () => {
    const Open = Resource("open", {
      attributes: { body: Schema.String },
      maxUndeclaredMemberErrors: Number.POSITIVE_INFINITY,
    });
    const issues = issuesOf(
      Schema.decodeUnknownResult(Open.createInput)({ body: "b", ...extras(100) }),
    );
    expect(issues).toHaveLength(100);
    expect(issues.every(({ message }) => message === "Expected no excess property")).toBe(true);
  });

  it("is inherited by extend and kept by annotate, and extend can override it", () => {
    const Child = extend(Capped, "children", { attributes: { extra: Schema.String } });
    const Wider = extend(Capped, "wider", { maxUndeclaredMemberErrors: 4 });
    const Annotated = annotate(Capped, { "acme/table": "capped" });
    expect([Child, Wider, Annotated].map((r) => r.maxUndeclaredMemberErrors)).toEqual([2, 4, 2]);
    expect(
      issuesOf(
        Schema.decodeUnknownResult(Child.createInput)({ body: "b", extra: "e", ...extras(5) }),
      ),
    ).toEqual(cappedAt([]));
    expect(
      issuesOf(Schema.decodeUnknownResult(Wider.createInput)({ body: "b", ...extras(5) })),
    ).toEqual([
      ...["k0", "k1", "k2", "k3"].map((k) => ({
        path: [k],
        message: "Expected no excess property",
      })),
      { path: [], message: "1 more undeclared member not listed" },
    ]);
  });

  it("is carried by a family anchored on a base, and absent on a name-only one", () => {
    const Member = extend(Capped, "members");
    const Anchored = family(Capped, [Member]);
    const Named = family("named", [Member]);
    expect([Anchored.maxUndeclaredMemberErrors, Named.maxUndeclaredMemberErrors]).toEqual([
      2,
      undefined,
    ]);
    expect(
      issuesOf(
        Schema.decodeUnknownResult(Atomic.AddOperation(Anchored))({
          op: "add",
          data: { type: "capped", attributes: { body: "b", ...extras(5) } },
        }),
      ),
    ).toEqual(cappedAt(["data", "attributes"]));
  });

  // Invalid values, and how each message prints them: a number with `String`,
  // anything else with `JSON.stringify`. The non-numbers stand for what a
  // caller the types don't check (plain JavaScript) could pass.
  type Invalid = number | string | boolean | { readonly cap: number };
  const invalid: ReadonlyArray<readonly [Invalid, string]> = [
    [0, "0"],
    [-1, "-1"],
    [1.5, "1.5"],
    [Number.NaN, "NaN"],
    [Number.NEGATIVE_INFINITY, "-Infinity"],
    ["12", '"12"'],
    [true, "true"],
    [{ cap: 12 }, '{"cap":12}'],
  ];
  const refusal = (where: string, shown: string) =>
    `${where}: maxUndeclaredMemberErrors must be a positive integer or Infinity, got ${shown}`;
  // Sets `maxUndeclaredMemberErrors` to an `Invalid` value at runtime, as an
  // unchecked caller would. `Object.assign` types the result as the
  // intersection, in which the property still reads as the target's number,
  // so the call it is passed to type-checks.
  const withCap = <T extends { readonly maxUndeclaredMemberErrors: number }>(
    target: T,
    cap: Invalid,
  ) => Object.assign(target, { maxUndeclaredMemberErrors: cap });

  it.each(invalid)("Resource.make refuses %s", (cap, shown) => {
    expect(() =>
      Resource(
        "bad",
        withCap({ attributes: { body: Schema.String }, maxUndeclaredMemberErrors: 1 }, cap),
      ),
    ).toThrow(refusal('Resource.make("bad")', shown));
  });

  it.each(invalid)("Resource.extend refuses %s, naming the extend call", (cap, shown) => {
    expect(() => extend(Capped, "child", withCap({ maxUndeclaredMemberErrors: 1 }, cap))).toThrow(
      refusal('Resource.extend("child")', shown),
    );
  });

  // A hand-rolled `Any`: a schema with the members `Any` names, never through
  // `Resource.make`, so its cap is whatever it carries.
  const handRolled = <Cap extends Pick<Any, "maxUndeclaredMemberErrors">>(cap: Cap) =>
    Object.assign(Schema.Struct({}), {
      type: Note.type,
      Id: Note.Id,
      identifier: Note.identifier,
      relationships: Note.relationships,
      fields: Note.fields,
      declaredAttributes: Note.declaredAttributes,
      ...cap,
    });

  it("a hand-rolled Any with no cap gets the default in the atomic operations", () => {
    const add = Atomic.AddOperation(handRolled({}));
    const update = Atomic.UpdateOperation(handRolled({}));
    const reported = (issues: ReadonlyArray<{ readonly message: string }>) =>
      issues.map(({ message }) => message);
    const twelve = Array.from({ length: 12 }, () => "Expected no excess property");
    expect(
      reported(
        issuesOf(
          Schema.decodeUnknownResult(add)({
            op: "add",
            data: { type: "notes", attributes: { body: "b", ...extras(13) } },
          }),
        ),
      ),
    ).toEqual([...twelve, "1 more undeclared member not listed"]);
    expect(
      reported(
        issuesOf(
          Schema.decodeUnknownResult(update)({
            op: "update",
            data: { type: "notes", id: "1", attributes: extras(13) },
          }),
        ),
      ),
    ).toEqual([...twelve, "1 more undeclared member not listed"]);
  });

  it.each(invalid)("the atomic operations refuse a hand-rolled Any's cap of %s", (cap, shown) => {
    const resource = withCap(handRolled({ maxUndeclaredMemberErrors: 1 }), cap);
    expect(() => Atomic.AddOperation(resource)).toThrow(
      refusal('Atomic.AddOperation("notes")', shown),
    );
    expect(() => Atomic.UpdateOperation(resource)).toThrow(
      refusal('Atomic.UpdateOperation("notes")', shown),
    );
  });

  it("accepts an explicit undefined as the default", () => {
    expect(
      Resource("plain", { attributes: {}, maxUndeclaredMemberErrors: undefined })
        .maxUndeclaredMemberErrors,
    ).toBe(12);
  });
});

describe("a non-object member answers 400 at the member, whether or not it declares fields (#270, #292)", () => {
  // A struct that declares no fields parses any non-nullish input in the
  // pinned effect, so a non-object reaches its member check; that check
  // answers it exactly as a struct with fields does: "Expected object" at the
  // member itself. An array is not an object to either. A `null` fails the
  // empty struct's own not-nullish check before that member check runs, and
  // renders "Expected object" too, not "Expected object | array" (#286).
  const values = ['"x"', "5", "true", "[]", '["a"]', "null"] as const;

  const sites: ReadonlyArray<
    readonly [
      name: string,
      method: "POST" | "PATCH",
      path: string,
      body: (v: string) => string,
      pointer: string,
    ]
  > = [
    [
      "createPayload attributes (none declared)",
      "POST",
      "/flags",
      (v) => `{"data":{"type":"flags","attributes":${v}}}`,
      "/data/attributes",
    ],
    [
      "updatePayload attributes (none declared)",
      "PATCH",
      "/flags/1",
      (v) => `{"data":{"type":"flags","id":"1","attributes":${v}}}`,
      "/data/attributes",
    ],
    [
      "createPayload relationships (none declared)",
      "POST",
      "/notes",
      (v) => `{"data":{"type":"notes","attributes":{"body":"b"},"relationships":${v}}}`,
      "/data/relationships",
    ],
    [
      "updatePayload relationships (none declared)",
      "PATCH",
      "/notes/1",
      (v) => `{"data":{"type":"notes","id":"1","relationships":${v}}}`,
      "/data/relationships",
    ],
    [
      "atomic add attributes (none declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"add","data":{"type":"flags","attributes":${v}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic update attributes (none declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"update","data":{"type":"flags","id":"1","attributes":${v}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic add relationships (none declared)",
      "POST",
      "/operations",
      (v) =>
        op(`{"op":"add","data":{"type":"notes","attributes":{"body":"b"},"relationships":${v}}}`),
      "/atomic:operations/0/data/relationships",
    ],
    [
      "atomic update relationships (none declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"update","data":{"type":"notes","id":"1","relationships":${v}}}`),
      "/atomic:operations/0/data/relationships",
    ],
    // Members that declare fields.
    [
      "createPayload attributes (declared)",
      "POST",
      "/notes",
      (v) => `{"data":{"type":"notes","attributes":${v}}}`,
      "/data/attributes",
    ],
    [
      "updatePayload attributes (declared)",
      "PATCH",
      "/notes/1",
      (v) => `{"data":{"type":"notes","id":"1","attributes":${v}}}`,
      "/data/attributes",
    ],
    [
      "createPayload relationships (declared)",
      "POST",
      "/flags",
      (v) => `{"data":{"type":"flags","attributes":{},"relationships":${v}}}`,
      "/data/relationships",
    ],
    [
      "updatePayload relationships (declared)",
      "PATCH",
      "/flags/1",
      (v) => `{"data":{"type":"flags","id":"1","relationships":${v}}}`,
      "/data/relationships",
    ],
    [
      "atomic add attributes (declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"add","data":{"type":"notes","attributes":${v}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic update attributes (declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"update","data":{"type":"notes","id":"1","attributes":${v}}}`),
      "/atomic:operations/0/data/attributes",
    ],
    [
      "atomic add relationships (declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"add","data":{"type":"flags","attributes":{},"relationships":${v}}}`),
      "/atomic:operations/0/data/relationships",
    ],
    [
      "atomic update relationships (declared)",
      "POST",
      "/operations",
      (v) => op(`{"op":"update","data":{"type":"flags","id":"1","relationships":${v}}}`),
      "/atomic:operations/0/data/relationships",
    ],
  ];

  describe.each(sites)("%s", (_, method, path, body, pointer) => {
    it.each(values)("%s answers 400 Expected object and never calls the handler", async (v) => {
      received.length = 0;
      const response = await send(method, path, body(v));
      expect(response.status).toBe(400);
      const errors = errorsOf(response.text);
      const atMember = errors.filter(({ source }) => source?.pointer.startsWith(pointer));
      expect(path === "/operations" ? atMember : errors).toEqual([
        {
          status: "400",
          code: "bad_request",
          title: "Bad Request",
          detail: "Expected object",
          source: { pointer },
        },
      ]);
      expect(received).toEqual([]);
    });
  });
});

describe("an empty member the resource declares nothing for is still accepted (#270)", () => {
  it.each([
    ["createPayload attributes", "POST", "/flags", '{"data":{"type":"flags","attributes":{}}}'],
    [
      "updatePayload attributes",
      "PATCH",
      "/flags/1",
      '{"data":{"type":"flags","id":"1","attributes":{}}}',
    ],
    [
      "createPayload relationships",
      "POST",
      "/notes",
      '{"data":{"type":"notes","attributes":{"body":"b"},"relationships":{}}}',
    ],
    [
      "updatePayload relationships",
      "PATCH",
      "/notes/1",
      '{"data":{"type":"notes","id":"1","relationships":{}}}',
    ],
    [
      "atomic add and update",
      "POST",
      "/operations",
      op(
        [
          '{"op":"add","data":{"type":"flags","attributes":{}}}',
          '{"op":"update","data":{"type":"flags","id":"1","attributes":{}}}',
          '{"op":"add","data":{"type":"notes","attributes":{"body":"b"},"relationships":{}}}',
          '{"op":"update","data":{"type":"notes","id":"1","relationships":{}}}',
        ].join(","),
      ),
    ],
  ] as const)("%s: {} reaches the handler as {}", async (_, method, path, body) => {
    received.length = 0;
    const response = await send(method, path, body);
    expect(response.status).toBeLessThan(300);
    // the member the resource declares nothing for decodes to `{}` exactly
    const empties = received.map((data) =>
      data.type === "flags" ? data.attributes : data.relationships,
    );
    expect(empties.length).toBeGreaterThan(0);
    expect(empties).toEqual(empties.map(() => ({})));
  });
});

describe("a member struct left empty by write projections (#270)", () => {
  // Every attribute excluded from create and update, and every relationship
  // `paginated`: each write member struct declares nothing.
  const Stamp = Resource("stamps", {
    attributes: { at: attribute(Schema.String, { create: false, update: false }) },
    relationships: { notes: Relationship.paginated(() => Note) },
  });

  const projections: ReadonlyArray<
    readonly [string, Schema.Codec<unknown, unknown>, unknown, ReadonlyArray<string>]
  > = [
    [
      "createPayload attributes",
      Stamp.createPayload,
      { data: { type: "stamps", attributes: { at: "x" } } },
      ["data", "attributes", "at"],
    ],
    [
      "updatePayload attributes",
      Stamp.updatePayload,
      { data: { type: "stamps", id: "1", attributes: { at: "x" } } },
      ["data", "attributes", "at"],
    ],
    [
      "createPayload relationships",
      Stamp.createPayload,
      { data: { type: "stamps", attributes: {}, relationships: { notes: { data: [] } } } },
      ["data", "relationships", "notes"],
    ],
    [
      "updatePayload relationships",
      Stamp.updatePayload,
      { data: { type: "stamps", id: "1", relationships: { notes: { data: [] } } } },
      ["data", "relationships", "notes"],
    ],
    ["createInput", Stamp.createInput, { at: "x" }, ["at"]],
    [
      "atomic add",
      Atomic.AddOperation(Stamp),
      {
        op: "add",
        data: { type: "stamps", attributes: {}, relationships: { notes: { data: [] } } },
      },
      ["data", "relationships", "notes"],
    ],
    [
      "atomic update",
      Atomic.UpdateOperation(Stamp),
      { op: "update", data: { type: "stamps", id: "1", attributes: { at: "x" } } },
      ["data", "attributes", "at"],
    ],
  ];

  it.each(projections)("%s rejects the excluded member at its path", (_, schema, input, path) => {
    const issues = Result.match(Schema.decodeUnknownResult(schema)(input), {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });
    expect(issues).toEqual([{ path, message: "Expected no excess property" }]);
  });
});

describe("a null member that declares no fields (#286)", () => {
  // The issue's own reproduction, at the schema: the empty member's `null`
  // renders as the fielded member's does.
  it.each([
    ["declares none", Flag.createPayload, { data: { type: "flags", attributes: null } }],
    ["declares fields", Note.createPayload, { data: { type: "notes", attributes: null } }],
  ] as const)("%s: Expected object at the member", (_, schema, input) => {
    const issues = Result.match(Schema.decodeUnknownResult(schema)(input), {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });
    expect(issues).toEqual([{ path: ["data", "attributes"], message: "Expected object" }]);
  });

  // The message names no OpenAPI component: the empty member stays the inline
  // closed object #270 made it, with no `noMembers` component.
  it("leaves the member an inline closed object in the OpenAPI document", () => {
    const RequestBody = Schema.Struct({
      content: Schema.Record(
        Schema.String,
        Schema.Struct({
          schema: Schema.Struct({
            properties: Schema.Struct({
              data: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
            }),
          }),
        }),
      ),
    });
    const spec = OpenApi.fromApi(Api);
    const members = (path: string, method: "post" | "patch") =>
      Schema.decodeUnknownSync(RequestBody)(spec.paths[path]?.[method]?.requestBody).content[
        MEDIA_TYPE
      ]?.schema.properties.data.properties;
    const closed = {
      not: { type: "null" },
      allOf: [{ type: "object", additionalProperties: false }],
    };
    expect(members("/flags", "post")?.attributes).toEqual(closed);
    expect(members("/flags/{id}", "patch")?.attributes).toEqual(closed);
    expect(members("/notes", "post")?.relationships).toEqual(closed);
    expect(Rec.keys(spec.components.schemas)).toEqual([
      "BadRequestEncoded",
      "UnsupportedMediaTypeEncoded",
      "NotAcceptableEncoded",
    ]);
  });
});

describe("the members JSON:API allows around a closed member are still accepted (#292)", () => {
  // Only `attributes` / `relationships` (and the flat payloads) are closed:
  // the document's `meta` / `jsonapi` / `links`, the resource object's `meta`
  // / `links`, a relationship object's `meta` / `links`, a resource
  // identifier's `meta` and an operation's `meta` are not members of them.
  const meta = '"meta":{"m":1}';
  const links = '"links":{"self":"http://x"}';
  const top = `${meta},"jsonapi":{"version":"1.1"},${links}`;
  const linkage = `{"data":{"type":"owners","id":"1",${meta}},${meta},${links}}`;

  it.each([
    [
      "createPayload",
      "POST",
      "/flags",
      `{"data":{"type":"flags","attributes":{},"relationships":{"owner":${linkage}},${meta},${links}},${top}}`,
      [["flags", [], ["owner"]]],
    ],
    [
      "updatePayload",
      "PATCH",
      "/flags/1",
      `{"data":{"type":"flags","id":"1","relationships":{"owner":${linkage}},${meta},${links}},${top}}`,
      [["flags", [], ["owner"]]],
    ],
    [
      "atomic add and update",
      "POST",
      "/operations",
      `{"atomic:operations":[${[
        `{"op":"add","data":{"type":"notes","attributes":{"body":"b"},${meta}},${meta}}`,
        `{"op":"update","data":{"type":"flags","id":"1","relationships":{"owner":${linkage}},${meta}},${meta}}`,
      ].join(",")}],${meta},"jsonapi":{"version":"1.1"}}`,
      [
        ["notes", ["body"], []],
        ["flags", [], ["owner"]],
      ],
    ],
  ] as const)(
    "%s: 2xx, and the handler gets the declared members",
    async (_, method, path, body, members) => {
      received.length = 0;
      const response = await send(method, path, body);
      expect(response.status).toBeLessThan(300);
      // each `data` the handler got: its type, attribute keys and relationship keys
      expect(
        received.map(({ attributes = {}, relationships = {}, type }) => [
          type,
          Rec.keys(attributes),
          Rec.keys(relationships),
        ]),
      ).toEqual(members);
    },
  );

  it("a declared-only body reaches the handler with exactly the declared members", async () => {
    received.length = 0;
    receivedFlat.length = 0;
    const create = await send(
      "POST",
      "/notes",
      '{"data":{"type":"notes","attributes":{"body":"b"}}}',
    );
    const flat = await send("PATCH", "/memos/1", '{"id":"1","body":"b"}');
    expect([create.status, flat.status]).toEqual([201, 200]);
    expect(received).toEqual([{ type: "notes", attributes: { body: "b" } }]);
    expect(receivedFlat).toEqual([{ id: "1", body: "b" }]);
  });
});

describe("encoding a closed member, as a client does, rejects an undeclared member (#292)", () => {
  // `Client` and `HttpBody` encode a payload through `Schema.toCodecJson`.
  const formatted = (result: Result.Result<unknown, Schema.SchemaError>) =>
    Result.match(result, {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });

  const sites: ReadonlyArray<
    readonly [string, Schema.Codec<unknown, unknown>, object, ReadonlyArray<string>]
  > = [
    [
      "createPayload attributes (declared)",
      Note.createPayload,
      { data: { type: "notes", attributes: { body: "b", extra: 1 } } },
      ["data", "attributes", "extra"],
    ],
    [
      "createPayload attributes (none declared)",
      Flag.createPayload,
      { data: { type: "flags", attributes: { extra: 1 } } },
      ["data", "attributes", "extra"],
    ],
    [
      "updatePayload relationships (declared)",
      Flag.updatePayload,
      { data: { type: "flags", id: "1", relationships: { extra: { data: null } } } },
      ["data", "relationships", "extra"],
    ],
    ["createInput", Memo.createInput, { body: "b", extra: 1 }, ["extra"]],
    ["updateInput", Memo.updateInput, { id: "1", extra: 1 }, ["extra"]],
    [
      "atomic add attributes (declared)",
      Atomic.AddOperation(Note),
      { op: "add", data: { type: "notes", attributes: { body: "b", extra: 1 } } },
      ["data", "attributes", "extra"],
    ],
    [
      "atomic update relationships (declared)",
      Atomic.UpdateOperation(Flag),
      { op: "update", data: { type: "flags", id: "1", relationships: { extra: { data: null } } } },
      ["data", "relationships", "extra"],
    ],
  ];

  it.each(sites)("%s: encode and decode report the same issue", (_, schema, value, path) => {
    const codec = Schema.toCodecJson(schema);
    const expected = [{ path, message: "Expected no excess property" }];
    expect(formatted(Schema.encodeUnknownResult(codec)(value))).toEqual(expected);
    expect(formatted(Schema.decodeUnknownResult(codec)(value))).toEqual(expected);
  });

  it("encodes a value with only declared members as before", () => {
    expect(
      Schema.encodeUnknownSync(Schema.toCodecJson(Note.createPayload))({
        data: { type: "notes", attributes: { body: "b" } },
      }),
    ).toEqual({ data: { type: "notes", attributes: { body: "b" } } });
  });
});

describe("a closed member keeps its fields and its OpenAPI properties (#292)", () => {
  it("keeps `.fields` on createInput and on each payload member", () => {
    expect(Rec.keys(Memo.createInput.fields)).toEqual(["body"]);
    expect(Rec.keys(Memo.updateInput.fields)).toEqual(["body", "id"]);
    expect(Rec.keys(Note.createPayload.fields.data.fields.attributes.fields)).toEqual(["body"]);
  });

  it("describes a member that declares fields by its properties, closed", () => {
    const spec = OpenApi.fromApi(Api);
    const RequestBody = Schema.Struct({
      content: Schema.Record(Schema.String, Schema.Struct({ schema: Schema.Unknown })),
    });
    const Envelope = Schema.Struct({
      properties: Schema.Struct({
        data: Schema.Struct({ properties: Schema.Record(Schema.String, Schema.Unknown) }),
      }),
    });
    const body = (path: string, method: "post" | "patch") =>
      Schema.decodeUnknownSync(RequestBody)(spec.paths[path]?.[method]?.requestBody).content[
        MEDIA_TYPE
      ]?.schema;
    const members = (path: string, method: "post" | "patch") =>
      Schema.decodeUnknownSync(Envelope)(body(path, method)).properties.data.properties;
    expect(members("/notes", "post").attributes).toEqual({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    });
    // An update attribute is clearable, so `null` is allowed too.
    expect(members("/notes/{id}", "patch").attributes).toEqual({
      type: "object",
      properties: { body: { anyOf: [{ type: "string" }, { type: "null" }] } },
      additionalProperties: false,
    });
    expect(body("/memos", "post")).toEqual({
      type: "object",
      properties: { body: { type: "string" } },
      required: ["body"],
      additionalProperties: false,
    });
    expect(members("/flags", "post").relationships).toMatchObject({
      type: "object",
      properties: { owner: { type: "object" } },
      additionalProperties: false,
    });
  });
});

describe("which own keys of a closed member count as members (#292)", () => {
  const issuesOf = (result: Result.Result<unknown, Schema.SchemaError>) =>
    Result.match(result, {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });
  const hidden = Symbol("hidden");

  // A member struct with fields, and one with none.
  const sites = [
    ["createInput (declares fields)", Memo.createInput, { body: "b" }],
    [
      "createPayload attributes (declares none)",
      Flag.createPayload.fields.data.fields.attributes,
      {},
    ],
  ] as const;

  // `JSON.parse` never makes a non-enumerable or a symbol key, so these are
  // in-process values: what a decode outside HTTP (a remote function, RPC,
  // `Client.decodeInput`) or a client's encode can be handed.
  describe.each(sites)("%s", (_, schema, declared) => {
    it("lets a non-enumerable own key through, string or symbol, as onExcessProperty does", () => {
      const value = { ...declared };
      Object.defineProperty(value, "isAdmin", { value: true, enumerable: false });
      Object.defineProperty(value, hidden, { value: true, enumerable: false });
      expect(issuesOf(Schema.decodeUnknownResult(schema)(value))).toEqual([]);
      expect(issuesOf(Schema.encodeUnknownResult(schema)(value))).toEqual([]);
    });

    it("rejects an enumerable symbol key after the string keys, as Reflect.ownKeys orders them", () => {
      const value = { [hidden]: true, ...declared, isAdmin: true };
      const expected = [
        { path: ["isAdmin"], message: "Expected no excess property" },
        { path: [hidden], message: "Expected no excess property" },
      ];
      expect(issuesOf(Schema.decodeUnknownResult(schema)(value))).toEqual(expected);
      expect(issuesOf(Schema.encodeUnknownResult(schema)(value))).toEqual(expected);
    });
  });
});

describe("what a closed member reports, and where it reports nothing (#292)", () => {
  const issuesOf = (result: Result.Result<unknown, Schema.SchemaError>) =>
    Result.match(result, {
      onFailure: (error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue).issues,
      onSuccess: () => [],
    });

  it.each(["first", "all"] as const)(
    "errors: %s reports only a failing declared field, not the undeclared members beside it",
    (errors) => {
      const decode = Schema.decodeUnknownResult(Note.createInput);
      expect(issuesOf(decode({ body: 5, isAdmin: true }, { errors }))).toEqual([
        { path: ["body"], message: "Expected string" },
      ]);
      expect(issuesOf(decode({ isAdmin: true }, { errors }))).toEqual([
        { path: ["body"], message: "Missing key" },
      ]);
    },
  );

  it("reports one member's undeclared members per request over HTTP (errors: first)", async () => {
    received.length = 0;
    const response = await send(
      "POST",
      "/flags",
      `{"data":{"type":"flags","attributes":{"a":1,"b":2},"relationships":{"c":${ownerLinkage}}}}`,
    );
    expect(response.status).toBe(400);
    expect(errorsOf(response.text).map(({ source }) => source?.pointer)).toEqual([
      "/data/attributes/a",
      "/data/attributes/b",
    ]);
    expect(received).toEqual([]);
  });

  it("answers a failing declared field alone over HTTP, not the undeclared member beside it", async () => {
    received.length = 0;
    const response = await send(
      "POST",
      "/notes",
      '{"data":{"type":"notes","attributes":{"body":5,"isAdmin":true}}}',
    );
    expect(response.status).toBe(400);
    expect(errorsOf(response.text).map(({ detail, source }) => [detail, source?.pointer])).toEqual([
      ["Expected string", "/data/attributes/body"],
    ]);
    expect(received).toEqual([]);
  });

  it("Schema.is answers true for an undeclared member beside declared fields, and make strips it", () => {
    expect(Schema.is(Note.createInput)({ body: "b", isAdmin: true })).toBe(true);
    expect(Schema.is(Memo.updateInput)({ id: "1", isAdmin: true })).toBe(true);
    const withExtra = { body: "b", isAdmin: true };
    expect(Note.createInput.make(withExtra)).toEqual({ body: "b" });
  });

  it("Schema.is answers false for an undeclared member where none is declared, and make throws", () => {
    expect(Schema.is(Flag.createInput)({ isAdmin: true })).toBe(false);
    const extraOnly = { isAdmin: true };
    expect(() => Flag.createInput.make(extraOnly)).toThrow("Schema validation failed");
  });
});
