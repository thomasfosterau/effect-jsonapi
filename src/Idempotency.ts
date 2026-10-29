/**
 * Idempotent writes — the `Idempotency-Key` profile.
 *
 * A `POST /<type>` creates a resource. If its response is lost — a dropped
 * connection, a timeout, a service worker replaying a queued write — the
 * client cannot tell "it didn't happen" from "it happened and I didn't hear".
 * Retrying duplicates the resource; not retrying loses the write. `lid` does
 * not help: a local id correlates resources *within* one request (JSON:API
 * v1.1's creation payloads and the atomic extension's operations), and
 * `Lid.make()` is explicitly per-request state — two requests carrying the
 * same `lid` are two unrelated creations. Whether *this request already ran*
 * is a different question, and nothing in the spec answers it.
 *
 * This module answers it as a JSON:API **profile** ({@link PROFILE_URI}): the
 * client sends an `Idempotency-Key` request header, the server records the
 * response it produced under that key, and a retry carrying the same key gets
 * the recorded response back verbatim instead of running again.
 *
 * **What is spec, what is convention, what is ours.** JSON:API v1.1 defines
 * no idempotency mechanism; what it does define is the profile mechanism used
 * to introduce one, the error-document shape the failures answer with, and the
 * `jsonapi.profile` member a server advertises it in. The header name and the
 * three failure statuses are the convention of the IETF draft
 * {@link https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/ `Idempotency-Key`}
 * — a draft, not a standard. Everything the draft leaves to "the resource
 * owner" is this package's choice, fixed in `docs/idempotency.md`: what a key
 * covers, how a request is fingerprinted, which responses are recorded, and
 * what the atomic extension does with a key.
 *
 * **This package stores nothing.** It owns the contract — the header, the
 * fingerprint, the replay, the conflict — and the application owns the
 * storage, through the {@link Store} seam, exactly as `Lid.make()` leaves id
 * assignment to the handler. {@link memoryStore} is a reference
 * implementation for tests and single-process development.
 *
 * ```ts skip-type-checking
 * // Declare the header on the writes that honour it, and the middleware
 * // comes with it — the api cannot be built without a store.
 * const articles = Group.make(
 *   Article,
 *   Endpoint.create(Article, { idempotency: true }),
 *   Endpoint.update(Article, { idempotency: true })
 * )
 *
 * // Provide the seam.
 * const ApiLive = Layer.mergeAll(ArticlesLive).pipe(
 *   Layer.provideMerge(Middleware.layer),
 *   Layer.provideMerge(Idempotency.layer(store))
 * )
 * ```
 *
 * @see `docs/idempotency.md` for the profile's normative semantics.
 * @since 0.15.0
 */
import {
  Array as Arr,
  Effect,
  Layer,
  Option,
  Order,
  Predicate,
  Schema,
  SchemaTransformation,
} from "effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import type * as ServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import type { HttpApiEndpoint } from "effect/http-api";
import { HttpApiMiddleware } from "effect/http-api";
import { make as makeApiError } from "./ApiError.js";
import type { JsonApiObject } from "./Document.js";
import { MEDIA_TYPE } from "./internal/media.js";
import { bodyText } from "./internal/responseBody.js";

// ---------------------------------------------------------------------------
// Profile constants
// ---------------------------------------------------------------------------

