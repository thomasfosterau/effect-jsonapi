/**
 * Type-level tests asserting the *emitted* declarations, not the sources.
 *
 * Every other `*.types.ts` file resolves `@thomasfosterau/effect-jsonapi`
 * through `tsconfig.test.json`'s `paths` mapping to `./src/index.ts`, so it
 * checks what TypeScript infers from source. Consumers never see that — they
 * see `dist/index.d.ts`, and the two are not interchangeable: an endpoint
 * constructor with no explicit return type is emitted as whatever declaration
 * emit serialised, which can differ from what the source resolves to.
 *
 * That gap produced a real bug (#104). The `:id` constructors passed a bare
 * field record as `params`, so `HttpApiEndpoint`'s return type stayed a
 * deferred conditional; emit serialised it with the true branch's narrowing
 * baked in, as `Schema.Struct<Schema.Struct.Fields & { id: … }>`. The index
 * signature admits `Schema.Top`, whose `DecodingServices` is `unknown`, so
 * every `get` / `update` / `delete` / relationship method on a generated
 * client carried an `unknown` requirement that no layer could satisfy —
 * while the source-resolved type checked clean.
 *
 * This file is checked by `tsconfig.dist.json` (`pnpm run typecheck:dist`),
 * which maps the package to `./dist/index.d.ts` and therefore only means
 * anything after a build.
 */
import { Effect, Schema } from "effect"
import { HttpApi, HttpApiClient } from "effect/unstable/httpapi"
import { Endpoint, Group, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"

const Person = Resource.make("people", { attributes: { name: Schema.String } })

const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) }
})

/** A group generated end-to-end by {@link Group.resource}. */
const Generated = HttpApi.make("api").add(Group.resource(Article)).add(Group.resource(Person))

/** The same endpoints assembled by hand from the `Endpoint.*` constructors. */
const Assembled = HttpApi.make("api")
  .add(Group.make("articles", Endpoint.get(Article), Endpoint.update(Article), Endpoint.delete(Article)))
  .add(Group.resource(Person))

declare const baseUrl: string
declare const id: never

/** Accepts only an effect whose requirements are exactly `never`. */
const assertNever = <A, E>(_: Effect.Effect<A, E, never>): void => {}

export const generated = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Generated, { baseUrl })
  // Paramless endpoints were never affected — they pin the baseline.
  assertNever(client.articles.list({ query: {} }))
  // `:id` endpoints: the regression surface.
  assertNever(client.articles.get({ params: { id }, query: {} }))
  assertNever(client.articles.delete({ params: { id } }))
  assertNever(client.articles.author({ params: { id }, query: {} }))
  assertNever(client.articles.authorRelationship({ params: { id }, query: {} }))
})

export const assembled = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Assembled, { baseUrl })
  assertNever(client.articles.get({ params: { id }, query: {} }))
  assertNever(client.articles.delete({ params: { id } }))
})

/**
 * Negative control. Without this, `assertNever` passing would prove nothing:
 * if the assertion had no teeth every call above would pass vacuously.
 */
declare const withRequirement: Effect.Effect<number, never, unknown>
// @ts-expect-error `assertNever` must reject a non-`never` requirement
assertNever(withRequirement)

/**
 * The `params` schema must stay *typed*, not merely free of requirements.
 * Erasing it to `never` would also satisfy the assertions above, so pin that
 * the id param is still required and still branded.
 */
export const paramsStillTyped = Effect.gen(function* () {
  const client = yield* HttpApiClient.make(Generated, { baseUrl })
  // @ts-expect-error `params` is required — erasing it to `never` must fail here
  yield* client.articles.get({ query: {} })
  // @ts-expect-error `id` is a branded articles id, not a plain string
  yield* client.articles.get({ params: { id: "unbranded" }, query: {} })
})
