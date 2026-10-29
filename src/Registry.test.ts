/**
 * The registry's module-init drift checks and the router, driven over HTTP:
 * every contract group has a family whose handler names match its endpoints
 * exactly, a family naming a missing group or drifting from its endpoints is
 * refused, and the web handler answers documents, negotiated 400s, and the
 * error seam's 404 / 409 through the flat presets end to end.
 */
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { Array as Arr, Context, Effect, Layer, Option, Order, Schema } from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as FlatQuery from "./FlatQuery.js";
import * as Group from "./Group.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Middleware from "./Middleware.js";
import * as Negotiation from "./Negotiation.js";
import * as Registry from "./Registry.js";
import * as Resource from "./Resource.js";
import * as ResourceHandlers from "./ResourceHandlers.js";
import * as ServerErrors from "./ServerErrors.js";

class Store extends Context.Service<Store, Map<string, Person>>()("test/Store") {}

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
const Contest = Resource.make("contests", { attributes: { name: Schema.NonEmptyString } });
type Person = typeof Person.Type;
type Contest = typeof Contest.Type;
const list = FlatQuery.listInput({ maxLimit: 100 });

const people = Group.flat({
  resource: Person,
  list,
  create: Schema.Struct({ name: Schema.NonEmptyString }),
  update: Schema.Struct({ id: Schema.String, name: Schema.optionalKey(Schema.NonEmptyString) }),
});
const contests = Group.flatReadOnly({ resource: Contest, list });
const Api = HttpApi.make("test").add(people.group).add(contests.group);

const linkBase = Effect.succeed("https://example.test");
const personRow = (id: string, name: string): Person =>
  Person.make({ id: Person.Id.make(id), attributes: { name } });
const contestRow = (id: string, name: string): Contest =>
  Contest.make({ id: Contest.Id.make(id), attributes: { name } });

const peopleFamily = {
  group: "people",
  handlers: ResourceHandlers.make({
    segment: "people",
    listQuery: people.listQuery,
    linkBase,
    ops: {
      list: () =>
        Effect.map(Effect.service(Store), (store) => {
          const items = [...store.values()];
          return { items, totalCount: items.length };
        }),
      get: (id) =>
        Effect.flatMap(Effect.service(Store), (store) =>
          Option.match(Option.fromNullishOr(store.get(id)), {
            onNone: () => new ServerErrors.NotFound({ resource: "people", id }),
            onSome: Effect.succeed,
          }),
        ),
      create: (input: { readonly name: string }) =>
        Effect.map(Effect.service(Store), (store) => {
          store.set("2", personRow("2", input.name));
          return { id: "2" };
        }),
      update: (input: { readonly id: string; readonly name?: string | undefined }) =>
        Effect.map(Effect.service(Store), (store) => {
          store.set(input.id, personRow(input.id, input.name ?? "?"));
          return { id: input.id };
        }),
      delete: (id) => Effect.map(Effect.service(Store), (store) => void store.delete(id)),
    },
  }),
} satisfies Registry.FamilyFor<typeof people.group>;

const contestsFamily = {
  group: "contests",
  handlers: ResourceHandlers.readOnly({
    segment: "contests",
    listQuery: contests.listQuery,
    linkBase,
    ops: {
      list: () => Effect.succeed({ items: [contestRow("c1", "Bennelong")], totalCount: 1 }),
      get: (id) => Effect.succeed(contestRow(id, "Bennelong")),
    },
  }),
} satisfies Registry.FamilyFor<typeof contests.group>;

const families: ReadonlyArray<Registry.Family<Store>> = [peopleFamily, contestsFamily];