/**
 * The idempotency profile URI:
 * `"https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1"`.
 *
 * A JSON:API **profile**, not an `ext`: it adds no document members and
 * changes no base-spec semantics, it only fixes how a server interprets a
 * request header. Servers advertise it in the top-level `jsonapi` member (see
 * {@link jsonapi}) and may also name it in the response `Content-Type`'s
 * `profile` parameter. Per JSON:API §5, a profile a server does not know is
 * ignored, never rejected — so nothing about request handling keys off a
 * client naming it.
 *
 * `v1` is `docs/idempotency.md`; an incompatible change is `v2`.
 *
 * @example
 * ```ts
 * import { Idempotency, MEDIA_TYPE } from "@thomasfosterau/effect-jsonapi"
 *
 * const contentType = `${MEDIA_TYPE}; profile="${Idempotency.PROFILE_URI}"`
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const PROFILE_URI =
  "https://thomasfosterau.github.io/effect-jsonapi/profiles/idempotency/v1";

/**
 * The request header carrying the key: `"idempotency-key"` (header names are
 * case-insensitive; `HttpApi` lowercases them).
 *
 * The name is the IETF draft's, not JSON:API's — the spec defines no header
 * here and does not restrict the ones a server reads.
 *
 * @example
 * ```ts
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * Idempotency.HEADER // "idempotency-key"
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const HEADER = "idempotency-key";

/**
 * The response header marking a replay: `"idempotency-replayed"`, set to
 * `"true"` on a response served from the store rather than produced by the
 * handler.
 *
 * This package's choice, not the draft's: the replayed *body and status* are
 * the original ones byte for byte (see {@link layer}), so application code
 * cannot — and should not — tell a replay apart. Operators and transports
 * can, out of band, here.
 *
 * @example
 * ```ts
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const wasReplayed = (headers: Record<string, string>) => headers[Idempotency.REPLAY_HEADER] === "true"
 *
 * wasReplayed({ "idempotency-replayed": "true" }) // true
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const REPLAY_HEADER = "idempotency-replayed";

/**
 * A ready-made top-level `jsonapi` member value advertising support for the
 * idempotency profile — the spec-native way for a client to discover that a
 * server honours it.
 *
 * @example
 * ```ts
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const document = {
 *   jsonapi: Idempotency.jsonapi,
 *   data: { type: "articles", id: "1", attributes: { title: "Hello" } }
 * }
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const jsonapi: typeof JsonApiObject.Type = { version: "1.1", profile: [PROFILE_URI] };

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

// RFC 8941 spells a Structured Field String quoted, with `\` and `"` escaped.
// Deployed servers overwhelmingly send a bare token (a UUID), so both forms
// are accepted and the bare one is emitted — see `docs/idempotency.md` §2.
const unquote = (value: string): string =>
  value.length >= 2 && value.startsWith(`"`) && value.endsWith(`"`)
    ? value.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : value;

/**
 * The `Idempotency-Key` header value: a non-empty string of at most 255
 * printable US-ASCII characters, optionally enclosed in double quotes (RFC
 * 8941's String form, which the draft mandates). Decoding unquotes, so both
 * spellings denote the same key; encoding emits the bare form.
 *
 * A key must identify one logical write and be reused across its retries —
 * generate it once (a UUID) where the operation is first attempted, not per
 * HTTP request.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const decode = Schema.decodeUnknownSync(Idempotency.Key)
 *
 * decode("8e03978e-40d5-43e8-bc93-6894a57f9324") // bare
 * decode(`"8e03978e-40d5-43e8-bc93-6894a57f9324"`) // the RFC 8941 String form
 * ```
 *
 * @since 0.15.0
 * @category schemas
 */
export interface Key extends Schema.decodeTo<Schema.String, Schema.String, never, never> {}

/**
 * The `Idempotency-Key` header value schema. See {@link Key}.
 *
 * @since 0.15.0
 * @category schemas
 */
export const Key: Key = Schema.String.pipe(
  Schema.decodeTo(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(255),
      Schema.isPattern(/^[\x20-\x7E]+$/, { title: "printable US-ASCII" }),
    ),
    SchemaTransformation.transform<string, string>({ decode: unquote, encode: (key) => key }),
  ),
) as Key;

/**
 * The schema type of {@link Headers}: the request headers of an endpoint that
 * *accepts* a key.
 *
 * Before 0.20.0 this was the type named `Headers`; `Headers` now names the
 * decoded headers, `typeof Headers.Type`.
 *
 * @since 0.20.0
 * @category schemas
 */
export interface HeadersSchema extends Schema.Struct<{
  readonly "idempotency-key": Schema.optionalKey<Key>;
}> {}

/**
 * The request headers of an endpoint that *accepts* a key: `idempotency-key`,
 * optional. A write without one is processed normally and recorded nowhere.
 *
 * @since 0.15.0
 * @category schemas
 */
export const Headers: HeadersSchema = Schema.Struct({
  "idempotency-key": Schema.optionalKey(Key),
});

/**
 * The decoded request headers of an endpoint that accepts a key.
 *
 * @since 0.20.0
 * @category models
 */
export type Headers = typeof Headers.Type;

