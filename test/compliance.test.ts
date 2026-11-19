/**
 * The JSON:API v1.1 rules the constructors enforce, one `describe` per rule,
 * each driven on the wire through a server built only from this package's
 * constructors. `compliance.types.ts` holds the rules enforced at compile time.
 */
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import {
  ApiError,
  Atomic,
  Document,
  Endpoint,
  Filter,
  Group,
  Handlers,
  Idempotency,
  MEDIA_TYPE,
  Middleware,
  Query,
  Registry,
  Relationship,
  Resource,
  ResourceHandlers,
} from "@thomasfosterau/effect-jsonapi";

// ---------------------------------------------------------------------------
// The server: one relationship of each kind, every endpoint constructor
// ---------------------------------------------------------------------------

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });

const Tag = Resource.make("tags", { attributes: { name: Schema.NonEmptyString } });

const Comment = Resource.make("comments", { attributes: { body: Schema.String } });

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString, body: Schema.String },
  relationships: {
    author: Relationship.optional(() => Person),
    tags: Relationship.many(() => Tag),
    comments: Relationship.paginated(() => Comment),
  },
});

class ArticleNotFound extends ApiError.make<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  fields: { id: Schema.String },
  detail: (error) => `Article ${error.id} not found`,
}) {}

// A create payload that supports client-generated ids: `createPayload`'s
// resource object with an `id` of its own.
const CreatePersonWithId = Schema.Struct({
  data: Schema.Struct({
    ...Person.createPayload.fields.data.fields,
    id: Schema.optionalKey(Schema.String),
  }),
});

const Api = HttpApi.make("compliance")
  .add(
    Group.make(
      Article,
      Endpoint.get(Article, { include: true, fields: true, errors: [ArticleNotFound] }),
      Endpoint.list(Article, { sort: ["title"], page: Query.Page.Offset }),
      Endpoint.create(Article),
      Endpoint.update(Article, { errors: [ApiError.Conflict] }),
      Endpoint.delete(Article),
      Endpoint.related(Article, "author"),
      Endpoint.related(Article, "comments", { page: Query.Page.Offset }),
      Endpoint.getRelationship(Article, "author"),
      Endpoint.updateRelationship(Article, "author"),
      Endpoint.getRelationship(Article, "tags", { include: true }),
      Endpoint.addRelationship(Article, "tags"),
      Endpoint.removeRelationship(Article, "tags"),
    ),
  )
  .add(
    Group.make(Person, Endpoint.create(Person, { payload: CreatePersonWithId, idempotency: true })),
  )
  .add(Group.make("operations", Endpoint.operations([Article])));

const author = Person.make({ id: Person.Id.make("9"), attributes: { name: "Dan" } });
const tag = Tag.make({ id: Tag.Id.make("3"), attributes: { name: "jsonapi" } });
const comment = Comment.make({ id: Comment.Id.make("5"), attributes: { body: "First!" } });

const articleWith = (id: string, authored: boolean) =>
  Article.make({
    id: Article.Id.make(id),
    attributes: { title: "JSON:API paints my bikeshed!", body: "The shortest article. Ever." },
    relationships: {
      author: { data: authored ? Person.ref(author.id) : null },
      tags: { data: [Tag.ref(tag.id)] },
      comments: Handlers.paginatedRelationship("articles", id, "comments"),
    },
  });

// Article 1 has an author; article 2 has none.
const article = articleWith("1", true);
const orphan = articleWith("2", false);

const loadArticle = (id: string): Effect.Effect<typeof Article.Type, ArticleNotFound> =>
  id === "1"
    ? Effect.succeed(article)
    : id === "2"
      ? Effect.succeed(orphan)
      : Effect.fail(new ArticleNotFound({ id }));

