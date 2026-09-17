---
"@thomasfosterau/effect-jsonapi": minor
---

**Tracing: `Effect.withSpan` on content negotiation and request-validation failures (#122).**
A traced request used to go dark exactly where this package does its work. The two places `src/`
actually runs an `Effect` per request — JSON:API §5 content negotiation and the translation of a
request-validation failure into a JSON:API 400 document — now wrap that work in a span, under
stable names collected in `Middleware.Span`:

```ts
import { Middleware } from "@thomasfosterau/effect-jsonapi"

Middleware.Span.negotiate // "effect-jsonapi.negotiate"
Middleware.Span.schemaError // "effect-jsonapi.schema_error"
```

- `Span.negotiate` — one span per request, tagged `jsonapi.negotiation.outcome` (`"accepted"` /
  `"rejected"`) and, only when rejected, `jsonapi.negotiation.rule` (`"content_type"` / `"accept"`).
- `Span.schemaError` — one span per request-validation failure, tagged `jsonapi.request_part` with
  the `Middleware.RequestPart` that failed (`"Params"`, `"Headers"`, `"Query"`, `"Body"`,
  `"Payload"`).

Both are attached automatically by `ContentNegotiationLive` and `SchemaErrorsLive` — no new layer or
configuration is needed, and `Effect.withSpan` is a no-op when no `Tracer` is in context, so a host
with no tracing set up sees no behavior or performance change. Every attribute value is one of a
small fixed set of strings; none of them is a header value, a filter literal, a query string, or
anything else that varies per request or could identify a user.

The rest of the package — query/filter/sort decoding, document assembly, atomic-operation
processing — has no `Effect` of its own to attach a span to today (decoding and encoding run inside
`HttpApi`'s own schema machinery; the document builders in `Handlers.ts` are synchronous helpers).
Instrumenting those meaningfully needs an API change beyond this issue's scope; see the discussion on
#122 for the proposed follow-up.
