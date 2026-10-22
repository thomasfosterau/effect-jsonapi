/**
 * End-to-end test of the blog example's **client**: a real round-trip through
 * request encoding, §5 content negotiation, routing, handlers and response
 * decoding — and, on the failure paths, the error document that comes back.
 *
 * The point of the file is the last group: an error served by the blog server,
 * an error served by a load balancer in front of it, and an error the offline
 * façade synthesises without a server at all, all reduced to one message by one
 * accessor.
 */
import { assert, describe, expect, it } from "vite-plus/test";
import { Effect, Option } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { ApiError, Client, MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi";
import { Api } from "../api.js";
import {
  blogClient,
  describeFailure,
  negotiation,
  Offline,
  servedOffline,
  ServerHttpClient,
} from "../client.js";
import { ArticleNotFound } from "../errors.js";
import { Article } from "../resources.js";

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(ServerHttpClient)) as Effect.Effect<A, E, never>,
  );

/** A load balancer in front of the server, answering with its own opaque body. */
const gateway = (body: string, status: number, contentType: string): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(body, { status, headers: { "content-type": contentType } }),
      ),
    ),
  );

describe("blog client: negotiation", () => {
  it("round-trips a document against the blog server", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* blogClient;
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
      }),
    );

    expect(document.data).toMatchObject({
      type: "articles",
      attributes: { title: "JSON:API paints my bikeshed!" },
    });
  });

  it("advertises the extension the server supports, on both headers", async () => {
    const sent: Array<Record<string, string>> = [];
    const recorder = HttpClient.make((request) => {
      sent.push({ ...request.headers });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.make(Api, {
          ...negotiation,
          baseUrl: "http://blog.example.com",
        });
        yield* client.articles.delete({ params: { id: Article.Id.make("1") } });
      }).pipe(Effect.provideService(HttpClient.HttpClient, recorder)) as Effect.Effect<void>,
    );

    const expected = `${MEDIA_TYPE};ext="https://jsonapi.org/ext/atomic"`;
    // A bodyless DELETE carries the label too — the detail independent
    // implementations get inconsistently right.
    expect(sent[0]?.["accept"]).toBe(expected);
    expect(sent[0]?.["content-type"]).toBe(expected);
  });

  it("a plain HttpApiClient sends neither header", async () => {
    const sent: Array<Record<string, string>> = [];
    const recorder = HttpClient.make((request) => {
      sent.push({ ...request.headers });
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })),
      );
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api, { baseUrl: "http://blog.example.com" });
        yield* client.articles.delete({ params: { id: Article.Id.make("1") } });
      }).pipe(Effect.provideService(HttpClient.HttpClient, recorder)) as Effect.Effect<void>,
    );

    expect(sent[0]?.["accept"]).toBeUndefined();
    expect(sent[0]?.["content-type"]).toBeUndefined();
  });
});

describe("blog client: error documents", () => {
  it("a declared error arrives as a typed error, and renders the same document", async () => {
    const failure = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* blogClient;
        return yield* client.articles.get({ params: { id: Article.Id.make("999") }, query: {} });
      }).pipe(
        Effect.scoped,
        Effect.provide(ServerHttpClient),
        Effect.flip,
      ) as Effect.Effect<unknown>,
    );

    expect(failure).toBeInstanceOf(ArticleNotFound);
    // The typed error and a decoded wire document meet at the same accessor.
    expect(Client.errorMessage(ApiError.toDocument(failure as ArticleNotFound))).toBe(
      "Article 999 not found",
    );
  });

  it("an undeclared error document from in front of the server is decoded", async () => {
    // A 503 the load balancer renders as a JSON:API error document: the api
    // never declared it, so it surfaces as an HttpClientError.
    const document = ApiError.toDocument(new ApiError.Conflict({ detail: "Upstream is draining" }));
    const cause = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.make(Api, {
          ...negotiation,
          baseUrl: "http://blog.example.com",
        });
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          gateway(JSON.stringify(document), 503, MEDIA_TYPE),
        ),
        Effect.flip,
      ) as Effect.Effect<unknown>,
    );

    expect(await Effect.runPromise(describeFailure(cause))).toBe("Upstream is draining");
  });

  it("a proxy's HTML degrades to the fallback message rather than throwing", async () => {
    const cause = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.make(Api, {
          ...negotiation,
          baseUrl: "http://blog.example.com",
        });
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          gateway("<html><body><h1>502 Bad Gateway</h1></body></html>", 502, "text/html"),
        ),
        Effect.flip,
      ) as Effect.Effect<unknown>,
    );

    expect(await Effect.runPromise(describeFailure(cause))).toBe("The blog could not be reached");
  });

  it("the offline façade's own error decodes through the same seam", async () => {
    const document = servedOffline();
    assert(Option.isSome(document));
    expect(Client.errorMessage(document.value)).toBe("This article is not available offline");

    // Indistinguishable from the same document arriving over the network.
    const cause = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* Client.make(Api, {
          ...negotiation,
          baseUrl: "http://blog.example.com",
        });
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          gateway(JSON.stringify(ApiError.toDocument(new Offline())), 503, MEDIA_TYPE),
        ),
        Effect.flip,
      ) as Effect.Effect<unknown>,
    );

    expect(await Effect.runPromise(Client.errorDocument(cause))).toStrictEqual(document);
  });
});
