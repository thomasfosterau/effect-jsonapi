/**
 * JSON:API resource groups.
 *
 * Light sugar over `HttpApiGroup`: a group named after the resource type,
 * holding JSON:API endpoints.
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
 * const Api = HttpApi.make("blog").add(articles)
 * ```
 *
 * The result is a plain `HttpApiGroup`, so everything composes with vanilla
 * `HttpApi` / `HttpApiBuilder` / `HttpApiClient` / `HttpApiTest` / `OpenApi`.
 */
import type { NonEmptyReadonlyArray } from "effect/Array"
import type { HttpApiEndpoint } from "effect/unstable/httpapi"
import { HttpApiGroup } from "effect/unstable/httpapi"

/**
 * Creates an `HttpApiGroup` named after a resource's type, containing the
 * given endpoints.
 */
export const make = <const Type extends string, const Endpoints extends NonEmptyReadonlyArray<HttpApiEndpoint.Any>>(
  resource: { readonly type: Type },
  ...endpoints: Endpoints
): HttpApiGroup.HttpApiGroup<Type, Endpoints[number]> =>
  HttpApiGroup.make(resource.type).add(...(endpoints as unknown as NonEmptyReadonlyArray<HttpApiEndpoint.Any>))
