/**
 * The client-side helpers, pinned against the consuming applications'
 * client corpus: the decoded error response a failed call becomes, the
 * document readers, loose-input decoding, `included` hydration (one hop,
 * typed by cardinality; a dotted path, hop by hop), and the page cursor
 * readers and href builders.
 */
import { describe, expect, it } from "vite-plus/test";
import { Cause, Effect, Exit, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import * as ApiError from "./ApiError.js";
import * as Client from "./Client.js";
import * as Endpoint from "./Endpoint.js";
import * as FlatQuery from "./FlatQuery.js";
import * as Group from "./Group.js";
import { MEDIA_TYPE } from "./internal/media.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
const Credit = Resource.make("credits", {
  attributes: { role: Schema.String },
  relationships: { contributor: Relationship.one(() => Person) },
});
const Book = Resource.make("books", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    authors: Relationship.many(() => Credit),
    publisher: Relationship.optional(() => Person),
    editor: Relationship.optional(() => Person),
  },
});

// ── error responses ──────────────────────────────────────────────────

const Api = HttpApi.make("library").add(Group.make(Person, Endpoint.get(Person)));

/** An `HttpClient` answering every request with one canned response. */
const canned = (status: number, body: string, contentType = MEDIA_TYPE): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": contentType } }),
      ),
    ),
  );

const call = (client: HttpClient.HttpClient, decodeErrors = true) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const api = yield* Client.make(Api, { baseUrl: "http://localhost", decodeErrors });
      return yield* api.people.get({ params: { id: Person.Id.make("1") }, query: {} });
    }).pipe(Effect.provideService(HttpClient.HttpClient, client)) as Effect.Effect<
      unknown,
      unknown
    >,
  );

const failureOf = <A>(exit: Exit.Exit<A, unknown>): unknown => {
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

describe("Client.make({ decodeErrors: true })", () => {
  it("fails a call the server answered with an error document as a decoded ErrorResponse", async () => {
    const body = JSON.stringify(ApiError.toDocument(new ApiError.Conflict({ detail: "taken" })));
    const error = failureOf(await call(canned(409, body)));
    expect(Client.isErrorResponse(error)).toBe(true);
    const response = error as Client.ErrorResponse;
    expect(response.status).toBe(409);
    expect(response.message).toBe("taken");
    expect(Option.map(response.document, (d) => d.errors[0]?.code)).toEqual(
      Option.some("conflict"),
    );
  });

  it("falls back to a status message when the body carries no document", async () => {
    const error = failureOf(await call(canned(502, "<html>bad gateway</html>", "text/html")));
    expect(Client.isErrorResponse(error)).toBe(true);
    const response = error as Client.ErrorResponse;
    expect(response.status).toBe(502);
    expect(response.message).toBe("Request failed (502)");
    expect(Option.isNone(response.document)).toBe(true);
  });

  it("leaves the raw HttpClientError in place without the option, and for a transport fault", async () => {
    const body = JSON.stringify(ApiError.toDocument(new ApiError.Conflict({})));
    const raw = failureOf(await call(canned(409, body), false));
    expect(Client.isErrorResponse(raw)).toBe(false);
    expect((raw as { readonly _tag?: string })._tag).toBe("HttpClientError");
    const faulty = HttpClient.make(() => Effect.die(new Error("connection reset")));
    const exit = await call(faulty);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Option.isNone(await Effect.runPromise(Client.toErrorResponse(new Error("x"))))).toBe(
      true,
    );
  });

  it("applies the caller's transformResponse after the decode, so it sees the ErrorResponse", async () => {
    const seen: Array<unknown> = [];
    const body = JSON.stringify(ApiError.toDocument(new ApiError.Conflict({})));
    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const api = yield* Client.make(Api, {
          baseUrl: "http://localhost",
          decodeErrors: true,
          transformResponse: (effect) =>
            Effect.tapError(effect, (cause) => Effect.sync(() => void seen.push(cause))),
        });
        return yield* api.people.get({ params: { id: Person.Id.make("1") }, query: {} });
      }).pipe(Effect.provideService(HttpClient.HttpClient, canned(409, body))) as Effect.Effect<
        unknown,
        unknown
      >,
    );
    expect(seen).toHaveLength(1);
    expect(Client.isErrorResponse(seen[0])).toBe(true);
  });

  it("failWithErrorResponse is the same seam, standalone", async () => {
    const request = HttpClientRequest.get("http://localhost/people/1");
    const effect = canned(404, JSON.stringify({ errors: [{ status: "404", title: "Not found" }] }))
      .execute(request)
      .pipe(Effect.flatMap((response) => HttpClientResponse.filterStatusOk(response)));
    const error = failureOf(await Effect.runPromiseExit(Client.failWithErrorResponse(effect)));
    expect(Client.isErrorResponse(error)).toBe(true);
    expect((error as Client.ErrorResponse).message).toBe("Not found");
  });
});