/**
 * The schema type of {@link HeadersRequired}: the request headers of an
 * endpoint that *requires* a key.
 *
 * Before 0.20.0 this was the type named `HeadersRequired`; `HeadersRequired`
 * now names the decoded headers, `typeof HeadersRequired.Type`.
 *
 * @since 0.20.0
 * @category schemas
 */
export interface HeadersRequiredSchema extends Schema.Struct<{
  readonly "idempotency-key": Key;
}> {}

/**
 * The request headers of an endpoint that *requires* a key. A write without
 * one fails the endpoint's own header decoding, so the client gets the
 * package's standard JSON:API 400 naming `source: { header: "idempotency-key" }`
 * — the draft's "400 for a missing key", with no separate error class.
 *
 * @since 0.15.0
 * @category schemas
 */
export const HeadersRequired: HeadersRequiredSchema = Schema.Struct({ "idempotency-key": Key });

/**
 * The decoded request headers of an endpoint that requires a key.
 *
 * @since 0.20.0
 * @category models
 */
export type HeadersRequired = typeof HeadersRequired.Type;

// ---------------------------------------------------------------------------
// The endpoint option
// ---------------------------------------------------------------------------

/**
 * The `idempotency` option of the write endpoint constructors: `false` (the
 * default — the endpoint knows nothing of keys), `true` (the header is
 * accepted), or `"required"` (a write without a key is a 400).
 *
 * @since 0.15.0
 * @category models
 */
export type Option = boolean | "required";

/**
 * The header schema an {@link Option} declares — none at all when the option
 * is off, so an endpoint that does not opt in keeps exactly the shape it has
 * today. The "off" test is the same one {@link Applied} uses, so the declared
 * header and the attached middleware never disagree.
 *
 * @since 0.15.0
 * @category type-level
 */
export type HeadersFor<O> = [O] extends [false | undefined]
  ? never
  : [O] extends ["required"]
    ? HeadersRequiredSchema
    : HeadersSchema;

/**
 * The endpoint type an {@link Option} produces: the endpoint as declared, plus
 * the {@link Middleware} requirement when the option is on. Opting in is
 * therefore checked by the compiler — an api carrying an idempotent endpoint
 * cannot be built without providing a {@link Store}.
 *
 * @since 0.15.0
 * @category type-level
 */
export type Applied<E, O> = [O] extends [false | undefined]
  ? E
  : E extends HttpApiEndpoint.HttpApiEndpoint<
        infer Id,
        infer Method,
        infer Path,
        infer Params,
        infer Query,
        infer Payload,
        infer Hdrs,
        infer Success,
        infer Err,
        infer Mw,
        infer Services
      >
    ? HttpApiEndpoint.HttpApiEndpoint<
        Id,
        Method,
        Path,
        Params,
        Query,
        Payload,
        Hdrs,
        Success,
        Err,
        Mw | Middleware,
        HttpApiMiddleware.ApplyServices<Middleware, Services>
      >
    : never;

/**
 * The header schema an {@link Option} declares, at runtime.
 *
 * @since 0.15.0
 * @category utils
 * @internal
 */
export const headersFor = (option: Option | undefined): Schema.Top | undefined =>
  option === undefined || option === false
    ? undefined
    : option === "required"
      ? HeadersRequired
      : Headers;

/**
 * Attaches {@link Middleware} to an endpoint when the {@link Option} is on.
 *
 * @since 0.15.0
 * @category utils
 * @internal
 */
export const applied = <E, O extends Option | undefined>(endpoint: E, option: O): Applied<E, O> =>
  (option === undefined || option === false
    ? endpoint
    : (endpoint as { middleware: (key: typeof Middleware) => E }).middleware(
        Middleware,
      )) as Applied<E, O>;

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

// `Array.isArray` does not narrow a readonly JSON array out of its false branch.
const isJsonArray = (value: Schema.Json): value is Schema.JsonArray => Array.isArray(value);

