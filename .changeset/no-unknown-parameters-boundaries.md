---
"@thomasfosterau/effect-jsonapi": major
---

The two published functions that took an `unknown` parameter now have signatures that satisfy `effect/no-unknown-parameters` (#436), and the lint rule is back at `error`:

- **`Client.decodeErrorDocument(body: unknown)` becomes `Client.decodeErrorDocument(body: string | Schema.Json | Client.ErrorDocument)`.** It takes the raw body text, an already-parsed JSON value, or the `ErrorDocument` a façade already holds (what `ApiError.toDocument` renders). Its behaviour is unchanged: anything that is not a conformant error document, including a value outside the declared type, is still `Option.none()` and never a throw.
- **`ServerErrors.fromTaggedError: (error: unknown) => …` becomes `(cause: unknown) => …`.** Only the parameter's name changes, to the one the rule reserves for an error cause, which is what the function classifies. Its type and behaviour are unchanged, and no call site needs a change.

**Migration.** Calls to `decodeErrorDocument` compile as before when they pass a string, a `JSON.parse` result (`any`), a value typed `Schema.Json` (which is what an `HttpClientResponse`'s `json` gives), or `ApiError.toDocument(…)`. A call that passes a value typed `unknown`, such as a body read back from storage, no longer compiles. Pass its text instead, or decode it first, for example with `Schema.decodeUnknownOption(Schema.Json)`. Nothing changes at runtime, so a value outside the declared type is still safe to pass from JavaScript.
