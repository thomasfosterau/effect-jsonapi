import { describe, expect, it } from "vitest"
import { Effect, Option } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import * as Atomic from "./Atomic.js"
import * as Client from "./Client.js"
import * as Document from "./Document.js"
import * as Filter from "./Filter.js"
import { acceptIsAcceptable, contentTypeIsAcceptable } from "./Middleware.js"
import { MEDIA_TYPE } from "./internal/media.js"

describe("Client.isMutatingMethod", () => {
  it("names the methods that carry a request media type", () => {
    expect(Client.isMutatingMethod("POST")).toBe(true)
    expect(Client.isMutatingMethod("PUT")).toBe(true)
    expect(Client.isMutatingMethod("PATCH")).toBe(true)
    // A JSON:API DELETE may carry a body (relationship removal), and a
    // bodyless one still declares what it would send.
    expect(Client.isMutatingMethod("DELETE")).toBe(true)
  })

  it("excludes the safe methods", () => {
    expect(Client.isMutatingMethod("GET")).toBe(false)
    expect(Client.isMutatingMethod("HEAD")).toBe(false)
    expect(Client.isMutatingMethod("OPTIONS")).toBe(false)
  })
})

describe("Client.jsonApiHeaders", () => {
  it("stamps Accept on a read, and nothing else", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.get("/articles"))
    expect(request.headers["accept"]).toBe(MEDIA_TYPE)
    expect(request.headers["content-type"]).toBeUndefined()
  })

  it("stamps both on every mutating method, bodyless DELETE included", () => {
    for (const request of [
      HttpClientRequest.post("/articles"),
      HttpClientRequest.patch("/articles/1"),
      HttpClientRequest.put("/articles/1"),
      HttpClientRequest["delete"]("/articles/1")
    ]) {
      const stamped = Client.jsonApiHeaders(request)
      expect(stamped.headers["accept"]).toBe(MEDIA_TYPE)
      expect(stamped.headers["content-type"]).toBe(MEDIA_TYPE)
    }
  })

  it("leaves the body untouched — only the label changes", () => {
    const request = HttpClientRequest.post("/articles").pipe(
      HttpClientRequest.bodyJsonUnsafe({ data: { type: "articles" } })
    )
    const stamped = Client.jsonApiHeaders(request)
    expect(stamped.body).toBe(request.body)
  })

  it("carries ext and profile parameters on both headers", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.post("/operations"), {
      extensions: [Atomic.EXTENSION_URI],
      profiles: [Filter.PROFILE_URI]
    })
    const expected = `${MEDIA_TYPE};ext="${Atomic.EXTENSION_URI}";profile="${Filter.PROFILE_URI}"`
    expect(request.headers["accept"]).toBe(expected)
    expect(request.headers["content-type"]).toBe(expected)
  })

  it("replaces the `application/json` a generated client would have sent", () => {
    const request = HttpClientRequest.post("/articles").pipe(
      HttpClientRequest.setHeader("content-type", "application/json"),
      HttpClientRequest.setHeader("accept", "application/json")
    )
    const stamped = Client.jsonApiHeaders(request)
    expect(stamped.headers["accept"]).toBe(MEDIA_TYPE)
    expect(stamped.headers["content-type"]).toBe(MEDIA_TYPE)
  })
})

describe("what the client sends, the server accepts", () => {
  // The seam between #109 and #101: the headers this package emits have to pass
  // this package's own §5 negotiation, or a client built from an api defined
  // with it is rejected by middleware from it.
  const serverOptions = { extensions: [Atomic.EXTENSION_URI] }

  it("negotiates a read", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.get("/articles"))
    expect(acceptIsAcceptable(request.headers["accept"])).toBe(true)
  })

  it("negotiates a write", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.post("/articles"))
    expect(acceptIsAcceptable(request.headers["accept"])).toBe(true)
    expect(contentTypeIsAcceptable(request.headers["content-type"])).toBe(true)
  })

  it("negotiates an atomic request against a server declaring the extension", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.post("/operations"), serverOptions)
    expect(acceptIsAcceptable(request.headers["accept"], serverOptions)).toBe(true)
    expect(contentTypeIsAcceptable(request.headers["content-type"], serverOptions)).toBe(true)
    // …and is refused by one that does not declare it, which is the point of
    // advertising it at all.
    expect(acceptIsAcceptable(request.headers["accept"])).toBe(false)
  })

  it("negotiates a profile, which a server never rejects", () => {
    const request = Client.jsonApiHeaders(HttpClientRequest.get("/articles"), { profiles: [Filter.PROFILE_URI] })
    expect(acceptIsAcceptable(request.headers["accept"])).toBe(true)
  })
})