const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadArticle(params.id).pipe(
        Effect.map((found) =>
          Handlers.data(found, {
            included: [
              ...(query.include?.includes("author") === true ? [author] : []),
              ...(query.include?.includes("tags") === true ? [tag] : []),
            ],
          }),
        ),
      ),
    )
    .handle("list", () => Effect.succeed(Handlers.collection([article, orphan])))
    .handle("create", ({ payload }) =>
      Effect.succeed(
        Handlers.data({
          ...Article.make({
            id: Article.Id.make("7"),
            attributes: payload.data.attributes,
            relationships: {
              author: { data: null },
              tags: { data: [] },
              comments: Handlers.paginatedRelationship("articles", "7", "comments"),
            },
          }),
          links: { self: "/articles/7" },
        }),
      ),
    )
    .handle("update", ({ params, payload }) =>
      ResourceHandlers.assertIdMatchesPath(params.id, payload.data.id).pipe(
        Effect.as(Handlers.data(article)),
      ),
    )
    .handle("delete", () => Effect.void)
    .handle("author", ({ params }) =>
      Effect.succeed(Handlers.data(params.id === "1" ? author : null)),
    )
    .handle("comments", () => Effect.succeed(Handlers.collection([comment])))
    .handle("authorRelationship", () => Effect.succeed(Handlers.linkage(Person.ref(author.id))))
    .handle("updateAuthorRelationship", ({ payload }) =>
      Effect.succeed(Handlers.linkage(payload.data)),
    )
    .handle("tagsRelationship", ({ query }) =>
      Effect.succeed(
        Handlers.linkage([Tag.ref(tag.id)], {
          included: query.include === undefined ? [] : [tag],
        }),
      ),
    )
    .handle("addTagsRelationship", ({ payload }) => Effect.succeed(Handlers.linkage(payload.data)))
    .handle("removeTagsRelationship", () => Effect.void),
);

const PeopleLive = HttpApiBuilder.group(Api, "people", (handlers) =>
  handlers.handle("create", ({ payload }) =>
    Effect.succeed(
      Handlers.data(
        Person.make({
          id: Person.Id.make(payload.data.id ?? "10"),
          attributes: payload.data.attributes,
        }),
      ),
    ),
  ),
);

const OperationsLive = HttpApiBuilder.group(Api, "operations", (handlers) =>
  handlers.handle("operations", ({ payload }) =>
    Effect.succeed(Atomic.results(payload["atomic:operations"].map(() => Atomic.emptyResult))),
  ),
);

const appLive = (
  middleware: Layer.Layer<
    Middleware.ContentNegotiation | Middleware.SchemaErrors | Middleware.CreatedLocation
  >,
) =>
  HttpApiBuilder.layer(Api).pipe(
    Layer.provide(Layer.mergeAll(ArticlesLive, PeopleLive, OperationsLive)),
    Layer.provide(middleware),
    Layer.provide(Idempotency.layer(Idempotency.memoryStore())),
    Layer.provide(Registry.platformLayer),
  );

const MiddlewareLive = Middleware.layerWith({ extensions: [Atomic.EXTENSION_URI] });

// ---------------------------------------------------------------------------
// The transport: one in-process request per call
// ---------------------------------------------------------------------------

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface Answer {
  readonly status: number;
  readonly headers: Headers.Headers;
  readonly body: unknown;
}

type MiddlewareLayer = Layer.Layer<
  Middleware.ContentNegotiation | Middleware.SchemaErrors | Middleware.CreatedLocation
>;

/** The server, served in-process as an `HttpClient`. */
const serverClient = (middleware: MiddlewareLayer) =>
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(appLive(middleware));
    return HttpClient.make(
      Effect.fnUntraced(function* (request) {
        const response = yield* handler.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromClientRequest(request),
          ),
          Effect.orDie,
        );
        return HttpServerResponse.toClientResponse(response);
      }, Effect.scoped),
    );
  });