// ── document readers and inputs ──────────────────────────────────────

describe("readTotalCount / hasNextPage", () => {
  it("reads meta.totalCount off a document, 0 when absent or not a number", () => {
    expect(Client.readTotalCount({ meta: { totalCount: 42 } })).toBe(42);
    expect(Client.readTotalCount({ meta: { totalCount: "42" } })).toBe(0);
    expect(Client.readTotalCount({})).toBe(0);
    expect(Client.readTotalCount(undefined)).toBe(0);
  });

  it("reports a next page from the unpaged total, correct at an exact multiple", () => {
    expect(Client.hasNextPage(0, 10, 25)).toBe(true);
    expect(Client.hasNextPage(20, 10, 25)).toBe(false);
    expect(Client.hasNextPage(10, 10, 20)).toBe(false);
    // A page fetched past the end reports totalCount 0.
    expect(Client.hasNextPage(50, 10, 0)).toBe(false);
  });
});

describe("decodeInput", () => {
  const ListPeople = FlatQuery.listInput(
    { maxLimit: 100 },
    { q: Schema.optionalKey(Schema.String) },
  );
  const decode = Client.decodeInput(ListPeople);

  it("strips undefined members and applies the schema's defaults", async () => {
    expect(await Effect.runPromise(decode({ limit: 5, q: undefined }))).toEqual({
      offset: 0,
      limit: 5,
    });
    expect(await Effect.runPromise(decode({}))).toEqual({ offset: 0, limit: 50 });
  });

  it("still enforces bounds", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(decode({ limit: 0 })))).toBe(true);
  });

  it("stripUndefined leaves a present key alone", () => {
    expect(Client.stripUndefined({ a: 1, b: undefined, c: null })).toEqual({ a: 1, c: null });
  });
});

// ── hydration ────────────────────────────────────────────────────────

const document = {
  data: {
    type: "books",
    id: "b1",
    attributes: { title: "Dune" },
    relationships: {
      authors: {
        data: [
          { type: "credits", id: "c1" },
          { type: "credits", id: "c2" },
          { type: "credits", id: "c3" },
        ],
      },
      publisher: { data: { type: "people", id: "p9" } },
      editor: { data: null },
    },
  },
  included: [
    {
      type: "credits",
      id: "c2",
      attributes: { role: "author" },
      relationships: { contributor: { data: { type: "people", id: "p1" } } },
    },
    {
      type: "credits",
      id: "c1",
      attributes: { role: "author" },
      relationships: { contributor: { data: { type: "people", id: "p1" } } },
    },
    { type: "people", id: "p1", attributes: { name: "Frank Herbert" } },
    { type: "people", id: "p9", attributes: { name: "Chilton" } },
  ],
};

describe("hydration", () => {
  const index = Client.indexIncluded(document.included);

  it("resolves a to-one as an Option and a to-many in linkage order, skipping unresolved refs", () => {
    const publisher = Client.related(Book, document.data, "publisher", index);
    expect(Option.map(publisher, (p) => p.attributes.name)).toEqual(Option.some("Chilton"));
    expect(Option.isNone(Client.related(Book, document.data, "editor", index))).toBe(true);
    // Linkage order (c1, c2), not `included` order (c2, c1); c3 was not hoisted.
    expect(Client.related(Book, document.data, "authors", index).map((c) => c.id)).toEqual([
      "c1",
      "c2",
    ]);
  });

  it("walks a dotted path hop by hop, deduplicating the last hop", () => {
    expect(
      Client.walk(Book, document.data, "authors.contributor", index).map((p) => p.attributes.name),
    ).toEqual(["Frank Herbert"]);
    expect(Client.walk(Book, { relationships: {} }, "authors.contributor", index)).toEqual([]);
  });

  it("tolerates a missing relationship, empty linkage and an absent included member", () => {
    expect(Client.related(Book, undefined, "authors", index)).toEqual([]);
    expect(
      Client.related(Book, { relationships: {} }, "authors", Client.indexIncluded(undefined)),
    ).toEqual([]);
    expect(
      Option.isNone(
        Client.related(Book, { relationships: { publisher: { data: null } } }, "publisher", index),
      ),
    ).toBe(true);
  });

  it("hydrate binds the definition and the index once", () => {
    const book = Client.hydrate(Book, document);
    expect(book.index.size).toBe(4);
    expect(book.walk("authors.contributor").map((p) => p.id)).toEqual(["p1"]);
    expect(Option.map(book.related("publisher"), (p) => p.id)).toEqual(Option.some("p9"));
    expect(Client.hydrate(Book, { data: null, included: [] }).related("authors")).toEqual([]);
  });
});

// ── page cursors ─────────────────────────────────────────────────────

