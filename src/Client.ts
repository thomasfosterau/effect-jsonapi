/**
 * Client-side helpers.
 *
 * {@link narrowIncluded} narrows a compound document's `included` member to
 * exactly the resources reachable via the include paths the client requested:
 *
 * ```ts
 * const include = ["author", "comments.author"] as const
 *
 * const document = yield* client.articles.fetch({
 *   params: { id: Article.Id.make("1") },
 *   query: { include }
 * }).pipe(JsonApi.narrowIncluded(Article, include))
 *
 * document.included
 * //       ^ ReadonlyArray<Person | Comment> — Tag and other unrequested
 * //         resources are excluded from the type
 * ```
 *
 * The narrowing is justified by the spec: when a client supplies `include`,
 * "the server MUST NOT include unrequested resource objects in the `included`
 * section" (https://jsonapi.org/format/1.1/#fetching-includes). The runtime
 * decode still validates against the endpoint's full `included` union, so a
 * non-compliant server fails decoding rather than producing lies.
 *
 * @since 0.1.0
 */
import type { Effect } from "effect"
import type { Any, IncludedFor, IncludePath } from "./Resource.js"

/**
 * The minimal shape of a compound document value.
 *
 * @since 0.1.0
 * @category models
 */
export interface AnyDocument {
  readonly included?: ReadonlyArray<unknown> | undefined
}

/**
 * A document with its `included` member narrowed to the given resources'
 * decoded types.
 *
 * @since 0.1.0
 * @category type-level
 */
export type NarrowedDocument<Doc, Included extends Any> = Omit<Doc, "included"> & {
  readonly included?: ReadonlyArray<Included["Type"]>
}

/**
 * Narrows a response document's `included` member to the resources reachable
 * via the requested include paths.
 *
 * Dual API:
 * - data-last (pipe an `Effect` producing a document)
 * - data-first (narrow a document value directly)
 *
 * This is a type-level operation with no runtime cost.
 *
 * @example
 * ```ts
 * import { Effect } from "effect"
 * import { JsonApi } from "@thomasfosterau/effect-jsonapi"
 *
 * declare const client: {
 *   readonly articles: {
 *     readonly fetch: (request: {
 *       readonly params: { readonly id: string }
 *       readonly query: { readonly include?: ReadonlyArray<JsonApi.IncludePath<typeof Article>> }
 *     }) => Effect.Effect<ReturnType<typeof Article.document>["Type"]>
 *   }
 * }
 * declare const Article: JsonApi.Any
 *
 * const include = ["author", "comments.author"] as const
 *
 * const program = client.articles
 *   .fetch({ params: { id: "1" }, query: { include } })
 *   .pipe(JsonApi.narrowIncluded(Article, include))
 * //   ^ Effect of a document whose `included` is narrowed to the requested
 * //     resources — unrequested types are excluded from the type.
 * ```
 *
 * @since 0.1.0
 * @category combinators
 */
export const narrowIncluded: {
  <R extends Any, const Paths extends ReadonlyArray<IncludePath<R>>>(
    resource: R,
    include: Paths
  ): <Doc extends AnyDocument, E, Req>(
    effect: Effect.Effect<Doc, E, Req>
  ) => Effect.Effect<NarrowedDocument<Doc, IncludedFor<R, Paths>>, E, Req>
  <R extends Any, const Paths extends ReadonlyArray<IncludePath<R>>, Doc extends AnyDocument>(
    resource: R,
    include: Paths,
    document: Doc
  ): NarrowedDocument<Doc, IncludedFor<R, Paths>>
} = ((...args: ReadonlyArray<unknown>) =>
  args.length >= 3
    ? // data-first: the document itself
      args[2]
    : // data-last: an identity function over the effect
      (effect: unknown) => effect) as never