const request = Effect.fnUntraced(function* (
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: {
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    readonly middleware?: MiddlewareLayer;
  } = {},
) {
  const client = yield* serverClient(options.middleware ?? MiddlewareLive);
  const bare = HttpClientRequest.make(method)(`http://localhost${path}`);
  const withBody =
    options.body === undefined
      ? bare
      : HttpClientRequest.bodyText(bare, encodeJson(options.body), MEDIA_TYPE);
  const response = yield* client.execute(
    HttpClientRequest.setHeaders(withBody, { accept: MEDIA_TYPE, ...options.headers }),
  );
  const text = yield* response.text;
  const answer: Answer = {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : decodeJson(text),
  };
  return answer;
}, Effect.scoped);

const get = (path: string, headers: Readonly<Record<string, string>> = {}) =>
  request("GET", path, { headers });

const newArticle = { type: "articles", attributes: { title: "Hello", body: "World" } };

const atomicMediaType = `${MEDIA_TYPE};ext="${Atomic.EXTENSION_URI}"`;

const decodeErrorPointer = Schema.decodeUnknownSync(
  Schema.Struct({
    errors: Schema.NonEmptyArray(
      Schema.Struct({ source: Schema.Struct({ pointer: Schema.String }) }),
    ),
  }),
);

/** The `source.pointer` of an error document's first error. */
const pointerOf = (answer: Answer): string =>
  decodeErrorPointer(answer.body).errors[0].source.pointer;

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

describe("content negotiation", () => {
  it.effect("every response, success or error, is `application/vnd.api+json`", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1")).headers["content-type"]).toBe(MEDIA_TYPE);
      expect((yield* get("/articles/404")).headers["content-type"]).toBe(MEDIA_TYPE);
      expect((yield* get("/articles?bogus=1")).headers["content-type"]).toBe(MEDIA_TYPE);
    }),
  );

  it.effect("answers 415 for a request media type parameter other than `ext` / `profile`", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", {
        body: { data: newArticle },
        headers: { "content-type": `${MEDIA_TYPE}; charset=utf-8` },
      });
      expect(answer.status).toBe(415);
      const profiled = yield* request("POST", "/articles", {
        body: { data: newArticle },
        headers: { "content-type": `${MEDIA_TYPE};profile="urn:example:unknown"` },
      });
      expect(profiled.status).toBe(201);
    }),
  );

  it.effect("answers 415 for an extension the server does not support", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", {
        body: { data: newArticle },
        headers: { "content-type": `${MEDIA_TYPE};ext="urn:example:unsupported"` },
      });
      expect(answer.status).toBe(415);
    }),
  );

  it.effect("answers 406 when every JSON:API media type in Accept carries other parameters", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1", { accept: `${MEDIA_TYPE}; charset=utf-8` })).status).toBe(
        406,
      );
      expect(
        (yield* get("/articles/1", { accept: `${MEDIA_TYPE}; charset=utf-8, ${MEDIA_TYPE}` }))
          .status,
      ).toBe(200);
    }),
  );

  it.effect("ignores a profile it does not know", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1", {
        accept: `${MEDIA_TYPE};profile="urn:example:unknown"`,
      });
      expect(answer.status).toBe(200);
    }),
  );

  it("publishes absolute URIs for the profiles it defines", () => {
    expect(new URL(Filter.PROFILE_URI).protocol).toBe("https:");
    expect(new URL(Idempotency.PROFILE_URI).protocol).toBe("https:");
    expect(Idempotency.jsonapi.profile).toEqual([Idempotency.PROFILE_URI]);
  });
});

