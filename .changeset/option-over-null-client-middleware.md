---
"@thomasfosterau/effect-jsonapi": minor
---

**Breaking:** `Client`, `Conformance`, `Middleware`, `Negotiation`, `Registry`, `ServerErrors`, `ApiError` and `Idempotency` no longer spell "absent" as `undefined` in their options and results (`effect/prefer-option-over-null`, 4 of 6, #533). Options members are `readonly x?: T`, so under `exactOptionalPropertyTypes` they no longer accept an explicit `undefined`; a "maybe" result is an `Option`; a record member that may be absent is optional.

Options members (`readonly x?: T | undefined` → `readonly x?: T`):

- `Client.MakeOptions`: `baseUrl`, `transformClient`, `transformResponse`, `decodeErrors`.
- `Client.PageCursorOptions`: `key`, `defaultLimit`, `maxLimit`.
- `Conformance.Options`: `ids`, `paths`, `absentId`, `extensions`, `mutating`, `writes`, `tiers`, `only`, `skip`, `requestTimeout`, `target`; `Conformance.format`'s `width`.
- `Conformance.WriteFixture`: `create`, `update`, `cleanup`, `clientId`.
- `Middleware.QueryParameterOptions.allowedQueryParameters`, `Middleware.SchemaErrorsOptions.checkLinkage`, `Middleware.QueryParameterCheck.declared`.
- `Negotiation.Options`: `fallback`, `alternates`.
- `Registry.Options.respond`; `Registry.webHandler`'s `disableLogger`.
- `ServerErrors.SchemaIssueOptions`: `status`, `prefix`; `ServerErrors.RespondOptions`: `materialise`, `override`.

Results and signatures:

- `Middleware.negotiate(headers, options?)` takes the request's headers as a `Headers.Input` — a web `Headers` (`request.headers`), an effect `Headers` or a plain record — instead of `{ contentType?, accept? }`, and returns `Option<UnsupportedMediaType | NotAcceptable>` (was the error or `undefined`).
- `Middleware.checkQueryParameters` returns `Option<ErrorDocument>` (was the document or `undefined`).
- `Middleware.contentTypeIsAcceptable` / `acceptIsAcceptable` take `header?: string` (was a required `string | undefined`).
- `ApiError` classes' static `title` is `Option<string>` (was `string | undefined`). `ApiError.make`'s `detail` / `source` callbacks return the value, or an `Option` of it when an occurrence may carry none (was the value or `undefined`).
- `Client.related` / `Client.walk` take `data: LinkedResource` (was `LinkedResource | undefined`; pass `{}` for no primary data — `Client.hydrate` does). `Client.indexIncluded(included?)` takes an optional parameter.
- `Client.LooseInput<T>` is `{ readonly [K in keyof T]?: T[K] }` (no `| undefined`); build one from maybe-undefined values with `Client.stripUndefined`. `Client.PageFilters` is `{ readonly [key: string]: string }`.
- `Conformance.Report`'s `writes` / `samples`, `Conformance.Write`'s `id` / `detail`, a `Finding`'s `probe` and a `Passed` outcome's `note` are optional members (a `Write`'s `id` and `detail`, a finding's `probe` and a pass's `note` were required `T | undefined`).
- `Idempotency.headersFor` (internal) returns `Option<Schema.Top>`.

Migration for the apps:

- An options key whose value may be `undefined` is left out rather than set to `undefined`. A conditional empty-object spread (`...(x === undefined ? {} : { x })`) is rejected by `effect/no-conditional-empty-object-spread`, so copy this helper (it is what the package uses internally) and spread one call per key:

  ```ts
  import * as P from "effect/Predicate";

  const definedMember = <const K extends string, A>(
    key: K,
    value: A,
  ): { readonly [P in K]?: Exclude<A, undefined> } => {
    const member: { [P in K]?: Exclude<A, undefined> } = {};
    if (P.isNotUndefined(value)) member[key] = value;
    return member;
  };

  Client.make(Api, { ...definedMember("baseUrl", env.API_URL), decodeErrors: true });
  ```

  For a value already held as an `Option`, the same shape with `if (Option.isSome(value)) member[key] = value.value` (the package's `someMember`).

- A "maybe" result is now an `Option`: `Option.getOrUndefined` keeps the old behaviour (`Option.getOrUndefined(Middleware.negotiate(request.headers))`); `Option.isSome` / `Option.match` replace the `!== undefined` checks.
- `Middleware.negotiate({ contentType, accept })` becomes `Middleware.negotiate(request.headers)` (or `{ "content-type": …, accept: … }`).
- A `detail` / `source` callback that returned `undefined` returns an `Option` instead: `(e) => Option.fromUndefinedOr(e.reason)`.
- Wire shapes are unchanged.
