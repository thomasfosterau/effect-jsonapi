/**
 * #250: the document builders' full-linkage check runs on the document value
 * they build, without the endpoint's schema. Encoding through that schema
 * drops a relationship the resource does not declare, so an `included` member
 * reached only through one passes the builders and then arrives on the wire
 * unreachable from the primary data. `SchemaErrorsLive` re-runs the walk on
 * the encoded document and answers a violation as it answers a response its
 * schema rejects: the opaque JSON:API 500, reported at `Error` severity.
 */
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as ErrorReporter from "effect/ErrorReporter";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import * as Document from "./Document.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import { unlinkedIncluded } from "./internal/linkage.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { SERVER_ERROR } from "./ServerErrors.js";

// The issue's reproduction.
const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});

const ann = { type: "people", id: "9", attributes: { name: "Ann" } };

// `people:9` is linked only through `editor`, which `articles` does not declare.
const throughEditor = Handlers.data(
  {
    type: "articles",
    id: "1",
    attributes: { title: "Hi" },
    relationships: {
      author: { data: { type: "people", id: "1" } },
      editor: { data: { type: "people", id: "9" } },
    },
  },
  { included: [ann] },
);

// The control: `people:9` is linked through the declared `author`.
const throughAuthor = Handlers.data(
  {
    type: "articles",
    id: "1",
    attributes: { title: "Hi" },
    relationships: { author: { data: { type: "people", id: "9" } } },
  },
  { included: [ann] },
);

describe("the builders' check sees the value, not the wire (#250)", () => {
  it("passes a member linked through an undeclared relationship, which encoding orphans", () => {
    const encoded = Schema.encodeUnknownSync(Document.DataDocument(Article, { included: Person }))(
      throughEditor,
    );
    expect(encoded).toEqual({
      data: {
        type: "articles",
        id: "1",
        attributes: { title: "Hi" },
        relationships: { author: { data: { type: "people", id: "1" } } },
      },
      included: [ann],
    });
    expect(unlinkedIncluded(encoded)).toEqual([ann]);
  });
});

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

describe("SchemaErrorsLive re-checks full linkage on the encoded document (#250)", () => {
  const Api = HttpApi.make("linkage").add(
    Group.make(Article, Endpoint.get(Article, { include: true }), Endpoint.list(Article)),
  );

  // `get` answers the document under test; `list` a plain collection, which
  // has no `included` for the check to read.
  const live = (document: typeof throughEditor | typeof throughAuthor | undefined) =>
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide(
        HttpApiBuilder.group(Api, "articles", (handlers) =>
          handlers
            // SAFETY: the point of the test — a document carrying a relationship
            // its endpoint's schema does not declare, as an untyped source would.
            .handle("get", () => Effect.succeed(document as never))
            // SAFETY: an empty collection document is what `list` encodes.
            .handle("list", () => Effect.succeed(Handlers.collection([]) as never)),
        ),
      ),
    );

  const serve = async (
    document: typeof throughEditor | typeof throughAuthor | undefined,
    url = "http://localhost/articles/1",
    middleware: Layer.Layer<
      Middleware.ContentNegotiation | Middleware.SchemaErrors | Middleware.CreatedLocation
    > = Middleware.layer,
  ) => {
    const reports: Array<{ readonly error: Error; readonly severity: string }> = [];
    const appLayer = live(document).pipe(
      Layer.provide(middleware),
      Layer.provide(
        ErrorReporter.layer([
          ErrorReporter.make(({ error, severity }) => reports.push({ error, severity })),
        ]),
      ),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(url)).finally(dispose);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: decodeJson(await response.text()),
      reports,
    };
  };

  it("answers a member linked only through an undeclared relationship with the JSON:API 500", async () => {
    const response = await serve(throughEditor);
    expect(response.status).toBe(500);
    expect(response.contentType).toContain(MEDIA_TYPE);
    expect(response.body).toEqual(SERVER_ERROR.toDocument());
  });

  it("reports the violation as a server error naming the member", async () => {
    const { reports } = await serve(throughEditor);
    expect(reports.map(({ severity }) => severity)).toEqual(["Error"]);
    expect(reports.map(({ error }) => error)).toEqual([
      expect.objectContaining({
        _tag: "effect-jsonapi/ResponseEncodeError",
        message: expect.stringMatching(
          /^JSON:API full linkage violation: included resource "people:9" is not reachable from the primary data through resource linkage in the document as encoded/,
        ),
      }),
    ]);
  });

  it("serves the same member linked through a declared relationship", async () => {
    const response = await serve(throughAuthor);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ included: [ann] });
    expect(response.reports).toEqual([]);
  });

  it("leaves a document with no `included` alone", async () => {
    const response = await serve(undefined, "http://localhost/articles");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: [] });
  });

  it("is turned off with `checkLinkage: false`", async () => {
    const response = await serve(
      throughEditor,
      undefined,
      Middleware.layerWith({ checkLinkage: false }),
    );
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ included: [ann] });
  });
});