describe("document structure", () => {
  it.effect("a success document holds `data` and never `errors`", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1");
      expect(answer.body).toHaveProperty("data");
      expect(answer.body).not.toHaveProperty("errors");
    }),
  );

  it.effect("an error is answered with an error document, never `data`", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/404");
      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({
        errors: [expect.objectContaining({ status: "404", detail: "Article 404 not found" })],
      });
    }),
  );

  it("an error document's `errors` array is never empty", () => {
    const decode = Schema.decodeUnknownOption(Document.ErrorDocument());
    expect(Option.isNone(decode({ errors: [] }))).toBe(true);
    expect(Option.isSome(decode({ errors: [{ status: "404" }] }))).toBe(true);
  });

  it("primary `data` is null only where the schema opts into it", () => {
    const strict = Schema.decodeUnknownOption(Document.DataDocument(Article));
    const nullable = Schema.decodeUnknownOption(Document.DataDocument(Schema.NullOr(Article)));
    const optional = Schema.decodeUnknownOption(Document.DataDocument(Article.nullable()));
    expect(Option.isNone(strict({ data: null }))).toBe(true);
    expect(Option.isSome(nullable({ data: null }))).toBe(true);
    expect(Option.isSome(optional({ data: null }))).toBe(true);
  });

  it.effect("a resource object carries its `type` and `id`", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1");
      expect(answer.body).toMatchObject({ data: { type: "articles", id: "1" } });
    }),
  );

  it("a relationship holds resource linkage, or a `related` link when paginated", () => {
    const decode = Schema.decodeUnknownOption(Article);
    // Each relationship object as a request may spell it, members missing included.
    interface Relationships {
      readonly author: { readonly data?: null };
      readonly tags: { readonly data: ReadonlyArray<never> };
      readonly comments: { readonly links?: { readonly related: string } };
    }
    const withRelationships = (relationships: Relationships) =>
      decode({ type: "articles", id: "1", attributes: { title: "T", body: "" }, relationships });
    const comments = { links: { related: "/articles/1/comments" } };
    expect(
      Option.isSome(withRelationships({ author: { data: null }, tags: { data: [] }, comments })),
    ).toBe(true);
    expect(Option.isNone(withRelationships({ author: {}, tags: { data: [] }, comments }))).toBe(
      true,
    );
    expect(
      Option.isNone(
        withRelationships({ author: { data: null }, tags: { data: [] }, comments: {} }),
      ),
    ).toBe(true);
  });
});

describe("compound documents", () => {
  it.effect("include the resources `?include=` names", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1?include=author,tags");
      expect(answer.body).toMatchObject({
        included: [
          { type: "people", id: "9" },
          { type: "tags", id: "3" },
        ],
      });
    }),
  );

  it("never repeat a resource, in `included` or beside the primary data", () => {
    const document = Handlers.data(article, { included: [author, author, tag] });
    expect(document.included?.map(({ type, id }) => `${type}:${id}`)).toEqual([
      "people:9",
      "tags:3",
    ]);
  });

  it("refuse an `included` member the primary data does not reach (full linkage)", () => {
    const stranger = Person.make({ id: Person.Id.make("99"), attributes: { name: "Eve" } });
    expect(() => Handlers.data(article, { included: [stranger] })).toThrow();
    expect(() => Handlers.linkage([Tag.ref(tag.id)], { included: [author] })).toThrow();
  });

  it.effect("never inline a paginated relationship: it is no include path", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1?include=comments")).status).toBe(400);
    }),
  );

  it.effect("on a relationship endpoint, include the resources its linkage names", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1/relationships/tags?include=tags");
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({
        data: [{ type: "tags", id: "3" }],
        included: [{ type: "tags", id: "3" }],
      });
    }),
  );
});

describe("status codes", () => {
  it.effect("200 for a read and an update, 201 for a create, 204 for a delete", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1")).status).toBe(200);
      expect((yield* get("/articles")).status).toBe(200);
      expect((yield* request("POST", "/articles", { body: { data: newArticle } })).status).toBe(
        201,
      );
      const update = { type: "articles", id: "1", attributes: { title: "Renamed" } };
      expect((yield* request("PATCH", "/articles/1", { body: { data: update } })).status).toBe(200);
      const deleted = yield* request("DELETE", "/articles/1");
      expect(deleted.status).toBe(204);
      expect(deleted.body).toBeUndefined();
    }),
  );

  it.effect("a 201 carries `Location`, matching the created resource's `links.self`", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", { body: { data: newArticle } });
      expect(answer.headers["location"]).toBe("/articles/7");
      expect(answer.body).toMatchObject({ data: { links: { self: "/articles/7" } } });
    }),
  );
});

