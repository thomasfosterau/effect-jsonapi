/**
 * Request bodies that send `attributes` / `relationships` members a resource
 * doesn't declare (#270). A member struct that declares nothing (a resource
 * with no attributes or no relationships, or one whose every attribute or
 * relationship is excluded from that write) answers 400 with a
 * `source.pointer` at the undeclared member, through the real middleware
 * stack, instead of handing the member to the handler. A non-object member
 * answers 400 `Expected object` at the member, as a struct with fields does,
 * a `null` included (#286).
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/http-api";
import * as Atomic from "./Atomic.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import { layerWith } from "./Middleware.js";
import * as Relationship from "./Relationship.js";
import { attribute, make as Resource } from "./Resource.js";
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

const Api = HttpApi.make("undeclared")
  .add(Group.make(Flag, Endpoint.create(Flag), Endpoint.update(Flag)))
  .add(Group.make(Note, Endpoint.create(Note), Endpoint.update(Note)))
  .add(Group.make("operations", Endpoint.operations([Flag, Note])));

// Every resource `data` a handler is handed, so a test can assert what reached it.
interface Received {
  readonly type: string;
  readonly attributes?: object;
  readonly relationships?: object;
}
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
  Layer.provide([FlagsLive, NotesLive, OperationsLive]),
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
        source: Schema.Struct({ pointer: Schema.String }),
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
];

const members = ["isAdmin", "__proto__", "constructor"] as const;

describe("a request body member the resource doesn't declare (#270)", () => {
  describe.each(cases)("%s", (_, method, path, body, pointer) => {
    it.each(members)("answers 400 at the member %s and never calls the handler", async (m) => {
      received.length = 0;
      const response = await send(method, path, body(m));
      expect(response.status).toBe(400);
      const errors = errorsOf(response.text);
      // An atomic operation decodes against a union of every resource's
      // operations, and a rejected union reports an error per candidate (the
      // other resource's `data/type`, an update's missing `ref`). So the
      // assertion is on the errors at the member; elsewhere that is all of them.
      const atMember = errors.filter(({ source }) => source.pointer === pointer(m));
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
      expect(polluted()).toBe(false);
    });
  });

  it("reports every undeclared member, each at its own pointer", async () => {
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
});

describe("a non-object member answers 400 at the member, whether or not it declares fields (#270)", () => {
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
    // The reference: members that declare fields.
    [
      "createPayload attributes (declared)",
      "POST",
      "/notes",
      (v) => `{"data":{"type":"notes","attributes":${v}}}`,
      "/data/attributes",
    ],
    [
      "updatePayload relationships (declared)",
      "PATCH",
      "/flags/1",
      (v) => `{"data":{"type":"flags","id":"1","relationships":${v}}}`,
      "/data/relationships",
    ],
  ];

  describe.each(sites)("%s", (_, method, path, body, pointer) => {
    it.each(values)("%s answers 400 Expected object and never calls the handler", async (v) => {
      received.length = 0;
      const response = await send(method, path, body(v));
      expect(response.status).toBe(400);
      const errors = errorsOf(response.text);
      const atMember = errors.filter(({ source }) => source.pointer.startsWith(pointer));
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