describe("SchemaErrorsLive walks from primary identifiers in a relationship document (#423)", () => {
  // A relationship endpoint whose schema declares `included`
  // (`?include=comments.author`, as `Endpoint.getRelationship`'s `include`
  // option declares since #439) carries the members the primary identifiers
  // name.
  const Comment = Resource.make("comments", {
    attributes: { body: Schema.String },
    relationships: { author: Relationship.one(() => Person) },
  });
  const commentsRelationship = HttpApiEndpoint.get(
    "commentsRelationship",
    "/articles/1/relationships/comments",
    {
      success: Schema.Struct({
        data: Schema.Array(Comment.identifier),
        included: Schema.Array(Schema.Union([Comment, Person])),
      }),
    },
  ).middleware(Middleware.SchemaErrors);
  const Api = HttpApi.make("relationship").add(
    HttpApiGroup.make("articles").add(commentsRelationship),
  );

  const comment = {
    type: "comments",
    id: "5",
    attributes: { body: "First!" },
    relationships: { author: { data: { type: "people", id: "9" } } },
  };

  const serve = async (included: ReadonlyArray<unknown>) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(
        HttpApiBuilder.group(Api, "articles", (handlers) =>
          handlers.handle("commentsRelationship", () =>
            // SAFETY: the members under test, whatever the schema's union infers.
            Effect.succeed({ data: [{ type: "comments", id: "5" }], included } as never),
          ),
        ),
      ),
      Layer.provide(Middleware.layer),
      Layer.provide(ErrorReporter.layer([])),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(
      new Request("http://localhost/articles/1/relationships/comments"),
    ).finally(dispose);
    return { status: response.status, body: decodeJson(await response.text()) };
  };

  it("serves the members an identifier reaches", async () => {
    const response = await serve([comment, ann]);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: [{ type: "comments", id: "5" }],
      included: [comment, ann],
    });
  });

  it("still answers a member no identifier reaches with the JSON:API 500", async () => {
    const response = await serve([comment, { ...ann, id: "7" }]);
    expect(response.status).toBe(500);
    expect(response.body).toEqual(SERVER_ERROR.toDocument());
  });
});

// §Compound Documents: full linkage is waived "when relationship fields that
// would otherwise contain linkage data are excluded due to sparse fieldsets"
// (#494). The middleware reads `fields[TYPE]` from the request.
describe("SchemaErrorsLive exempts what the request's sparse fieldsets exclude (#494)", () => {
  const Api = HttpApi.make("sparseLinkage").add(
    Group.make(Article, Endpoint.get(Article, { include: true, fields: true })),
  );

  // `?include=author&fields[articles]=title` as the handler answers it: the
  // article without its `author`, the person it linked still included.
  const projected = Handlers.data(
    { type: "articles", id: "1", attributes: { title: "Hi" } },
    { included: [ann], checkLinkage: false },
  );

  const serve = async (query: string) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(
        HttpApiBuilder.group(Api, "articles", (handlers) =>
          // SAFETY: the wire document under test, its loose builder type aside.
          handlers.handle("get", () => Effect.succeed(projected as never)),
        ),
      ),
      Layer.provide(Middleware.layer),
      Layer.provide(ErrorReporter.layer([])),
      Layer.provide(platformLayer),
    );
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer);
    const response = await handler(new Request(`http://localhost/articles/1?${query}`)).finally(
      dispose,
    );
    return { status: response.status, body: decodeJson(await response.text()) };
  };

  it.each([
    "include=author&fields[articles]=title",
    "include=author&fields[articles]=",
    "include=author&fields%5Barticles%5D=title",
  ])("serves a member the excluded relationship would have linked: %s", async (query) => {
    const response = await serve(query);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ data: projected.data, included: [ann] });
  });

  it.each(["include=author", "include=author&fields[people]=name"])(
    "still answers the orphan with the JSON:API 500 when no fieldset excluded a relationship it reaches: %s",
    async (query) => {
      const response = await serve(query);
      expect(response.status).toBe(500);
      expect(response.body).toEqual(SERVER_ERROR.toDocument());
    },
  );
});