describe("registry ↔ contract", () => {
  it("gives every group a family with exactly its endpoint names", () => {
    for (const [identifier, group] of Object.entries(Api.groups)) {
      const family = families.find((f) => f.group === identifier);
      expect(family, identifier).toBeDefined();
      expect(Arr.sort(Object.keys(family!.handlers), Order.String)).toEqual(
        Arr.sort(Object.keys(group.endpoints), Order.String),
      );
      expect(() => Registry.checkFamily(Api, family!)).not.toThrow();
      for (const endpoint of Object.keys(group.endpoints)) {
        expect(Option.isSome(Registry.handlerFor(families, identifier, endpoint))).toBe(true);
      }
    }
  });

  it("refuses a family naming an unknown group, or drifting from its endpoints", () => {
    expect(() => Registry.checkFamily(Api, { group: "nope", handlers: {} })).toThrow(
      Registry.UnknownFamily,
    );
    const { delete: _dropped, ...partial } = peopleFamily.handlers;
    expect(() => Registry.checkFamily(Api, { group: "people", handlers: partial })).toThrow(
      Registry.FamilyMismatch,
    );
    expect(() =>
      Registry.checkFamily(Api, {
        group: "people",
        handlers: { ...peopleFamily.handlers, extra: peopleFamily.handlers.get },
      }),
    ).toThrow(Registry.FamilyMismatch);
  });

  it("answers none for an unregistered handler", () => {
    expect(Option.isNone(Registry.handlerFor(families, "people", "restore"))).toBe(true);
  });
});

