/**
 * Type-level tests for the client surface: the derived client keeps the api's
 * shape, the negotiation transform keeps the underlying client's error and
 * service channels, and the best-effort error decode stays optional.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Each is paired with a negative control — the
 * same expression in its legal form — so an annotation cannot pass merely
 * because the surrounding code is broken.
 */
import type { Option } from "effect";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { HttpApi } from "effect/http-api";
import { Client, Endpoint, Group, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
});

const Api = HttpApi.make("blog").add(
  Group.make(Article, Endpoint.get(Article), Endpoint.delete(Article)),
);

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {};

// ---------------------------------------------------------------------------
// make: the derived client keeps the api's shape
// ---------------------------------------------------------------------------

const calls = Effect.fn("calls")(function* () {
  const client = yield* Client.make(Api, { baseUrl: "http://localhost" });

  // control: the endpoints the api declares
  yield* client.articles.get({ params: { id: Article.Id.make("1") }, query: {} });
  yield* client.articles.delete({ params: { id: Article.Id.make("1") } });

  // @ts-expect-error -- `list` was never declared on this api
  yield* client.articles.list({ query: {} });

  // @ts-expect-error -- the group is `articles`, not `posts`
  yield* client.posts.get({ params: { id: "1" }, query: {} });

  // @ts-expect-error -- `id` is a branded Article id, not any string
  yield* client.articles.delete({ params: { id: "1" } });
});

// control: the client needs the `HttpClient` service…
assertType<Effect.Effect<unknown, never, HttpClient.HttpClient>>(Client.make(Api));
// …and cannot be built without it. The language-service plugin reports the
// same fact as its own `missingEffectContext` diagnostic, which no
// `@ts-expect-error` covers, so it is switched off for this one assertion.
// @effect-diagnostics missingEffectContext:off
// @ts-expect-error -- the requirement is not `never`
assertType<Effect.Effect<unknown, never, never>>(Client.make(Api));
// @effect-diagnostics missingEffectContext:error

// ---------------------------------------------------------------------------
// transform: the underlying client's channels survive
// ---------------------------------------------------------------------------

declare const custom: HttpClient.HttpClient.With<"boom", never>;

// control: the error channel is carried through unchanged
assertType<HttpClient.HttpClient.With<"boom", never>>(Client.transform(custom));
assertType<HttpClient.HttpClient.With<"boom", never>>(
  Client.transformWith({ extensions: ["urn:ext"] })(custom),
);

// @ts-expect-error -- the transform does not discharge the client's errors
assertType<HttpClient.HttpClient.With<never, never>>(Client.transform(custom));

// ---------------------------------------------------------------------------
// Error documents: the decode is best-effort, so the result is optional
// ---------------------------------------------------------------------------

// control
assertType<Option.Option<Client.ErrorDocument>>(Client.decodeErrorDocument("{}"));
// @ts-expect-error -- a body may not be an error document at all
assertType<Client.ErrorDocument>(Client.decodeErrorDocument("{}"));

// control: the cause-based decode never fails and needs nothing
assertType<Effect.Effect<Option.Option<Client.ErrorDocument>, never, never>>(
  Client.errorDocument(new Error("x")),
);

// control
Client.errorMessage({ errors: [{ status: "404", detail: "gone" }] });
// @ts-expect-error -- a data document is not an error document
Client.errorMessage({ data: { type: "articles", id: "1" } });

// control
Client.isMutatingMethod("DELETE");
// @ts-expect-error -- a method is a string
Client.isMutatingMethod(1);

export { calls, custom };
