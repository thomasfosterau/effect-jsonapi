---
"@thomasfosterau/effect-jsonapi": patch
---

**Fix: an `Accept` q-weight was treated as a media type parameter, so
`Accept: application/vnd.api+json;q=0.9` got a spurious 406.**
`Middleware.acceptIsAcceptable` parsed each `Accept` entry and ran every parameter it found through
the `ext` / `profile` check, rejecting anything else — including `q`.

Per RFC 9110 §12.4.2 `q` is not a media type parameter: it is the _weight_ of an `Accept` entry, and
it terminates the media type's own parameter list. Everything before `q` belongs to the
representation; `q` and everything after it are accept-extensions belonging to the header field.
JSON:API §5 constrains the _media type_'s parameters, so a weight must never be counted against it.

The case that bit hardest was `Accept: text/html;q=0.9, application/vnd.api+json;q=0.8` — any client
expressing a preference between HTML and JSON:API on a shared origin — which 406'd from an API that
does in fact serve JSON:API. Now:

- a weighted JSON:API instance is acceptable, weight and real media type parameters together
  (`…;profile="…";q=0.8`) included;
- `q=0` is an explicit refusal of that representation rather than a bad parameter, so it still fails,
  and is a genuine 406 when it is the only JSON:API instance;
- a genuine bad parameter still fails, weight notwithstanding (`…;charset=utf-8;q=0.8`);
- a malformed weight reads as 1 rather than becoming a 406.

New: `Middleware.acceptWeight(header, options?)` returns the resolved weight — the `q` of the best
acceptable JSON:API instance, or of a `*/*` / `application/*` range when none is named, or
`undefined` when the client will not take JSON:API at all. A host serving more than one
representation on a URL uses it to choose between them rather than only to accept, which is what
`acceptIsAcceptable` could not express.

`Content-Type` is deliberately unchanged: it is a bare media type with no accept-extension grammar,
so a `q` there really is a media type parameter that is neither `ext` nor `profile`, and §5 requires
the 415.
