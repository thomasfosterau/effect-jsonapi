# Idempotency profile

Design note and normative definition for the `Idempotency-Key` profile. Tracks [#123](https://github.com/thomasfosterau/effect-jsonapi/issues/123) (epic [#115](https://github.com/thomasfosterau/effect-jsonapi/issues/115)).

Unlike the filter grammar, this note defines its own semantics end to end. A profile exists to be interoperable, so a third-party implementer must be able to build a conforming server from this document alone; nothing here defers to another repository.

**Status:** implemented in `src/Idempotency.ts` as of 0.15.0. The profile URI is `https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1` and is a version of this document. `v1` is this note; an incompatible change — a new outcome, a changed fingerprint rule — is `v2`.

## 0. Does this belong here?

The issue asked the scope question first, and epic #115's rule is that a change here is justified on JSON:API's own terms or not at all. [#119](https://github.com/thomasfosterau/effect-jsonapi/issues/119) was closed for failing that test: it proposed a grammar change driven solely by one downstream consumer's authorization requirement. **The answer here is yes**, for four reasons:

1. **The problem is JSON:API's own.** A `POST /<type>` whose response is lost leaves every JSON:API client — not one consumer, every one — unable to distinguish "it didn't happen" from "it happened and I didn't hear". The spec creates this situation and does not resolve it.
2. **The spec gestures at it and stops short.** JSON:API v1.1 lets a server accept a [client-generated ID](https://jsonapi.org/format/1.1/#crud-creating-client-ids), which exists precisely because clients need to control the identity of what they create. But an identity is not an idempotency record: a retry carrying the same client-generated `id` is a `409 Conflict` ("the resource already exists"), which is still not a success the client can act on. The mechanism names the problem without solving it.
3. **`lid` is a different mechanism entirely.** A local id correlates resources _within one request_ — a creation payload, or across the operations of an atomic request, where later operations reference earlier ones. It is scoped to the request it appears in; `Lid.make()` is per-request server-side state. Two requests carrying the same `lid` are two unrelated creations. "Which resources in this request refer to each other" and "did this request already run" are different questions.
4. **The spec supplies the extension point.** [Profiles](https://jsonapi.org/format/1.1/#profiles) are the sanctioned way to agree on semantics the base spec does not define, negotiated in the `profile` media type parameter and advertised in the top-level `jsonapi.profile` member. This package already ships one, for the filter grammar.

What this package adds is a **contract and a seam**, not behaviour. An api that does not opt in is byte-for-byte unchanged.

## 1. What the profile is, and is not

It is a **profile**, not an `ext`: it defines no new document members, changes no base-spec processing, and a server that ignores it is still a conforming JSON:API server. Everything it adds lives in HTTP headers, which JSON:API does not restrict, plus two error documents in the spec's own shape.

Being a profile also bounds the claim honestly: the spec's profile mechanism governs _document_ semantics (`meta` members, query parameters) and says nothing about request headers. So the profile URI is not "permission" to define a header — it is how a client **discovers and names** the convention this server honours. The header itself is orthogonal to JSON:API.

A server advertises the profile in the top-level `jsonapi` member (`Idempotency.jsonapi`):

```json
{
  "jsonapi": {
    "version": "1.1",
    "profile": ["https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1"]
  }
}
```

and MAY also name it on the response media type:

```
Content-Type: application/vnd.api+json; profile="https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1"
```

Per JSON:API §5, a profile a server does not support is **ignored, never rejected** — the existing negotiation middleware already does this (`src/Middleware.ts`). Nothing about request handling keys off a client naming the profile: an endpoint declared with `idempotency: true` honours a key whether or not the client negotiated.

## 2. The header

```
Idempotency-Key: 8e03978e-40d5-43e8-bc93-6894a57f9324
```

- The **name** is the IETF draft's ([draft-ietf-httpapi-idempotency-key-header](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/)). A draft is a convention, not a standard; it is adopted here because it is what deployed clients, proxies and SDKs already send.
- The **value** is a non-empty string of at most 255 printable US-ASCII characters (`0x20`–`0x7E`). The draft specifies an RFC 8941 Structured Field Item whose value is a String, which is spelled quoted (`"8e03978e-…"`, with `\` and `"` escaped). Deployed servers overwhelmingly send a bare token. **This package accepts both spellings and treats them as the same key**, and emits the bare form. The 255-character bound is ours.
- A key identifies **one logical write**, and the client reuses it across that write's retries. A key generated per HTTP request provides nothing.
- The header is **optional by default**: a write without one is processed normally and recorded nowhere. An endpoint declared `idempotency: "required"` rejects a keyless write with the package's standard `400` naming `source: { header: "idempotency-key" }` — the draft's "400 for a missing key", reusing the machinery every other missing required input already goes through rather than inventing a second one.

## 3. The request fingerprint

A key alone is not enough: the server must be able to tell a _retry_ of a write from a _different_ write sent under the same key. That is the fingerprint, and it is normative because two implementations that fingerprint differently will disagree about which requests are the same.

The fingerprint is the SHA-256, hex-encoded, of this canonical string:

```
<METHOD>\n<path>\n<query>\n<body>
```

- `<METHOD>` uppercased.
- `<path>` the request target's path, with the query removed.
- `<query>` the query string's `&`-separated pairs, **sorted** (code-point order), joined with `&`, exactly as received otherwise (no re-encoding). Empty when there is no query.
- `<body>` — if the body parses as JSON, its re-serialisation with **every object's keys sorted** (arrays keep their order); otherwise the body exactly as received. Empty for a bodyless request.

Sorting keys and dropping insignificant whitespace is what makes the rule usable: a client that re-encodes the same document on retry — a different key order, a different serialiser — has sent the _same_ write, and a fingerprint over raw bytes would call it a conflict. A changed value is still a changed request.

`Idempotency.canonical` and `Idempotency.fingerprint` are exported so an implementer can check agreement directly.

## 4. Key scope

Two rules, one owned here and one owned by the application:

- **The request target is part of the fingerprint.** So a key seen on a different method or path is a _mismatch_, not a second, independent slot. A key names one write, not one write per endpoint.
- **Anything narrower is the store's.** Whether keys are global, per principal or per tenant is not something this package can know, and it does not guess: `Store` receives the whole `HttpServerRequest` alongside the key, and an application that scopes per principal derives that scope from the request (its `Authorization` header, a session cookie, a path segment) inside its own store. A store that scopes per principal and one that does not are both conforming; a server SHOULD document which it is.

## 5. Outcomes

For a write carrying a key, exactly one of these:

| Situation | Response |
| --- | --- |
| Key unseen | The write runs. Its response is recorded and returned. |
| Key recorded, **same** fingerprint | The recorded response, **verbatim** — same status, headers and body — plus `Idempotency-Replayed: true`. |
| Key recorded or in flight, **different** fingerprint | `422 Unprocessable Content`, `code: "idempotency_key_mismatch"`. |
| Key in flight, same fingerprint | `409 Conflict`, `code: "idempotency_key_in_progress"`. |
| Key required, absent | `400 Bad Request`, `source: { header: "idempotency-key" }`. |

The statuses are the draft's (422 is a MUST there, 409 and 400 are SHOULDs). The bodies are JSON:API error documents, which is this package's to own; both carry `source: { header: "idempotency-key" }`, spec-native because v1.1 added `header` to an error's `source`.

### 5.1 Why the replay is verbatim

The draft says the server "SHOULD respond with the result of the previously completed operation". This package makes that exact: the original status, headers and body. Not a distinguishable success — a `200` where the first answered `201`, say — because the client's decoder is typed against the endpoint's _declared_ status and document, and a replay that answered differently would break the generated client and every JSON:API client that expects `201 + Location` from a creation. The whole point is that a retry is indistinguishable to application code. `Idempotency-Replayed: true` is this package's own addition (the draft defines no such header) so that operators and transports can still tell, out of band.

### 5.2 Why a mismatch is not a replay

This is the case naive implementations get wrong: they key on the key alone and replay the first response for whatever arrives second. That silently discards the second write and hands the client an answer to a question it did not ask. A key names one write; the same key on a different write is a client bug and must be an error.

The mismatch is checked **before** the in-flight conflict: a client that reused a key for a different write has a bug whether or not the first attempt has finished.

### 5.3 Why the in-flight case is an error, not a wait

Holding the connection until the original finishes would need coordination the store cannot be assumed to provide, and it fails worst under exactly the conditions this profile exists for — a client that already lost one response now blocks on a second. `409` with no correction required is the draft's answer and this package's: retry after a delay and get either the recorded response or a fresh attempt.

### 5.4 Which responses are recorded

A **response** below `500` is recorded: the success, and the rejections rendered before the handler runs (a malformed payload's `400`, a negotiation `415`). That a rejection is recorded is deliberate: a client that corrects such a request has changed it, and must use a new key.

Everything else releases the key, so it can be attempted again:

- a `5xx` — a server fault is not an outcome to freeze, and the client may safely retry the same key;
- a defect or an interruption — there is no response to record;
- a **handler failure** — a declared `ApiError` is encoded into a response downstream of this middleware, so it is not a completed write. A handler that has already performed a side effect must therefore answer with a _response_ rather than fail, for the key to cover it;
- a response whose body cannot be reproduced byte for byte — a stream, a multipart form. Everything the package's own endpoints emit can be.

## 6. Retention

This package holds nothing and so specifies no retention; what it specifies is the contract:

- A store SHOULD retain a completed record for **at least 24 hours**, and a server SHOULD publish its retention window (the draft requires a published expiration policy).
- Once a record is evicted the key is unknown again, and a retry after that runs as a fresh write. Retention is therefore the bound on how late a retry can still be deduplicated, and shortening it weakens the guarantee rather than changing it.
- `claim` **MUST be atomic**: of any number of concurrent attempts on one key, exactly one gets `Claimed`. A unique insert is enough. Without this the profile's guarantee does not hold, and this is the one requirement an implementer can get wrong silently.
- A store that cannot answer MUST fail rather than let the write through: the request then `500`s, is recorded nowhere, and the client may retry the same key. Processing a write whose idempotency cannot be guaranteed is the one outcome the profile must never produce.

## 7. Atomic operations

**A key covers the whole request, never an individual operation.** Stated here rather than assumed, because the alternative is superficially plausible.

The [atomic operations extension](https://jsonapi.org/ext/atomic/) already makes the request the unit: its operations "MUST be processed as a single transaction" — all succeed or none are applied — and the response is one `atomic:results` document whose members correspond positionally to the operations. A per-operation key would imply per-operation commit boundaries, which contradicts the extension's own atomicity; and there is no per-operation response to replay, only the document as a whole.

So: one `Idempotency-Key` on `POST /operations`, fingerprinted over the whole `atomic:operations` array, replaying the whole `atomic:results` document.

This also settles the `lid` relationship from §0.3 in the direction that matters. Because the replay is the whole recorded document, a replayed request's `lid`s resolve to the same server-assigned ids they resolved to the first time — which is precisely what a hand-rolled, `lid`-based deduplication scheme cannot give you, since its `lid`s mean nothing outside the request that carried them.

## 8. What this package owns, and what the application owns

| This package | The application |
| --- | --- |
| The header, its syntax, and its declaration on write endpoints | Whether a given endpoint opts in |
| The fingerprint rule (§3) | Any narrower key scope — per principal, per tenant (§4) |
| Every outcome in §5, and the two error documents | Storage: the table, the transaction, the eviction |
| The atomicity requirement on `claim` | Meeting it |
| The profile URI and this document | Publishing its retention window |

The seam is `Idempotency.Store` — three effects, `claim` / `complete` / `release` — supplied to `Idempotency.layer(store)`. It is the same division `Lid.make()` draws: the package defines the mechanism and the handler supplies what only it can know. `Idempotency.memoryStore()` is a reference implementation of the contract for tests and single-process development; it is per-process and never evicts, so it is not a production store.

Opting an endpoint in attaches `Idempotency.Middleware`, which is a service. An `HttpApi` carrying an idempotent endpoint therefore does not type-check until the store layer is provided: the seam cannot be declared and then forgotten.

## 9. Spec, convention, ours

The split the issue asked to be documented:

|  | Source |
| --- | --- |
| The profile mechanism, `jsonapi.profile`, the `profile` media type parameter, "ignore unknown profiles" | **JSON:API v1.1** |
| The error document shape, and `source.header` on an error object | **JSON:API v1.1** |
| The atomic extension's all-or-nothing request and `atomic:results` | **JSON:API atomic operations extension** |
| The header name `Idempotency-Key`; `422` for reuse with a different payload, `409` in flight, `400` missing; "respond with the result of the previously completed operation" | **IETF draft** (convention, not a standard) |
| Accepting both the quoted and bare spellings; the 255-character bound | **This package** |
| The fingerprint rule (§3) | **This package** |
| The request target as part of the key's identity (§4) | **This package** |
| Verbatim replay, and `Idempotency-Replayed` | **This package** |
| Mismatch checked before in-flight (§5.2) | **This package** |
| Which responses are recorded vs released (§5.4) | **This package** |
| One key per atomic request (§7) | **This package** |
| The `Store` contract, including `claim`'s atomicity | **This package** |

JSON:API v1.1 specifies no idempotency mechanism. Everything in the last ten rows is a choice, made here so that two servers speaking this profile URI agree.