/** Recursively orders object keys so re-serialisation is stable. */
const canonicalValue = (value: Schema.Json): Schema.Json => {
  if (isJsonArray(value)) return value.map(canonicalValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Arr.sort(Object.keys(value), Order.String).map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
};

/**
 * The request a fingerprint is taken over.
 *
 * @since 0.15.0
 * @category models
 */
export interface Fingerprinted {
  /** The HTTP method, e.g. `"POST"`. */
  readonly method: string;
  /** The request target as received — path and query string. */
  readonly url: string;
  /** The raw request body, or `""` for a bodyless request. */
  readonly body: string;
}

/**
 * The canonical string a request is fingerprinted from: its method, path,
 * query parameters sorted by key, and body.
 *
 * A JSON body is re-serialised with object keys ordered, so a retry that
 * re-encodes the same document — a different key order, different whitespace —
 * is the *same* request; a body that is not JSON is taken as received. Two
 * requests with the same canonical string are the same write.
 *
 * @example
 * ```ts
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const a = Idempotency.canonical({
 *   method: "POST",
 *   url: "/articles",
 *   body: `{"data":{"type":"articles","attributes":{"title":"Hello"}}}`
 * })
 * const b = Idempotency.canonical({
 *   method: "POST",
 *   url: "/articles",
 *   body: `{ "data": { "attributes": { "title": "Hello" }, "type": "articles" } }`
 * })
 *
 * a === b // true — the same write, re-encoded
 * ```
 *
 * @since 0.15.0
 * @category utils
 */
export const canonical = (request: Fingerprinted): string => {
  const [path, ...rest] = request.url.split("?");
  const query = rest.join("?");
  const pairs = query === "" ? [] : Arr.sort(query.split("&"), Order.String);
  const body =
    request.body === ""
      ? request.body
      : // Not JSON — compare the bytes as received.
        Option.getOrElse(
          Option.liftThrowable(() => JSON.stringify(canonicalValue(JSON.parse(request.body))))(),
          () => request.body,
        );
  return `${request.method.toUpperCase()}\n${path ?? ""}\n${pairs.join("&")}\n${body}`;
};

const hex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * The fingerprint of a request: the SHA-256 of its {@link canonical} string,
 * hex-encoded.
 *
 * This is what a {@link Store} records beside the response and what a replay
 * is checked against — the same key with a different fingerprint is a client
 * bug, answered with {@link KeyMismatch}. Computed with Web Crypto, available
 * in every runtime this package targets.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const program = Effect.gen(function* () {
 *   const fingerprint = yield* Idempotency.fingerprint({
 *     method: "POST",
 *     url: "/articles",
 *     body: `{"data":{"type":"articles","attributes":{"title":"Hello"}}}`
 *   })
 *   return fingerprint.length // 64 hex characters
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 0.15.0
 * @category utils
 */
export const fingerprint = (request: Fingerprinted): Effect.Effect<string> =>
  Effect.tryPromise(() =>
    globalThis.crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(canonical(request)))
      .then(hex),
  ).pipe(
    // SHA-256 is mandatory in every WebCrypto implementation, so a rejection
    // is a broken runtime, not a failure a caller could recover from.
    Effect.orDie,
  );

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * 422 Unprocessable Content: the key has already been used for a *different*
 * request.
 *
 * The case naive implementations get wrong by replaying the first response
 * anyway. A key names one write; the same key on a different write is a client
 * bug, and answering it with the earlier response would silently drop the
 * second one. The status is the draft's (a MUST), the error document is
 * JSON:API's, and `source: { header: "idempotency-key" }` names what went
 * wrong — spec-native, since JSON:API v1.1 added `header` to an error's
 * `source`.
 *
 * @example
 * ```ts
 * import { ApiError, Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * ApiError.toDocument(new Idempotency.KeyMismatch())
 * // → { errors: [{ status: "422", code: "idempotency_key_mismatch",
 * //                title: "Idempotency-Key Mismatch", detail: "…",
 * //                source: { header: "idempotency-key" } }] }
 * ```
 *
 * @since 0.15.0
 * @category errors
 */
export class KeyMismatch extends makeApiError<KeyMismatch>()("KeyMismatch", {
  status: 422,
  code: "idempotency_key_mismatch",
  title: "Idempotency-Key Mismatch",
  detail:
    "This Idempotency-Key has already been used for a different request. A key identifies one write; use a new key.",
  source: { header: HEADER },
}) {}

/**
 * 409 Conflict: a request carrying this key is still in flight.
 *
 * The retry is not rejected on its merits — the client sent the same write
 * twice and the first has not finished. Retry after a delay: the answer is
 * then either the recorded response or a fresh attempt. The status is the
 * draft's, and the client needs to correct nothing.
 *
 * @example
 * ```ts
 * import { ApiError, Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * ApiError.toDocument(new Idempotency.KeyInProgress())
 * // → { errors: [{ status: "409", code: "idempotency_key_in_progress", … }] }
 * ```
 *
 * @since 0.15.0
 * @category errors
 */
export class KeyInProgress extends makeApiError<KeyInProgress>()("KeyInProgress", {
  status: 409,
  code: "idempotency_key_in_progress",
  title: "Idempotency-Key In Progress",
  detail:
    "A request with this Idempotency-Key is still being processed. Retry after a short delay.",
  source: { header: HEADER },
}) {}

/**
 * The errors an idempotent endpoint can answer with beyond its own:
 * {@link KeyMismatch} (422) and {@link KeyInProgress} (409). Declared by
 * {@link Middleware}, so a generated client has them typed without listing
 * them per endpoint.
 *
 * @example
 * ```ts
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * Idempotency.Errors.map((error) => error.status) // [422, 409]
 * ```
 *
 * @since 0.15.0
 * @category constants
 */
export const Errors = [KeyMismatch, KeyInProgress] as const;

// ---------------------------------------------------------------------------
// The store seam
// ---------------------------------------------------------------------------

/**
 * A response as recorded for replay: everything needed to reproduce it byte
 * for byte.
 *
 * @since 0.15.0
 * @category models
 */
export interface Recorded {
  /** The HTTP status. */
  readonly status: number;
  /** The response headers, lowercased. */
  readonly headers: Record<string, string>;
  /** The response body, as text (`""` for a bodyless response). */
  readonly body: string;
}

/**
 * One attempt at an idempotent write, as handed to a {@link Store}.
 *
 * The whole `request` is here so a store can scope keys however the
 * application needs — per principal, per tenant — which this package cannot
 * know and therefore does not decide. See `docs/idempotency.md` §4.
 *
 * @since 0.15.0
 * @category models
 */
export interface Attempt {
  /** The decoded `Idempotency-Key`. */
  readonly key: string;
  /** The {@link fingerprint} of this request. */
  readonly fingerprint: string;
  /** The request itself — method, url, headers — for scoping. */
  readonly request: ServerRequest.HttpServerRequest;
}

/**
 * What a {@link Store} knows about a key when an attempt claims it: nothing
 * (`Claimed` — this attempt owns it), another attempt is running
 * (`InProgress`), or a response was recorded (`Completed`).
 *
 * The fingerprint travels with the last two so the *package* decides the
 * mismatch case rather than each store re-deciding it.
 *
 * @since 0.15.0
 * @category models
 */
export type Claim =
  | { readonly _tag: "Claimed" }
  | { readonly _tag: "InProgress"; readonly fingerprint: string }
  | { readonly _tag: "Completed"; readonly fingerprint: string; readonly response: Recorded };

/**
 * The storage seam. The package holds nothing: whether a key has been seen,
 * and what the original response was, is the application's to store —
 * a table, a cache, a row beside the write's own transaction.
 *
 * The contract, in full:
 *
 *   - **`claim` is atomic.** Of any number of concurrent attempts on one key,
 *     exactly one gets `Claimed`; the rest get `InProgress` or `Completed`.
 *     A unique insert is enough. Without this the guarantee does not hold.
 *   - **`complete` records the response** against the key and the attempt's
 *     fingerprint, ending the in-progress state.
 *   - **`release` forgets the claim** entirely, so the key can be attempted
 *     again — used when the attempt produced no completed write to keep (a
 *     5xx, a defect, an interruption, a handler failure).
 *   - **Failure is fatal, by design.** These effects cannot fail: a store that
 *     cannot answer must die (`Effect.orDie`). The request then 500s, is
 *     recorded nowhere, and the client may safely retry the same key — which
 *     is correct, where quietly processing a write whose idempotency cannot be
 *     guaranteed is not.
 *   - **Retention is the store's.** See `docs/idempotency.md` §6: keep a
 *     completed record for at least 24 hours; once it is evicted the key is
 *     unknown again and a later retry runs as a fresh write.
 *
 * @since 0.15.0
 * @category models
 */
export interface Store {
  /** Atomically claims the key for this attempt, reporting what was there. */
  readonly claim: (attempt: Attempt) => Effect.Effect<Claim>;
  /** Records the response this attempt produced. */
  readonly complete: (attempt: Attempt, response: Recorded) => Effect.Effect<void>;
  /** Forgets this attempt's claim, so the key may be used again. */
  readonly release: (attempt: Attempt) => Effect.Effect<void>;
}

/**
 * An in-memory {@link Store}: a reference implementation of the contract, for
 * tests and single-process development.
 *
 * Not for production — it is per-process (two servers do not share it) and
 * never evicts, so it has no retention policy to publish.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { Idempotency } from "@thomasfosterau/effect-jsonapi"
 *
 * const program = Effect.gen(function* () {
 *   const store = Idempotency.memoryStore()
 *   const attempt = {
 *     key: "k1",
 *     fingerprint: "abc",
 *     request: undefined as never // the store scopes by key alone
 *   }
 *
 *   const first = yield* store.claim(attempt) // { _tag: "Claimed" }
 *   yield* store.complete(attempt, { status: 201, headers: {}, body: "{}" })
 *   const second = yield* store.claim(attempt) // { _tag: "Completed", … }
 *   return [first._tag, second._tag] as const
 * })
 *
 * Effect.runPromise(program)
 * ```
 *
 * @since 0.15.0
 * @category constructors
 */
export const memoryStore = (): Store => {
  type Entry =
    | { readonly state: "in-progress"; readonly fingerprint: string }
    | { readonly state: "completed"; readonly fingerprint: string; readonly response: Recorded };
  const entries = new Map<string, Entry>();

  return {
    claim: (attempt) =>
      Effect.sync(() => {
        const entry = entries.get(attempt.key);
        if (entry === undefined) {
          entries.set(attempt.key, { state: "in-progress", fingerprint: attempt.fingerprint });
          return { _tag: "Claimed" } as const;
        }
        return entry.state === "in-progress"
          ? ({ _tag: "InProgress", fingerprint: entry.fingerprint } as const)
          : ({
              _tag: "Completed",
              fingerprint: entry.fingerprint,
              response: entry.response,
            } as const);
      }),
    complete: (attempt, response) =>
      Effect.sync(() => {
        entries.set(attempt.key, {
          state: "completed",
          fingerprint: attempt.fingerprint,
          response,
        });
      }),
    release: (attempt) =>
      Effect.sync(() => {
        entries.delete(attempt.key);
      }),
  };
};

// ---------------------------------------------------------------------------
// The middleware
// ---------------------------------------------------------------------------

/**
 * The middleware an idempotent endpoint carries: it reads the key, consults
 * the {@link Store}, and either replays, rejects or records. Attached for you
 * by the write constructors' `idempotency` option; attach it yourself
 * (`group.middleware(Idempotency.Middleware)`) for endpoints you declare
 * directly.
 *
 * Because it is a service, an `HttpApi` containing an idempotent endpoint does
 * not type-check until {@link layer} is provided — the store cannot be
 * forgotten.
 *
 * @since 0.15.0
 * @category services
 */
export class Middleware extends HttpApiMiddleware.Service<Middleware>()(
  "effect-jsonapi/Idempotency",
  {
    error: [KeyMismatch.wire, KeyInProgress.wire] as const,
  },
) {}

// Safe methods carry no write to make idempotent; HTTP already guarantees it.
const isSafe = (method: string): boolean =>
  method === "GET" || method === "HEAD" || method === "OPTIONS";

// `bodyText` (./internal/responseBody.js) reads the response text of a body
// whose bytes are already settled. `undefined` means "this response cannot be
// reproduced byte for byte" (a stream, a form, a raw value the platform will
// serialise later): the key is released rather than replayed from a guess.

const replay = (recorded: Recorded): HttpServerResponse.HttpServerResponse => {
  const base =
    recorded.body === ""
      ? HttpServerResponse.empty({ status: recorded.status })
      : HttpServerResponse.text(recorded.body, {
          status: recorded.status,
          contentType: recorded.headers["content-type"] ?? MEDIA_TYPE,
        });
  return HttpServerResponse.setHeaders(base, { ...recorded.headers, [REPLAY_HEADER]: "true" });
};

/**
 * The live {@link Middleware}, over a {@link Store} the application supplies.
 *
 * What it does, per request:
 *
 *   1. **No key, or a safe method** — runs the handler and records nothing.
 *      A key is opt-in per request, exactly as the draft has it; an endpoint
 *      that insists on one declares `idempotency: "required"` and gets the
 *      package's standard 400.
 *   2. **A key** — fingerprints the request ({@link fingerprint}) and claims
 *      it in the store.
 *   3. **Claimed** — runs the endpoint. A *response* below 500 is recorded and
 *      returned — the success, and the rejections rendered before the handler
 *      runs (a malformed payload's 400, a negotiation 415), which is why a
 *      client that corrects such a request must use a new key. Anything else
 *      releases the key so it can be attempted again: a 5xx, a defect, an
 *      interruption, and a handler *failure* — a declared `ApiError` is
 *      encoded downstream of this middleware and is not a completed write. A
 *      handler that has already performed a side effect must therefore answer
 *      with a response rather than fail, for the key to cover it.
 *   4. **Completed, same fingerprint** — the recorded response is replayed
 *      verbatim: the original status, headers and body, plus
 *      {@link REPLAY_HEADER}. A creation replays as its `201` with its
 *      `Location` and `self` intact, because the client's decoder is typed
 *      against the endpoint's declared status and a "distinguishable success"
 *      would break it.
 *   5. **Completed or in progress, different fingerprint** — {@link KeyMismatch}
 *      (422). Checked before the in-flight case: a client that reused a key
 *      for another write has a bug either way.
 *   6. **In progress, same fingerprint** — {@link KeyInProgress} (409).
 *
 * Atomic operations need nothing special: the extension's request *is* the
 * unit — one key covers the whole `atomic:operations` array and replays the
 * whole `atomic:results` document, which is also what makes a replayed `lid`
 * resolve to the id it resolved to the first time. See `docs/idempotency.md` §7.
 *
 * @example
 * ```ts
 * import { Layer, Schema } from "effect"
 * import { Endpoint, Group, Idempotency, Middleware, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.NonEmptyString, body: Schema.String }
 * })
 *
 * // POST /articles, accepting an Idempotency-Key
 * const articles = Group.make(Article, Endpoint.create(Article, { idempotency: true }))
 *
 * // `ArticlesLive` is your `HttpApiBuilder.group(...)` implementation.
 * const ArticlesLive: Layer.Layer<never> = Layer.empty
 *
 * const ApiLive = Layer.mergeAll(ArticlesLive).pipe(
 *   Layer.provideMerge(Middleware.layer),
 *   Layer.provideMerge(Idempotency.layer(Idempotency.memoryStore()))
 * )
 * ```
 *
 * @since 0.15.0
 * @category layers
 */
export const layer = (store: Store): Layer.Layer<Middleware> =>
  Layer.effect(
    Middleware,
    Effect.succeed<typeof Middleware.Service>(
      Effect.fnUntraced(function* (httpEffect) {
        const request = yield* HttpServerRequest;
        const raw = request.headers[HEADER];
        if (raw === undefined || isSafe(request.method)) return yield* httpEffect;

        const key = unquote(raw);
        const body = yield* Effect.orDie(request.text);
        const print = yield* fingerprint({ method: request.method, url: request.url, body });
        const attempt: Attempt = { key, fingerprint: print, request };

        const claim = yield* store.claim(attempt);
        // A key already seen: a different request under it is a mismatch;
        // the same one is still in flight, or replays its recorded response.
        if (Predicate.isTagged(claim, "InProgress")) {
          return yield* Effect.fail(
            claim.fingerprint !== print ? new KeyMismatch() : new KeyInProgress(),
          );
        }
        if (Predicate.isTagged(claim, "Completed")) {
          if (claim.fingerprint !== print) return yield* Effect.fail(new KeyMismatch());
          return replay(claim.response);
        }

        return yield* httpEffect.pipe(
          Effect.tap((response) => {
            const text = bodyText(response);
            return response.status >= 500 || text === undefined
              ? store.release(attempt)
              : store.complete(attempt, {
                  status: response.status,
                  headers: { ...response.headers },
                  body: text,
                });
          }),
          // A defect, an interruption, or a handler failure encoded downstream
          // of us, leaves no response to record — the key must not stay
          // claimed, or a write that never completed would block its retry.
          Effect.onError(() => store.release(attempt)),
        );
      }),
    ),
  );