describe("readPageCursor", () => {
  it("reads the pair off a URL, search params or a query string", () => {
    expect(
      Client.readPageCursor(new URL("https://x.test/people?page[offset]=20&page[limit]=10")),
    ).toEqual({ offset: 20, limit: 10 });
    expect(Client.readPageCursor(new URLSearchParams("page[offset]=20&page[limit]=10"))).toEqual({
      offset: 20,
      limit: 10,
    });
    expect(Client.readPageCursor("/people?page[limit]=10")).toEqual({ offset: 0, limit: 10 });
  });

  it("falls back per field on absent or malformed values, clamps the limit, and honours a custom key", () => {
    expect(Client.readPageCursor("/people")).toEqual({ offset: 0, limit: 50 });
    expect(
      Client.readPageCursor("/people?page[limit]=abc&page[offset]=-1", { defaultLimit: 24 }),
    ).toEqual({ offset: 0, limit: 24 });
    expect(Client.readPageCursor("/people?page[limit]=999", { maxLimit: 100 })).toEqual({
      offset: 0,
      limit: 100,
    });
    expect(Client.readPageCursor("/people?page[limit]=0")).toEqual({ offset: 0, limit: 1 });
    expect(
      Client.readPageCursor("/q?answers[offset]=5&answers[limit]=2", { key: "answers" }),
    ).toEqual({ offset: 5, limit: 2 });
  });
});

describe("page hrefs", () => {
  it("pageHref replaces the cursor and preserves every other parameter and the fragment", () => {
    expect(
      Client.pageHref("/people?filter[q]=ada&page[offset]=0#top", { offset: 10, limit: 10 }),
    ).toBe("/people?filter%5Bq%5D=ada&page%5Boffset%5D=10&page%5Blimit%5D=10#top");
    expect(Client.pageHref("/people", { offset: 0, limit: 5 }, { key: "answers" })).toBe(
      "/people?answers%5Boffset%5D=0&answers%5Blimit%5D=5",
    );
  });

  it("filteredPageHref leaves the first page bare and carries applied filters", () => {
    const href = Client.filteredPageHref("/people", { q: "ada", role: "", empty: undefined });
    expect(href(0)).toBe("/people?q=ada");
    expect(href(24)).toBe("/people?page%5Boffset%5D=24&q=ada");
    expect(Client.filteredPageHref("/people")(0)).toBe("/people");
  });

  it("windowedPageHref states the whole window, the first page included", () => {
    const href = Client.windowedPageHref("/admin/people", 50, { q: "ada" });
    expect(href(0)).toBe("/admin/people?page%5Blimit%5D=50&page%5Boffset%5D=0&q=ada");
  });

  it("canonicalPageHref keeps the canonical pairs and replaces the request's own cursor", () => {
    expect(
      Client.canonicalPageHref(
        "/people",
        [
          ["include", "birthPlace"],
          ["filter[q]", "ada"],
          ["page[offset]", "0"],
          ["page[limit]", "10"],
        ],
        { offset: 10, limit: 10 },
      ),
    ).toBe("/people?include=birthPlace&filter[q]=ada&page[offset]=10&page[limit]=10");
    expect(Client.canonicalPageHref("/people", [], { offset: 0, limit: 5 })).toBe(
      "/people?page[offset]=0&page[limit]=5",
    );
  });
});

describe("pageWindow", () => {
  it("computes the window around the current page with gaps", () => {
    const window = Client.pageWindow({ offset: 40, limit: 10 }, 95);
    expect(window).toMatchObject({ page: 5, pageCount: 10, from: 41, to: 50 });
    expect(window.prev).toEqual(Option.some(30));
    expect(window.next).toEqual(Option.some(50));
    expect(window.items.map((item) => (item.kind === "gap" ? "…" : item.page))).toEqual([
      1,
      "…",
      4,
      5,
      6,
      "…",
      10,
    ]);
    expect(window.items.find((item) => item.kind === "page" && item.current)).toMatchObject({
      page: 5,
      offset: 40,
    });
  });

  it("handles the edges: an empty collection, the first and last pages, a past-the-end offset", () => {
    expect(Client.pageWindow({ offset: 0, limit: 10 }, 0)).toMatchObject({
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
    const first = Client.pageWindow({ offset: 0, limit: 10 }, 25);
    expect(Option.isNone(first.prev)).toBe(true);
    expect(first.items.map((i) => (i.kind === "gap" ? "…" : i.page))).toEqual([1, 2, 3]);
    const last = Client.pageWindow({ offset: 20, limit: 10 }, 25);
    expect(Option.isNone(last.next)).toBe(true);
    expect(last.to).toBe(25);
    expect(Client.pageWindow({ offset: 500, limit: 10 }, 25).page).toBe(3);
  });
});
