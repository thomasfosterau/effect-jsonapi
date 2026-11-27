/**
 * A family's address on the wire: `GET /<family>/:id` answers 308 to the
 * member's own address, `POST /<family>` creates any member and refuses a type
 * outside the family with 409, and a `Client.make` client follows the 308.
 */
import { it } from "@effect/vitest";
import { describe, expect, onTestFinished } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse, HttpRouter } from "effect/http";
import { HttpApi, HttpApiBuilder } from "effect/http-api";
import * as Client from "./Client.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Handlers from "./Handlers.js";
import * as Middleware from "./Middleware.js";
import { platformLayer } from "./Registry.js";
import { extend, family, make as Resource } from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const Node = Resource("nodes", { attributes: { name: Schema.NonEmptyString } });
const Person = extend(Node, "people", {
  inheritId: true,
  attributes: { firstName: Schema.String },
});
const Organisation = extend(Node, "organisations", {
  inheritId: true,
  attributes: { legalName: Schema.String },
});
// Every type is instantiable: a node is a member of its own family.
const AnyNode = family(Node, [Node, Person, Organisation]);

const Api = HttpApi.make("graph")
  .add(Group.make(AnyNode, Endpoint.polymorphic(AnyNode), Endpoint.polymorphicCreate(AnyNode)))
  .add(Group.make(Person, Endpoint.get(Person)));

const ada = Person.make({
  id: Person.Id.make("1"),
  attributes: { name: "ada", firstName: "Ada" },
  links: { self: "/people/1" },
});
const root = Node.make({ id: Node.Id.make("2"), attributes: { name: "root" } });

const NodesLive = HttpApiBuilder.group(Api, "nodes", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      Effect.succeed(
        params.id === root.id ? Handlers.data(root) : Handlers.redirect(`/people/${params.id}`),
      ),
    )
    .handle("create", ({ payload }) =>
      Effect.succeed(
        Handlers.data(
          payload.data.type === "people"
            ? Person.make({
                id: Person.Id.make("3"),
                attributes: { name: "grace", firstName: "Grace" },
                links: { self: "/people/3" },
              })
            : root,
        ),
      ),
    ),
);

const PeopleLive = HttpApiBuilder.group(Api, "people", (handlers) =>
  handlers.handle("get", () => Effect.succeed(Handlers.data(ada))),
);

// One server per test over the package's middleware set, disposed when the
// test finishes.
const serve = () => {
  const { dispose, handler } = HttpRouter.toWebHandler(
    HttpApiBuilder.layer(Api).pipe(
      Layer.provide([NodesLive, PeopleLive]),
      Layer.provide(Middleware.layer),
      Layer.provide(platformLayer),
    ),
  );
  onTestFinished(() => dispose());
  return handler;
};

const Json = Schema.fromJsonString(Schema.Unknown);
const toJson = Schema.encodeSync(Json);
const fromJson = Schema.decodeSync(Json);

const send = (path: string, init?: RequestInit) =>
  Effect.tryPromise({
    try: async () => {
      const response = await serve()(
        new Request(`http://localhost${path}`, {
          ...init,
          headers: { accept: MEDIA_TYPE, "content-type": MEDIA_TYPE },
        }),
      );
      return {
        status: response.status,
        location: response.headers.get("location"),
        body: await response.text(),
      };
    },
    catch: (cause) => new Cause.UnknownError(cause),
  });

interface ResourceObject {
  readonly type: string;
  readonly attributes: Readonly<Record<string, string>>;
}

const post = (data: ResourceObject) => send("/nodes", { method: "POST", body: toJson({ data }) });

// An `HttpClient` over the server's web handler that, unlike `fetch`, returns
// a redirect rather than following it.
const handlerClient = () => {
  const handler = serve();
  return HttpClient.make((request) =>
    Effect.gen(function* () {
      const web = yield* HttpClientRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        try: () => handler(web),
        catch: (cause) => new Cause.UnknownError(cause),
      });
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie),
  );
};

describe("GET /<family>/:id", () => {
  it.effect("answers 308 to the member's address, with no body", () =>
    Effect.gen(function* () {
      const response = yield* send("/nodes/1");
      expect(response).toEqual({ status: 308, location: "/people/1", body: "" });
    }),
  );

  it.effect("serves an instance of the family's own type itself", () =>
    Effect.gen(function* () {
      const response = yield* send("/nodes/2");
      expect(response.status).toBe(200);
      expect(fromJson(response.body)).toMatchObject({ data: { type: "nodes", id: "2" } });
    }),
  );

  it.effect("Client.make follows the 308 and decodes the member's document", () =>
    Effect.gen(function* () {
      const client = yield* Client.make(Api, { baseUrl: "http://localhost" });
      const document = yield* client.nodes.get({ params: { id: Node.Id.make("1") }, query: {} });
      expect(document.data).toMatchObject({ type: "people", id: "1" });
    }).pipe(Effect.provideService(HttpClient.HttpClient, handlerClient())),
  );
});

describe("POST /<family>", () => {
  it.effect("creates the member the body's type names, at the member's Location", () =>
    Effect.gen(function* () {
      const response = yield* post({
        type: "people",
        attributes: { name: "grace", firstName: "Grace" },
      });
      expect(response.status).toBe(201);
      expect(response.location).toBe("/people/3");
      expect(fromJson(response.body)).toMatchObject({ data: { type: "people", id: "3" } });
    }),
  );

  it.effect("validates the body against that member's payload", () =>
    Effect.gen(function* () {
      const response = yield* post({ type: "people", attributes: { name: "grace" } });
      expect(response.status).toBe(400);
    }),
  );

  it.effect("answers a type outside the family with 409 at /data/type", () =>
    Effect.gen(function* () {
      const response = yield* post({ type: "articles", attributes: { name: "x" } });
      expect(response.status).toBe(409);
      expect(fromJson(response.body)).toMatchObject({
        errors: [{ status: "409", source: { pointer: "/data/type" } }],
      });
    }),
  );
});
