---
"@thomasfosterau/effect-jsonapi": patch
---

`Conformance` now follows a redirect when, and only when, its `Location` stays on the base URL's origin (scheme, host and port), in both transports. Previously every `3xx` answered a probe as itself. The kit checks each hop before requesting it, so it never sends a request to another origin on a server's say-so. It follows at most five hops for one request, each counting against a rule's request budget, and grades the final answer. A `301`, `302` or `303` is followed only for a `GET` or `HEAD`; a `307` or `308` re-sends the same method and body.

A redirect the kit does not follow leaves the request with no answer to read: one to another origin, past the hop cap or the budget, one that would turn a write into a `GET`, or one whose `Location` does not parse. An `http` → `https` redirect on the same host counts as another origin. A link it leads to is not decided, and the note names the `Location`. Any other rule drops a finding such a request produced, so it never reports a probe that went unanswered as "not rejected". It then passes on the answers it did read, noting the rest, or skips when it read none. `spec/target/reachable` reports such a redirect once instead, as one finding telling the caller to point `baseUrl` at the URL that serves.

`spec/links/related-dereferences` now requires each resource object in the answer to carry a string `type`, so `{"data":"x"}`, `{"data":["x"]}` and `{"data":[{"id":"1"}]}` are findings. The link rules' budget skip no longer counts a read endpoint whose URL does not resolve as searched. A write rule that could not read the create's answer now names it, rather than a bare `0`.

`Conformance.verifyWith` keeps the transport from following redirects by providing `FetchHttpClient.RequestInit` with `redirect: "manual"` over the run's own `RequestInit`, so a run's `redirect: "follow"` cannot undo it. A `RequestInit` given only to the client's layer (`FetchHttpClient.layer.pipe(Layer.provide(…))`) is replaced for the kit's requests; give it to the run instead.
