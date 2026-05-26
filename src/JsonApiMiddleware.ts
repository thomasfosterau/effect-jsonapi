// Content-negotiation middleware for JSON:API endpoints.
//
// Enforces the wire rules JSON:API requires:
//   - `Content-Type` must be exactly `application/vnd.api+json` with no
//     media-type parameters → fail with `UnsupportedMediaType` (415).
//   - `Accept`, when present, must accept unparameterized
//     `application/vnd.api+json` (or `*/*`) → fail with `NotAcceptable` (406).
//
// The error schemas (`NotAcceptable`, `UnsupportedMediaType`) already live in
// `JsonApiHttp.ts` and are declared on every endpoint via `StandardErrors`,
// so this middleware just produces those tagged-error values from the request.
import { Effect, Layer } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest"
import { JSONAPI_MEDIA_TYPE, NotAcceptable, UnsupportedMediaType } from "./JsonApiHttp.js"

const stripWeight = (value: string): string => {
  const semi = value.indexOf(";")
  return (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase()
}

// JSON:API §5: the server MUST respond with 415 if `Content-Type` is the
// JSON:API media type *and* carries any media-type parameters.
export const contentTypeIsAcceptable = (header: string | undefined): boolean => {
  if (header === undefined) return true
  const trimmed = header.trim().toLowerCase()
  const semi = trimmed.indexOf(";")
  if (semi === -1) return true
  const base = trimmed.slice(0, semi).trim()
  // Only the JSON:API media type is policed; other content types are left to
  // the downstream payload decoder, which will produce its own 415.
  return base !== JSONAPI_MEDIA_TYPE
}

// JSON:API §5: the server MUST respond with 406 if every instance of the
// JSON:API media type in `Accept` carries media-type parameters. An `Accept`
// containing `*/*` or `application/*` always satisfies the rule.
export const acceptIsAcceptable = (header: string | undefined): boolean => {
  if (header === undefined) return true
  const entries = header.split(",").map((entry) => entry.trim().toLowerCase())
  for (const entry of entries) {
    if (entry === "") continue
    if (entry === "*/*" || entry.startsWith("*/*;")) return true
    if (entry === "application/*" || entry.startsWith("application/*;")) return true
    const base = stripWeight(entry)
    if (base === JSONAPI_MEDIA_TYPE && entry === base) {
      // Unparameterised match: accepted.
      return true
    }
  }
  return false
}

export class JsonApiContentNegotiation extends HttpApiMiddleware.Service<JsonApiContentNegotiation>()(
  "JsonApi/ContentNegotiation",
  { error: [NotAcceptable, UnsupportedMediaType] as const }
) {}

export const JsonApiContentNegotiationLive = Layer.effect(
  JsonApiContentNegotiation,
  Effect.succeed<typeof JsonApiContentNegotiation.Service>((httpEffect) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest
      if (!contentTypeIsAcceptable(req.headers["content-type"])) {
        return yield* Effect.fail(new UnsupportedMediaType())
      }
      if (!acceptIsAcceptable(req.headers["accept"])) {
        return yield* Effect.fail(new NotAcceptable())
      }
      return yield* httpEffect
    })
  )
)