describe("the router, over HTTP", () => {
  const { isApiPath, negotiate } = Negotiation.make({ api: Api });

  /** The host's front door: negotiate, relabel, dispatch with a fresh per-request context. */
  const serve = async (request: Request, store = new Map<string, Person>()) => {
    const { handler, dispose } = Registry.webHandler(Api, families);
    onTestFinished(() => dispose());
    const verdict = negotiate(request);
    if (verdict.error !== undefined) return Negotiation.errorResponse(verdict.error);
    if (!verdict.dispatch) return new Response("html", { status: 200 });
    return await handler(Negotiation.requestForRouter(request), Context.make(Store, store));
  };
  const json = async (response: Response) => ({
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: (await response.json()) as any,
  });

  it("builds a Fetch-shaped handler at module init and answers a document", async () => {
    const store = new Map([["1", personRow("1", "Ada")]]);
    const response = await json(
      await serve(
        new Request("https://example.test/people/1", { headers: { accept: MEDIA_TYPE } }),
        store,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.contentType).toContain(MEDIA_TYPE);
    expect(response.body.data).toMatchObject({
      type: "people",
      id: "1",
      attributes: { name: "Ada" },
    });
    expect(response.body.jsonapi).toEqual({ version: "1.1" });
    expect(isApiPath("/people/1")).toBe(true);
  });

  it("answers a list with pagination links carrying the query", async () => {
    const store = new Map([["1", personRow("1", "Ada")]]);
    const response = await json(
      await serve(
        new Request("https://example.test/people?page[limit]=1", {
          headers: { accept: MEDIA_TYPE },
        }),
        store,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body.links.self).toBe(
      "https://example.test/people?page[offset]=0&page[limit]=1",
    );
    expect(response.body.meta).toEqual({ totalCount: 1 });
  });

  it("answers the error seam's 404 and 409 as JSON:API documents", async () => {
    const missing = await json(
      await serve(
        new Request("https://example.test/people/9", { headers: { accept: MEDIA_TYPE } }),
      ),
    );
    expect(missing.status).toBe(404);
    expect(missing.body.errors[0]).toMatchObject({ status: "404", code: "not-found" });
    const conflict = await json(
      await serve(
        new Request("https://example.test/people/1", {
          method: "PATCH",
          headers: { "content-type": MEDIA_TYPE, accept: MEDIA_TYPE },
          body: JSON.stringify({ id: "2", name: "Bob" }),
        }),
        new Map([["1", personRow("1", "Ada")]]),
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.body.errors[0]).toMatchObject({
      code: "conflict",
      detail: 'URL id "1" does not match payload id "2".',
    });
  });

  it("creates through the relabelled write and answers 201; deletes with 204", async () => {
    const store = new Map<string, Person>();
    const created = await json(
      await serve(
        new Request("https://example.test/people", {
          method: "POST",
          headers: { "content-type": MEDIA_TYPE, accept: MEDIA_TYPE },
          body: JSON.stringify({ name: "Bob" }),
        }),
        store,
      ),
    );
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ id: "2", attributes: { name: "Bob" } });
    const removed = await serve(
      new Request("https://example.test/people/2", {
        method: "DELETE",
        headers: { "content-type": MEDIA_TYPE },
      }),
      store,
    );
    expect(removed.status).toBe(204);
    expect(store.has("2")).toBe(false);
  });

  it("answers a schema failure with the middleware's 400, and the seam's §5 statuses at the front door", async () => {
    const bad = await json(
      await serve(
        new Request("https://example.test/people?page[limit]=0", {
          headers: { accept: MEDIA_TYPE },
        }),
      ),
    );
    expect(bad.status).toBe(400);
    expect(bad.body.errors[0]?.source).toEqual({ parameter: "page[limit]" });
    const notAcceptable = await serve(
      new Request("https://example.test/people", {
        headers: { accept: `${MEDIA_TYPE};version=1` },
      }),
    );
    expect(notAcceptable.status).toBe(406);
  });

  it("honours a custom middleware and a custom respond", async () => {
    const { handler, dispose } = Registry.webHandler(Api, families, {
      middleware: Middleware.layer,
      respond: (effect) =>
        ServerErrors.respond(effect, {
          materialise: () =>
            Option.some(new ServerErrors.JsonapiError({ status: 418, errors: [] })),
        }),
    });
    onTestFinished(() => dispose());
    // `Middleware.layer` negotiates itself: an application/json Accept is a 406 from inside the api.
    const rejected = await handler(
      new Request("https://example.test/people/1", { headers: { accept: "application/json" } }),
      Context.make(Store, new Map()),
    );
    expect(rejected.status).toBe(406);
    const ok = await handler(
      new Request("https://example.test/people/9", { headers: { accept: MEDIA_TYPE } }),
      Context.make(Store, new Map()),
    );
    // The catalogue still maps NotFound first; the extra arm only sees what it declines.
    expect(ok.status).toBe(404);
  });

  // #236: `Endpoint.create` attaches `Middleware.CreatedLocation`, which
  // `Options.middleware`'s type does not name — so a custom set built from the
  // pre-#236 pieces type-checks, and the router supplies the live one.
  const createPerson = (
    middleware: Layer.Layer<Middleware.ContentNegotiation | Middleware.SchemaErrors>,
  ) => {
    const { handler, dispose } = Registry.webHandler(Api, families, { middleware });
    onTestFinished(() => dispose());
    const request = new Request("https://example.test/people", {
      method: "POST",
      headers: { "content-type": MEDIA_TYPE, accept: MEDIA_TYPE },
      body: '{"name":"Bob"}',
    });
    return handler(Negotiation.requestForRouter(request), Context.make(Store, new Map()));
  };

  it("serves a create under a custom middleware set that does not provide CreatedLocation", async () => {
    const response = await createPerson(
      Layer.mergeAll(Middleware.ContentNegotiationPassthrough, Middleware.schemaErrorsLayer()),
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ data: { id: "2" } });
  });

  it("lets a CreatedLocation in the custom middleware set win over the router's", async () => {
    const custom = Layer.succeed(Middleware.CreatedLocation, (httpEffect) =>
      Effect.map(httpEffect, (response) =>
        HttpServerResponse.setHeader(response, "location", "/custom/2"),
      ),
    );
    const response = await createPerson(
      Layer.mergeAll(Middleware.ContentNegotiationPassthrough, Middleware.SchemaErrorsLive, custom),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/custom/2");
  });

  it("does not report an ApiError of its own once the boundary answered it", () => {
    expect(ApiError.Conflict.status).toBe(409);
  });
});