describe("Client.transform", () => {
  const recorder = () => {
    const seen: Array<HttpClientRequest.HttpClientRequest> = []
    const client = HttpClient.make((request) => {
      seen.push(request)
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 204 })))
    })
    return { client, seen }
  }

  it("applies the headers to every request the client sends", async () => {
    const { client, seen } = recorder()
    await Effect.runPromise(Client.transform(client).execute(HttpClientRequest.post("https://example.com/articles")))
    await Effect.runPromise(Client.transform(client).execute(HttpClientRequest.get("https://example.com/articles")))

    expect(seen[0]?.headers["content-type"]).toBe(MEDIA_TYPE)
    expect(seen[0]?.headers["accept"]).toBe(MEDIA_TYPE)
    expect(seen[1]?.headers["accept"]).toBe(MEDIA_TYPE)
    expect(seen[1]?.headers["content-type"]).toBeUndefined()
  })

  it("carries the negotiation options through", async () => {
    const { client, seen } = recorder()
    await Effect.runPromise(
      Client.transform(client, { extensions: [Atomic.EXTENSION_URI] }).execute(
        HttpClientRequest.post("https://example.com/operations")
      )
    )
    expect(seen[0]?.headers["accept"]).toBe(`${MEDIA_TYPE};ext="${Atomic.EXTENSION_URI}"`)
  })

  it("lets a transform applied after it override a header, and not the reverse", async () => {
    // The composition order `Client.make` depends on: `mapRequest` appends, so
    // the last client wrapped is the last to run.
    const { client, seen } = recorder()
    const overriding = HttpClient.mapRequest(Client.transform(client), (request) =>
      HttpClientRequest.setHeader(request, "accept", "application/json")
    )

    await Effect.runPromise(overriding.execute(HttpClientRequest.get("https://example.com/articles")))
    expect(seen[0]?.headers["accept"]).toBe("application/json")
  })
})

describe("Document.decodeErrorDocument", () => {
  it("decodes a conformant error document", () => {
    const decoded = Document.decodeErrorDocument({
      errors: [{ status: "404", code: "not_found", title: "Not Found", detail: "No article with id 1" }]
    })
    expect(Option.isSome(decoded)).toBe(true)
    expect(Option.getOrThrow(decoded).errors[0]?.detail).toBe("No article with id 1")
  })

  it("keeps source, links and meta", () => {
    const decoded = Document.decodeErrorDocument({
      errors: [{ status: "400", source: { parameter: "filter[age][gt]" } }],
      meta: { requestId: "r1" }
    })
    expect(Option.getOrThrow(decoded).errors[0]?.source).toEqual({ parameter: "filter[age][gt]" })
    expect(Option.getOrThrow(decoded).meta).toEqual({ requestId: "r1" })
  })

  it("is None for everything that is not one, and never throws", () => {
    // The degradation cases the error path depends on: a proxy's HTML, an
    // opaque 5xx, a truncated body, a success document.
    for (const body of [
      undefined,
      null,
      "",
      "<html>502 Bad Gateway</html>",
      0,
      [],
      {},
      { errors: [] }, // errors must be non-empty
      { data: { type: "articles", id: "1" } },
      { errors: "nope" },
      { errors: [{ status: 404 }] } // status is a string on the wire
    ]) {
      expect(Option.isNone(Document.decodeErrorDocument(body))).toBe(true)
    }
  })
})

describe("Document.errorMessage", () => {
  it("prefers the occurrence-specific detail", () => {
    expect(Document.errorMessage({ errors: [{ title: "Not Found", detail: "No article with id 1" }] })).toBe(
      "No article with id 1"
    )
  })

  it("falls back to the title, then to a generic message", () => {
    expect(Document.errorMessage({ errors: [{ title: "Not Found" }] })).toBe("Not Found")
    expect(Document.errorMessage({ errors: [{ status: "500" }] })).toBe("Request could not be completed")
  })

  it("reads the first error", () => {
    expect(Document.errorMessage({ errors: [{ detail: "first" }, { detail: "second" }] })).toBe("first")
  })
})

describe("Client.errorDocument", () => {
  const withResponse = (json: Effect.Effect<unknown, unknown>) => ({ response: { json } })

  it("recovers the document a failed call carries", async () => {
    const cause = withResponse(Effect.succeed({ errors: [{ status: "409", detail: "Title taken" }] }))
    const document = await Effect.runPromise(Client.errorDocument(cause))
    expect(Option.map(document, Document.errorMessage)).toEqual(Option.some("Title taken"))
  })

  it("is None for a cause with no response at all", async () => {
    for (const cause of [new Error("network down"), undefined, null, "boom", {}]) {
      expect(await Effect.runPromise(Client.errorDocument(cause))).toEqual(Option.none())
    }
  })

  it("is None when reading the body fails, rather than failing itself", async () => {
    // A truncated body, a transport fault mid-read: the error path must not
    // throw its own error over the one it is reporting.
    const cause = withResponse(Effect.fail(new Error("unexpected end of JSON input")))
    expect(await Effect.runPromise(Client.errorDocument(cause))).toEqual(Option.none())
  })

  it("is None when the body is not an error document", async () => {
    const cause = withResponse(Effect.succeed("<html>502 Bad Gateway</html>"))
    expect(await Effect.runPromise(Client.errorDocument(cause))).toEqual(Option.none())
  })
})

describe("Client.narrowIncluded", () => {
  it("is still an identity at runtime", () => {
    const Article = { type: "articles" } as never
    const document = { included: [{ type: "people", id: "9" }] }
    expect(Client.narrowIncluded(Article, [] as never, document)).toBe(document)
  })
})
