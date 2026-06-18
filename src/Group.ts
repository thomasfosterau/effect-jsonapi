/**
 * JSON:API resource groups.
 *
 * Light sugar over `HttpApiGroup`: a group named after a resource type (or a
 * plain name, for heterogeneous endpoints like search), holding JSON:API
 * endpoints.
 *
 * ```ts
 * const articles = Group.make(Article,
 *   Endpoint.fetch(Article, { include: true, errors: [ArticleNotFound] }),
 *   Endpoint.list(Article, { page: Query.Page.Offset }),
 *   Endpoint.create(Article),
 *   Endpoint.update(Article, { errors: [ArticleNotFound] }),
 *   Endpoint.remove(Article, { errors: [ArticleNotFound] })
 * )
 *
 * const search = Group.make("search",
 *   Endpoint.search([Article, Person], { filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * The result is a plain `HttpApiGroup`, so everything composes with vanilla
 * `HttpApi` / `HttpApiBuilder` / `HttpApiClient` / `HttpApiTest` / `OpenApi`.
 *
 * @since 0.1.0
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"
import { HttpApiGroup } from "effect/unstable/httpapi"

/**
 * Creates an `HttpApiGroup` named after a resource's type — or after a plain
 * string, for groups that span several resource types — containing the given
 * endpoints.
 *
 * Re-exported as `JsonApi.Group`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { HttpApi } from "effect/unstable/httpapi"
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = JsonApi.Resource("articles", {
 *   attributes: { title: Schema.NonEmptyString }
 * })
 * const Person = JsonApi.Resource("people", {
 *   attributes: { name: Schema.NonEmptyString }
 * })
 *
 * // A group named after a resource type
 * const articles = JsonApi.Group(
 *   Article,
 *   JsonApi.Endpoint.fetch(Article, { include: true }),
 *   JsonApi.Endpoint.list(Article, { page: JsonApi.Page.Offset })
 * )
 *
 * // A group named after a plain string, for heterogeneous endpoints
 * const search = JsonApi.Group(
 *   "search",
 *   JsonApi.Endpoint.search([Article, Person], { filter: { q: Schema.String } })
 * )
 *
 * const Api = HttpApi.make("blog").add(articles).add(search)
 * ```
 *
 * @since 0.1.0
 * @category constructors
 */
export const make: {
  <const Type extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    resource: { readonly type: Type },
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Type, Endpoints[number]>
  <const Name extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
    name: Name,
    ...endpoints: Endpoints
  ): HttpApiGroup.HttpApiGroup<Name, Endpoints[number]>
} = (nameOrResource: string | { readonly type: string }, ...endpoints: ReadonlyArray<HttpApiEndpoint.Any>) =>
  HttpApiGroup.make(typeof nameOrResource === "string" ? nameOrResource : nameOrResource.type).add(
    ...(endpoints as unknown as NonEmptyReadonlyArray<HttpApiEndpoint.Any>)
  ) as never
