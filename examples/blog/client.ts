/**
 * Talking to the blog server as a client.
 *
 * Two things every JSON:API consumer needs, and which the package owns so that
 * five hand-rolled transports don't each own them differently:
 *
 *   1. **Negotiation.** `HttpApiClient.make` sends `Accept: application/json`,
 *      which this package's own `Middleware.ContentNegotiationLive` refuses.
 *      `Client.make` is `HttpApiClient.make` with `Client.transform` already
 *      applied, so a generated client can talk to the server that generated it.
 *   2. **Error documents.** A call that fails with a status the endpoint did
 *      not declare surfaces as an `HttpClientError`, and the JSON:API error
 *      document it carries has to be recovered best-effort — a network fault or
 *      an opaque 5xx must degrade to "no document", never to a second error
 *      thrown inside the error path.
 *
 * Everything here runs against the in-memory blog server: no port is bound.
 */
import { Effect, Layer, Option } from "effect"
import {
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerRequest,
  HttpServerResponse
} from "effect/unstable/http"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Client, Document, Middleware } from "@thomasfosterau/effect-jsonapi"
import { Api } from "./api.js"
import { BlogLive } from "./handlers.js"

/**
 * An `HttpClient` that dispatches into the blog server in memory — the same
 * request encoding, routing, middleware and response encoding a socket would
 * go through, without one.
 */
export const InMemoryTransport = Layer.effect(HttpClient.HttpClient)(
  Effect.gen(function* () {
    // The api's routes, with the blog's handler groups (and the middleware
    // they carry) provided into them — the same wiring a real server uses.
    const handler = yield* HttpRouter.toHttpEffect(HttpApiBuilder.layer(Api).pipe(Layer.provide(BlogLive)))
    return HttpClient.make(
      Effect.fnUntraced(function* (request: HttpClientRequest.HttpClientRequest) {
        const response = yield* handler.pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromClientRequest(request)),
          Effect.orDie
        )
        return HttpServerResponse.toClientResponse(response)
      }, Effect.scoped)
    )
  })
)

/**
 * Where the in-memory server answers. Nothing binds it — an `HttpClient` needs
 * an absolute URL to resolve a request against, so the transport above needs a
 * host to be addressed by.
 */
export const baseUrl = "http://blog.test"

/**
 * The generated client, negotiating JSON:API on every request.
 *
 * Without `Client.make`'s transform this is rejected by the api's own
 * content-negotiation middleware with a 415 or 406 — the client and the server
 * come from the same package and still cannot talk until the media type is
 * stamped on.
 */
export const blogClient = Client.make(Api, { baseUrl })

/**
 * A raw request against the server, failing on any non-2xx so the failure
 * carries the response — which is how an app transport that isn't a generated
 * client sees things.
 */
export const fetchRaw = (
  path: string
): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient
    // `Client.transform` is the negotiation half on its own, for a client
    // assembled by hand rather than by `Client.make`.
    return yield* Client.transform(http)
      .pipe(HttpClient.filterStatusOk)
      .execute(HttpClientRequest.get(`${baseUrl}${path}`))
  })

/**
 * Whatever went wrong, as a sentence a person can read.
 *
 * The recovery is total: a JSON:API error document gives its first `detail`,
 * and anything else — a transport fault, an HTML error page from a proxy, a
 * truncated body — falls back to the generic message rather than failing again.
 */
export const describeFailure = (cause: unknown): Effect.Effect<string> =>
  Client.errorDocument(cause).pipe(
    Effect.map(
      Option.match({
        onNone: () => "Request could not be completed",
        onSome: Document.errorMessage
      })
    )
  )

/**
 * What a server negotiating JSON:API makes of the headers this client sends —
 * the same §5 predicates the middleware applies, run over the client's own
 * request, so the two halves are demonstrably the same rules.
 */
export const negotiationOf = (
  request: HttpClientRequest.HttpClientRequest
): {
  readonly accept: string | undefined
  readonly contentType: string | undefined
  readonly acceptable: boolean
} => {
  const stamped = Client.jsonApiHeaders(request)
  return {
    accept: stamped.headers["accept"],
    contentType: stamped.headers["content-type"],
    acceptable:
      Middleware.negotiate({
        accept: stamped.headers["accept"],
        contentType: stamped.headers["content-type"]
      }) === undefined
  }
}
