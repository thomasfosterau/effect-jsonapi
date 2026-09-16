/**
 * The client half, end to end against the in-memory blog server: negotiation
 * that the server accepts, and a JSON:API error document recovered from a
 * failed call.
 */
import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Client, Document } from "@thomasfosterau/effect-jsonapi"
import { blogClient, describeFailure, fetchRaw, InMemoryTransport, negotiationOf } from "../client.js"
import { Article } from "../resources.js"

const run = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(InMemoryTransport), Effect.scoped) as Effect.Effect<A, E, never>)

describe("the generated client negotiates JSON:API", () => {
  it("fetches through the server's own content-negotiation middleware", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* blogClient
        return yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} })
      })
    )

    expect(document.data?.attributes.title).toBe("JSON:API paints my bikeshed!")
  })

  it("stamps Content-Type on a write, which the middleware requires", async () => {
    // A generated client without the transform sends `application/json` here
    // and is answered with a 415.
    const post = negotiationOf(HttpClientRequest.post("/articles"))
    expect(post.contentType).toBe("application/vnd.api+json")
    expect(post.acceptable).toBe(true)

    const get = negotiationOf(HttpClientRequest.get("/articles"))
    expect(get.contentType).toBeUndefined()
    expect(get.acceptable).toBe(true)
  })
})

describe("a failed call's error document", () => {
  // The document is read inside the same scope as the call: the response body
  // is a stream, so recovering it is part of handling the failure, not
  // something to defer past the scope that owns the response.
  const failureOf = (path: string) => run(fetchRaw(path).pipe(Effect.flip, Effect.flatMap(Client.errorDocument)))

  it("round-trips a 404 raised by the server as a JSON:API error document", async () => {
    const document = await failureOf("/articles/nope")
    expect(Option.isSome(document)).toBe(true)

    const error = Option.getOrThrow(document).errors[0]
    expect(error?.status).toBe("404")
    expect(error?.code).toBe("not_found")
    expect(error?.title).toBe("Resource not found")
    expect(error?.detail).toBe("Article nope not found")
    expect(Option.map(document, Document.errorMessage)).toEqual(Option.some("Article nope not found"))
  })

  it("round-trips a 400 whose source names the offending query parameter", async () => {
    const error = Option.getOrThrow(await failureOf("/articles?sort=nonsense")).errors[0]
    expect(error?.status).toBe("400")
    expect(error?.source).toEqual({ parameter: "sort" })
  })

  it("degrades to a generic message rather than failing again", async () => {
    // The cases an error path has to survive: a transport fault with no
    // response at all, and a response whose body is not an error document.
    expect(await Effect.runPromise(describeFailure(new Error("connection reset")))).toBe(
      "Request could not be completed"
    )
    expect(Option.isNone(Document.decodeErrorDocument("<html>502 Bad Gateway</html>"))).toBe(true)
  })

  it("decodes a document the client never received, for a façade that synthesises one", async () => {
    // `Document.decodeErrorDocument` needs no response, so a façade answering
    // from a local replica renders failures the same way the network does.
    const offline = Document.decodeErrorDocument({
      errors: [{ status: "503", code: "offline", title: "Offline", detail: "This read is not covered offline" }]
    })
    expect(Option.map(offline, Document.errorMessage)).toEqual(Option.some("This read is not covered offline"))
  })
})