describe("creating and updating resources", () => {
  it("a create may omit `id` and send a `lid`", () => {
    const decode = Schema.decodeUnknownOption(Article.createPayload);
    expect(Option.isSome(decode({ data: newArticle }))).toBe(true);
    expect(Option.isSome(decode({ data: { ...newArticle, lid: "draft" } }))).toBe(true);
  });

  it("an update requires `id`, and its attributes are partial", () => {
    const decode = Schema.decodeUnknownOption(Article.updatePayload);
    expect(
      Option.isSome(decode({ data: { type: "articles", id: "1", attributes: { title: "T" } } })),
    ).toBe(true);
    expect(Option.isNone(decode({ data: { type: "articles", attributes: { title: "T" } } }))).toBe(
      true,
    );
  });

  it.effect("answers 403 at `/data/id` for a client-generated id it does not support", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", {
        body: { data: { ...newArticle, id: "client-1" } },
      });
      expect(answer.status).toBe(403);
      expect(pointerOf(answer)).toBe("/data/id");
    }),
  );

  it.effect("answers a mismatched `type` beside an unsupported id with the 409 first", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", {
        body: { data: { ...newArticle, type: "people", id: "client-1" } },
      });
      expect(answer.status).toBe(409);
      expect(pointerOf(answer)).toBe("/data/type");
    }),
  );

  it.effect("accepts a client-generated id through a payload that declares one", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/people", {
        body: { data: { type: "people", id: "client-1", attributes: { name: "Ann" } } },
      });
      expect(answer.status).toBe(201);
      expect(answer.body).toMatchObject({ data: { type: "people", id: "client-1" } });
    }),
  );

  it.effect("answers 409 at `/data/type` for a resource object of another type", () =>
    Effect.gen(function* () {
      const created = yield* request("POST", "/articles", {
        body: { data: { ...newArticle, type: "people" } },
      });
      expect(created.status).toBe(409);
      expect(pointerOf(created)).toBe("/data/type");
      const updated = yield* request("PATCH", "/articles/1", {
        body: { data: { type: "people", id: "1", attributes: {} } },
      });
      expect(updated.status).toBe(409);
      expect(pointerOf(updated)).toBe("/data/type");
    }),
  );

  it.effect("keeps a missing `type` a 400", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/articles", {
        body: { data: { attributes: newArticle.attributes } },
      });
      expect(answer.status).toBe(400);
    }),
  );

  it.effect("answers 409 for an update whose `data.id` is not the URL's", () =>
    Effect.gen(function* () {
      const answer = yield* request("PATCH", "/articles/1", {
        body: { data: { type: "articles", id: "2", attributes: {} } },
      });
      expect(answer.status).toBe(409);
    }),
  );
});

describe("relationship and related resource endpoints", () => {
  it.effect("serve GET and PATCH on a to-one relationship", () =>
    Effect.gen(function* () {
      const read = yield* get("/articles/1/relationships/author");
      expect(read.status).toBe(200);
      expect(read.body).toMatchObject({ data: { type: "people", id: "9" } });
      const cleared = yield* request("PATCH", "/articles/1/relationships/author", {
        body: { data: null },
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body).toMatchObject({ data: null });
    }),
  );

  it.effect("serve GET, POST and DELETE on a to-many relationship", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1/relationships/tags")).status).toBe(200);
      const linkage = { data: [{ type: "tags", id: "3" }] };
      const added = yield* request("POST", "/articles/1/relationships/tags", { body: linkage });
      expect(added.status).toBe(200);
      const removed = yield* request("DELETE", "/articles/1/relationships/tags", {
        body: linkage,
      });
      expect(removed.status).toBe(204);
    }),
  );

  it.effect("answer a to-one related resource with nullable `data`", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1/author")).body).toMatchObject({
        data: { type: "people", id: "9" },
      });
      const empty = yield* get("/articles/2/author");
      expect(empty.status).toBe(200);
      expect(empty.body).toMatchObject({ data: null });
    }),
  );

  it.effect("answer a to-many related resource with a paginated collection", () =>
    Effect.gen(function* () {
      const answer = yield* get("/articles/1/comments?page[offset]=0&page[limit]=10");
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ data: [{ type: "comments", id: "5" }] });
    }),
  );
});

