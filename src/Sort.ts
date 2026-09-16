/**
 * The JSON:API `sort` query family — the per-attribute declaration.
 *
 * An attribute is declared sortable by piping its schema through {@link able},
 * which stamps the declaration as a schema annotation under {@link AnnotationId}
 * — the single source of truth `Resource.sortable` reads back.
 * `Resource.attribute(schema, { sort: true })` is sugar for the same call.
 *
 * The `sort` query codec itself (`?sort=-createdAt,title`) is `Query.Sort`;
 * `Resource.sortable(R)` is the declared set, typed as its literal key union, so
 * it drops straight into `Endpoint.list(R, { sort: Resource.sortable(R) })`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     title: Schema.NonEmptyString.pipe(Sort.able()),
 *     body: Schema.String, // not sortable
 *     createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able()))
 *   }
 * })
 *
 * Resource.sortable(Article) // ["title", "createdAt"]
 * ```
 *
 * @since 0.13.0
 */
import type { Schema } from "effect"

/**
 * The annotation key under which an attribute schema carries its sort
 * declaration at runtime — stamped by {@link able}, read back by
 * `Resource.sortable`. Namespaced so it never collides with a consumer's own
 * annotations.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const title = Schema.String.pipe(Sort.able())
 * Schema.resolveAnnotations(title)?.[Sort.AnnotationId] // true
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const AnnotationId = "@thomasfosterau/effect-jsonapi/sort"

/**
 * The phantom property key carrying the sort declaration at the *type* level.
 * It is never present at runtime; it exists only so `Resource.SortableKeys` can
 * read an attribute's declaration from its schema type.
 *
 * @since 0.13.0
 * @category type-level
 */
export type MarkerKey = "~@thomasfosterau/effect-jsonapi/sort"

/**
 * A schema declared sortable by {@link able}: the schema itself, tagged at the
 * type level. Structurally it *is* `S`, so it behaves as `S` everywhere; only
 * the declaration readers see the tag.
 *
 * @since 0.13.0
 * @category type-level
 */
export type Declared<S extends Schema.Top> = S & { readonly [K in MarkerKey]: true }

/**
 * One term of an order: a field and the direction it is ordered in — the
 * decoded shape of a single `?sort=` term (`-createdAt` is
 * `{ field: "createdAt", direction: "desc" }`, per
 * {@link https://jsonapi.org/format/1.1/#fetching-sorting | JSON:API sorting}).
 *
 * This is the package's one vocabulary for "an order": it is what `Query.Sort`
 * decodes a `sort` query parameter into, and what a paginated relationship's
 * canonical order (`Relationship.paginated(ref, { order })`) is declared as.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Query, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * // The wire form decodes into exactly these terms.
 * const terms: ReadonlyArray<Sort.Term<"createdAt" | "title">> = Schema.decodeUnknownSync(
 *   Query.Sort(["createdAt", "title"])
 * )("-createdAt,title")
 *
 * terms // [{ field: "createdAt", direction: "desc" }, { field: "title", direction: "asc" }]
 * ```
 *
 * @since 0.15.0
 * @category models
 */
export interface Term<Field extends string = string> {
  readonly field: Field
  readonly direction: "asc" | "desc"
}

/**
 * Declares an attribute sortable (`?sort=`) — a pipeable combinator on the
 * attribute's schema, in the manner of `Schema.brand`. The declaration is a
 * schema annotation under {@link AnnotationId} and a type-level marker, from
 * which `Resource.sortable` / `Resource.SortableKeys` resolve.
 * `Resource.attribute(schema, { sort: true })` is sugar for this call.
 *
 * **Annotate last, for the types.** As for `Filter.able`: the runtime
 * declaration survives a later `.check`, `.annotate` or `Schema.brand`, but any
 * rebuild drops the type-level marker, so apply `Sort.able` as the final step of
 * the pipe. `Schema.NullOr` / `Schema.optionalKey` around the declared schema
 * keep both.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Endpoint, Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Product = Resource.make("products", {
 *   attributes: {
 *     name: Schema.NonEmptyString,
 *     priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt]), Sort.able()),
 *     createdAt: Resource.readOnlyAttribute(Schema.DateFromString.pipe(Sort.able()))
 *   }
 * })
 *
 * Resource.sortable(Product) // ["priceCents", "createdAt"]
 * // the declared set as the endpoint's sort allow-list: ?sort=-createdAt decodes, ?sort=name is a 400
 * const list = Endpoint.list(Product, { sort: Resource.sortable(Product) })
 * ```
 *
 * @since 0.13.0
 * @category combinators
 */
export const able =
  () =>
  <S extends Schema.Top>(self: S): Declared<S> =>
    self.annotate({ [AnnotationId]: true }) as unknown as Declared<S>
