import { assert, describe, expect, it } from "vite-plus/test";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { HttpApi, HttpApiClient } from "effect/http-api";
import { Conflict, make as ApiErrorMake, toDocument } from "./ApiError.js";
import { EXTENSION_URI } from "./Atomic.js";
import {
  DEFAULT_ERROR_MESSAGE,
  decodeErrorDocument,
  errorDocument,
  errorMessage,
  isMutatingMethod,
  jsonApiHeaders,
  jsonApiHeadersWith,
  make,
  mediaType,
  transform,
} from "./Client.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import { acceptIsAcceptable, contentTypeIsAcceptable } from "./Middleware.js";
import { make as Resource } from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

// ---------------------------------------------------------------------------
// mediaType
// ---------------------------------------------------------------------------

describe("Client.mediaType", () => {
  it("is the bare media type without extensions", () => {
    expect(mediaType()).toBe(MEDIA_TYPE);
    expect(mediaType({})).toBe(MEDIA_TYPE);
    expect(mediaType({ extensions: [] })).toBe(MEDIA_TYPE);
  });

  it("carries the extension URIs as a quoted, space-separated ext parameter", () => {
    expect(mediaType({ extensions: [EXTENSION_URI] })).toBe(`${MEDIA_TYPE};ext="${EXTENSION_URI}"`);
    expect(mediaType({ extensions: [EXTENSION_URI, "https://example.com/ext/other"] })).toBe(
      `${MEDIA_TYPE};ext="${EXTENSION_URI} https://example.com/ext/other"`,
    );
  });

  // The structural guarantee: the client's header value is built from the same
  // definition the server's §5 parser reads, so the two cannot drift apart.
  it("produces headers the server's own negotiation accepts", () => {
    expect(acceptIsAcceptable(mediaType())).toBe(true);
    expect(contentTypeIsAcceptable(mediaType())).toBe(true);

    const options = { extensions: [EXTENSION_URI] };
    expect(acceptIsAcceptable(mediaType(options), options)).toBe(true);
    expect(contentTypeIsAcceptable(mediaType(options), options)).toBe(true);
  });

  it("produces headers a server that does not support the extension rejects", () => {
    const header = mediaType({ extensions: [EXTENSION_URI] });
    expect(acceptIsAcceptable(header)).toBe(false);
    expect(contentTypeIsAcceptable(header)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMutatingMethod
// ---------------------------------------------------------------------------

describe("Client.isMutatingMethod", () => {
  it("is true for the four mutating methods, DELETE included", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("PATCH")).toBe(true);
    expect(isMutatingMethod("PUT")).toBe(true);
    // The case three independent implementations get inconsistently right: a
    // DELETE carries no body, but still carries the label.
    expect(isMutatingMethod("DELETE")).toBe(true);
  });

  it("is false for safe methods", () => {
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("HEAD")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
    expect(isMutatingMethod("TRACE")).toBe(false);
  });

  it("is case-insensitive, so a raw Request.method works", () => {
    expect(isMutatingMethod("delete")).toBe(true);
    expect(isMutatingMethod("get")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// jsonApiHeaders
// ---------------------------------------------------------------------------

describe("Client.jsonApiHeaders", () => {
  it("stamps Accept on a read, and nothing else", () => {
    const request = jsonApiHeaders(HttpClientRequest.get("/articles/1"));
    expect(request.headers["accept"]).toBe(MEDIA_TYPE);
    expect(request.headers["content-type"]).toBeUndefined();
  });

  it("stamps Content-Type on a bodyless DELETE", () => {
    const request = jsonApiHeaders(HttpClientRequest.delete("/articles/1"));
    expect(request.headers["accept"]).toBe(MEDIA_TYPE);
    expect(request.headers["content-type"]).toBe(MEDIA_TYPE);
  });

  it("relabels the default application/json without touching the body", () => {
    const request = jsonApiHeaders(
      HttpClientRequest.bodyText(
        HttpClientRequest.post("/articles"),
        `{"data":{}}`,
        "application/json",
      ),
    );
    expect(request.headers["content-type"]).toBe(MEDIA_TYPE);
    expect(request.body._tag).toBe("Uint8Array");
  });

  it("leaves a genuinely different representation alone", () => {
    const request = jsonApiHeaders(
      HttpClientRequest.bodyText(
        HttpClientRequest.post("/uploads"),
        "--boundary--",
        "multipart/form-data; boundary=boundary",
      ),
    );
    // Only the label changes, never the meaning: an upload is not a
    // mislabelled JSON:API document.
    expect(request.headers["content-type"]).toBe("multipart/form-data; boundary=boundary");
    // …but the response is still expected to be JSON:API.
    expect(request.headers["accept"]).toBe(MEDIA_TYPE);
  });

  it("replaces an existing Accept rather than appending to it", () => {
    const request = jsonApiHeaders(
      HttpClientRequest.get("/articles/1", { headers: { accept: "text/html" } }),
    );
    expect(request.headers["accept"]).toBe(MEDIA_TYPE);
  });
});

describe("Client.jsonApiHeadersWith", () => {
  it("carries the ext parameter on both headers", () => {
    const stamp = jsonApiHeadersWith({ extensions: [EXTENSION_URI] });
    const request = stamp(HttpClientRequest.post("/operations"));
    const expected = `${MEDIA_TYPE};ext="${EXTENSION_URI}"`;
    expect(request.headers["accept"]).toBe(expected);
    expect(request.headers["content-type"]).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// transform / make
// ---------------------------------------------------------------------------

class ArticleNotFound extends ApiErrorMake<ArticleNotFound>()("ArticleNotFound", {
  status: 404,
  code: "not_found",
  title: "Resource not found",
}) {}

const Article = Resource("articles", { attributes: { title: Schema.NonEmptyString } });

const Api = HttpApi.make("blog").add(
  Group.make(
    Article,
    Endpoint.get(Article, { errors: [ArticleNotFound] }),
    Endpoint.delete(Article),
  ),
);

const articleDocument = JSON.stringify({
  data: { type: "articles", id: "1", attributes: { title: "JSON:API paints my bikeshed!" } },
});

/** An `HttpClient` that records what it was asked to send and replays a canned response. */
const recordingClient = (
  sent: Array<HttpClientRequest.HttpClientRequest>,
  body: string,
  status: number,
): HttpClient.HttpClient =>
  HttpClient.make((request) => {
    sent.push(request);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(status === 204 ? null : body, {
          status,
          headers: { "content-type": MEDIA_TYPE },
        }),
      ),
    );
  });

describe("Client.transform", () => {
  it("stamps the negotiation headers on every request the client sends", async () => {
    const sent: Array<HttpClientRequest.HttpClientRequest> = [];
    await Effect.runPromise(
      transform(recordingClient(sent, articleDocument, 200)).get("http://localhost/articles/1"),
    );
    expect(sent[0]?.headers["accept"]).toBe(MEDIA_TYPE);
  });
});

describe("Client.make", () => {
  it("derives a client whose reads carry Accept — which a plain HttpApiClient omits", async () => {
    const bare: Array<HttpClientRequest.HttpClientRequest> = [];
    const negotiated: Array<HttpClientRequest.HttpClientRequest> = [];

    const read = (client: { readonly articles: { readonly get: any } }) =>
      client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api, { baseUrl: "http://localhost" });
        yield* read(client);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, recordingClient(bare, articleDocument, 200)),
      ) as Effect.Effect<void>,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(Api, { baseUrl: "http://localhost" });
        yield* read(client);
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          recordingClient(negotiated, articleDocument, 200),
        ),
      ) as Effect.Effect<void>,
    );

    expect(bare[0]?.headers["accept"]).toBeUndefined();
    expect(negotiated[0]?.headers["accept"]).toBe(MEDIA_TYPE);
  });

  it("labels a bodyless DELETE, which a plain HttpApiClient leaves unlabelled", async () => {
    const bare: Array<HttpClientRequest.HttpClientRequest> = [];
    const negotiated: Array<HttpClientRequest.HttpClientRequest> = [];

    const remove = (client: { readonly articles: { readonly delete: any } }) =>
      client.articles.delete({ params: { id: Article.Id.make("1") } });

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* HttpApiClient.make(Api, { baseUrl: "http://localhost" });
        yield* remove(client);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, recordingClient(bare, "", 204)),
      ) as Effect.Effect<void>,
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(Api, { baseUrl: "http://localhost" });
        yield* remove(client);
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, recordingClient(negotiated, "", 204)),
      ) as Effect.Effect<void>,
    );

    expect(bare[0]?.headers["content-type"]).toBeUndefined();
    expect(negotiated[0]?.headers["content-type"]).toBe(MEDIA_TYPE);
  });

  it("applies a caller's transformClient after the negotiation transform, so it can win", async () => {
    const sent: Array<HttpClientRequest.HttpClientRequest> = [];
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* make(Api, {
          baseUrl: "http://localhost",
          transformClient: (client) =>
            HttpClient.mapRequest(
              client,
              HttpClientRequest.setHeader("authorization", "Bearer token"),
            ),
        });
        yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, recordingClient(sent, articleDocument, 200)),
      ) as Effect.Effect<void>,
    );

    expect(sent[0]?.headers["authorization"]).toBe("Bearer token");
    expect(sent[0]?.headers["accept"]).toBe(MEDIA_TYPE);
  });
});

