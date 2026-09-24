/**
 * The blog's **client**: the other half of the example.
 *
 * `api.ts` declares the endpoints and `handlers.ts` serves them; this module
 * is what a consumer of that api writes. Two things every JSON:API client
 * needs, and that the package owns so nobody hand-rolls them:
 *
 *   - **Negotiation.** `Client.make` derives the typed client with the JSON:API
 *     `Accept` / `Content-Type` transform already applied. Note that it is
 *     given the *same* `extensions` value as the server's
 *     `Middleware.layerWith` in `handlers.ts` — the client advertises exactly
 *     the extension the server supports, so §5 negotiation succeeds by
 *     construction rather than by two files agreeing.
 *   - **Error documents.** {@link describeFailure} turns *any* failure into one
 *     human-readable message. A typed error the api declares, an error document
 *     from something sitting in front of the server, and a document the offline
 *     façade synthesises locally all reach `Client.errorMessage` — so the
 *     wording cannot drift between the three paths.
 */
import { Effect, Layer, Option } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ApiError, Atomic, Client } from "@thomasfosterau/effect-jsonapi";
import { Api } from "./api.js";
import { BlogLive } from "./handlers.js";

/**
 * The negotiation options both halves share: the blog api speaks the atomic
 * operations extension, so the client advertises it and the server accepts it.
 */
export const negotiation = { extensions: [Atomic.EXTENSION_URI] };

/**
 * The typed blog client, negotiating JSON:API on every request.
 *
 * Without the transform `Client.make` applies, requests would carry no `Accept`
 * at all (so a host serving HTML and JSON:API on one origin has nothing to
 * select on) and a bodyless `DELETE` would go out with no `Content-Type`.
 */
export const blogClient = Client.make(Api, { ...negotiation, baseUrl: "http://blog.example.com" });

/**
 * A 503 the client answers with *itself*, without reaching the server — the
 * shape a façade in front of an offline-capable app synthesises for a read it
 * cannot cover.
 */
export class Offline extends ApiError.make<Offline>()("Offline", {
  status: 503,
  code: "offline",
  title: "Service Unavailable",
  detail: "This article is not available offline",
}) {}

/**
 * The façade path: a response synthesised locally, never a network response and
 * never an `HttpClientError`. It still decodes through
 * `Client.decodeErrorDocument` — the same seam the network transport uses —
 * which is what makes a façade-served error indistinguishable from a
 * server-served one.
 */
export const servedOffline = (): Option.Option<Client.ErrorDocument> =>
  Client.decodeErrorDocument(ApiError.toDocument(new Offline()));

/**
 * One message for any failure of a blog call.
 *
 * `Client.errorDocument` is best-effort by design: a load balancer's HTML, a
 * truncated payload or a transport fault carry no document, and the caller
 * falls back rather than failing a second time inside the error path.
 */
export const describeFailure = (cause: unknown): Effect.Effect<string> =>
  Effect.map(Client.errorDocument(cause), (document) =>
    Option.match(document, {
      onNone: () => "The blog could not be reached",
      onSome: Client.errorMessage,
    }),
  );

/**
 * The blog server, served in-process as an `HttpClient` — request encoding,
 * routing, middleware (content negotiation included), handlers and response
 * encoding, with the network left out.
 *
 * Stands in for `FetchHttpClient.layer` in a real app. Its requirements are the
 * platform services `HttpRouter` needs, all of which carry defaults.
 */
export const ServerHttpClient = Layer.effect(
  HttpClient.HttpClient,
  Effect.gen(function* () {
    const handler = yield* HttpRouter.toHttpEffect(
      HttpApiBuilder.layer(Api).pipe(Layer.provide(BlogLive)),
    );
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
  }),
);
