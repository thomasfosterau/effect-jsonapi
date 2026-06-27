---
"@thomasfosterau/effect-jsonapi": minor
---

Decode JSON:API URI members to real `URL`s instead of plain strings.

A new `Document.Url` schema decodes an **absolute** URI-reference to a WHATWG
`URL` and leaves a **relative** reference (which the spec permits, and which the
server-side `Handlers` helpers emit) as a `string` — its decoded type is
`URL | string`. Both forms encode back to the original string, so the wire
format is unchanged and relative links keep working.

`Document.Url` is now used wherever the spec calls for a URI:

- link targets — `Document.Link` and `LinkObject.href` (so `self` / `related` /
  pagination links across `TopLevelLinks`, `ResourceLinks`, `RelationshipLinks`
  and the error object's `about` / `type` links);
- `LinkObject.describedby`;
- the top-level `jsonapi` object's `ext` and `profile` URI arrays.