// ---------------------------------------------------------------------------
// decodeErrorDocument
// ---------------------------------------------------------------------------

const notFound = toDocument(new ArticleNotFound());

describe("Client.decodeErrorDocument", () => {
  it("decodes a conformant document from body text", () => {
    const decoded = decodeErrorDocument(JSON.stringify(notFound));
    assert(Option.isSome(decoded));
    expect(decoded.value.errors[0]?.status).toBe("404");
  });

  it("decodes an already-parsed JSON value, so it is reachable off the response path", () => {
    // A façade that synthesises its own responses never holds an
    // HttpClientError; it decodes the body it just rendered.
    const offline = toDocument(new Conflict({ detail: "Not available offline" }));
    const decoded = decodeErrorDocument(offline);
    assert(Option.isSome(decoded));
    expect(errorMessage(decoded.value)).toBe("Not available offline");
  });

  it("round-trips exactly what the server renders", () => {
    // The structural guarantee: a façade-served error and a network-served
    // error for the same URL decode to the same value.
    const rendered = toDocument(new ArticleNotFound());
    const viaFacade = decodeErrorDocument(rendered);
    const viaWire = decodeErrorDocument(JSON.stringify(rendered));
    expect(viaFacade).toStrictEqual(viaWire);
  });

  describe("degrades to none, never throws", () => {
    it.each([
      ["HTML from a proxy", "<html><body><h1>502 Bad Gateway</h1></body></html>"],
      ["a truncated body", '{"errors":[{"stat'],
      ["an empty body", ""],
      ["whitespace", "   "],
      ["a bare JSON null", "null"],
      ["a JSON scalar", "42"],
      ["a JSON array", "[]"],
      ["a plain-text status line", "Service Unavailable"],
      ["a data document, not an error document", '{"data":{"type":"articles","id":"1"}}'],
      ["an empty errors array", '{"errors":[]}'],
      ["errors that are not objects", '{"errors":["boom"]}'],
      ["a non-string status member", '{"errors":[{"status":503}]}'],
    ])("%s", (_name, body) => {
      expect(Option.isNone(decodeErrorDocument(body))).toBe(true);
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["a number", 502],
      ["a function", () => {}],
    ])("%s", (_name, body) => {
      // Outside the declared input: what an untyped (JavaScript) caller can
      // still hand it. It must degrade, not throw.
      expect(Option.isNone(decodeErrorDocument(body as never))).toBe(true);
    });

    it("a hostile value whose own accessors throw", () => {
      const hostile = {
        get errors(): never {
          throw new Error("boom");
        },
      };
      expect(Option.isNone(decodeErrorDocument(hostile))).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// errorDocument
// ---------------------------------------------------------------------------

const clientError = (body: string | null, status: number): HttpClientError.HttpClientError => {
  const request = HttpClientRequest.get("http://localhost/articles/1");
  const response = HttpClientResponse.fromWeb(request, new Response(body, { status }));
  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({ request, response }),
  });
};

describe("Client.errorDocument", () => {
  it("reads the document off a failed call", async () => {
    const document = await Effect.runPromise(
      errorDocument(clientError(JSON.stringify(notFound), 404)),
    );
    assert(Option.isSome(document));
    expect(errorMessage(document.value)).toBe(ArticleNotFound.title);
  });

  it("decodes through the same seam as a body handed in directly", async () => {
    const body = JSON.stringify(toDocument(new Conflict({ detail: "Title taken" })));
    const fromCause = await Effect.runPromise(errorDocument(clientError(body, 409)));
    expect(fromCause).toStrictEqual(decodeErrorDocument(body));
  });

  it("degrades to none for a non-conforming response body", async () => {
    const document = await Effect.runPromise(
      errorDocument(clientError("<html>502 Bad Gateway</html>", 502)),
    );
    expect(Option.isNone(document)).toBe(true);
  });

  it("degrades to none for a transport failure carrying no response", async () => {
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request: HttpClientRequest.get("http://localhost/articles/1"),
        description: "offline",
      }),
    });
    expect(Option.isNone(await Effect.runPromise(errorDocument(error)))).toBe(true);
  });

  it("degrades to none for a cause that is not an HttpClientError at all", async () => {
    expect(Option.isNone(await Effect.runPromise(errorDocument(new Error("boom"))))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(errorDocument(undefined)))).toBe(true);
    expect(Option.isNone(await Effect.runPromise(errorDocument("nope")))).toBe(true);
  });

  it("degrades to none when the body cannot be read at all", async () => {
    const request = HttpClientRequest.get("http://localhost/articles/1");
    const broken = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error("connection reset"));
        },
      }),
      { status: 502 },
    );
    const error = new HttpClientError.HttpClientError({
      reason: new HttpClientError.StatusCodeError({
        request,
        response: HttpClientResponse.fromWeb(request, broken),
      }),
    });
    // The read fails; it does not throw out of the error path.
    expect(Option.isNone(await Effect.runPromise(errorDocument(error)))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// errorMessage
// ---------------------------------------------------------------------------

describe("Client.errorMessage", () => {
  it("prefers the first error's detail", () => {
    expect(
      errorMessage({
        errors: [
          { status: "404", title: "Not Found", detail: "Article 1 not found" },
          { status: "404", detail: "second" },
        ],
      }),
    ).toBe("Article 1 not found");
  });

  it("falls back to the title", () => {
    expect(errorMessage({ errors: [{ status: "404", title: "Not Found" }] })).toBe("Not Found");
  });

  it("falls back to a constant when the error carries neither", () => {
    expect(errorMessage({ errors: [{ status: "503" }] })).toBe(DEFAULT_ERROR_MESSAGE);
    expect(errorMessage({ errors: [] })).toBe(DEFAULT_ERROR_MESSAGE);
  });
});