describe("query parameters", () => {
  it.effect("decode the families the endpoint declares", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles?sort=-title&page[offset]=0&page[limit]=1")).status).toBe(200);
      expect((yield* get("/articles/1?include=author&fields[articles]=title")).status).toBe(200);
    }),
  );

  it.effect("answer 400 for a value outside the declared family", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles?sort=body")).status).toBe(400);
      expect((yield* get("/articles/1?include=publisher")).status).toBe(400);
    }),
  );

  it.effect("answer 400 for a spec family the endpoint does not declare", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1?sort=title")).status).toBe(400);
      expect((yield* get("/articles?include=author")).status).toBe(400);
      expect((yield* get("/articles?filter[title]=T")).status).toBe(400);
    }),
  );

  it.effect("answer 400 for a reserved, illegal or extension parameter name", () =>
    Effect.gen(function* () {
      expect((yield* get("/articles/1?bogus=1")).status).toBe(400);
      expect((yield* get("/articles/1?-bogus=1")).status).toBe(400);
      expect((yield* get("/articles/1?atomic:bogus=1")).status).toBe(400);
    }),
  );

  it.effect(
    "let a reserved name through only from `allowedQueryParameters`, jQuery's `_` by default",
    () =>
      Effect.gen(function* () {
        expect((yield* get("/articles/1?_=1700000000000")).status).toBe(200);
        expect((yield* get("/articles/1?bogus=1")).status).toBe(400);
        const middleware = Middleware.layerWith({ allowedQueryParameters: ["bogus"] });
        const allowed = yield* request("GET", "/articles/1?bogus=1", { middleware });
        expect(allowed.status).toBe(200);
        const replaced = yield* request("GET", "/articles/1?_=1700000000000", { middleware });
        expect(replaced.status).toBe(400);
      }),
  );
});

describe("the atomic operations extension", () => {
  const operations = {
    "atomic:operations": [
      { op: "add", data: { ...newArticle, lid: "draft" } },
      {
        op: "update",
        ref: { type: "articles", lid: "draft" },
        data: { type: "articles", lid: "draft", attributes: { title: "Renamed" } },
      },
      {
        op: "add",
        ref: { type: "articles", id: "1", relationship: "tags" },
        data: [{ type: "tags", id: "3" }],
      },
    ],
  };

  it.effect("decodes `lid` references and relationship operations, and answers in kind", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/operations", {
        body: operations,
        headers: { "content-type": atomicMediaType, accept: atomicMediaType },
      });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe(atomicMediaType);
      expect(answer.body).toEqual({ "atomic:results": [{}, {}, {}] });
    }),
  );

  it.effect("accepts a request without the `ext` parameter, answering with it", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/operations", { body: operations });
      expect(answer.status).toBe(200);
      expect(answer.headers["content-type"]).toBe(atomicMediaType);
    }),
  );

  it.effect("answers 403 at the operation's `data/id` for an unsupported client id", () =>
    Effect.gen(function* () {
      const answer = yield* request("POST", "/operations", {
        body: { "atomic:operations": [{ op: "add", data: { ...newArticle, id: "client-1" } }] },
        headers: { "content-type": atomicMediaType, accept: atomicMediaType },
      });
      expect(answer.status).toBe(403);
      expect(pointerOf(answer)).toBe("/atomic:operations/0/data/id");
    }),
  );
});
