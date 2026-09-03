/**
 * The JSON:API `filter` query family — the operator vocabulary and the
 * per-attribute declaration.
 *
 * The filter grammar (`docs/filter-grammar.md`) fixes a **closed** operator
 * core: `eq ne lt lte gt gte in nin isnull`. This module names it once — as a
 * schema ({@link Operator}) with typed constants ({@link Op}) — so a resource's
 * per-attribute declaration and the URL codec agree byte for byte on what an
 * operator is.
 *
 * An attribute is declared filterable by piping its schema through
 * {@link able}, which stamps the declaration as a schema annotation under
 * {@link AnnotationId} — the single source of truth `Resource.filterable` reads
 * back. `Resource.attribute(schema, { filter })` is sugar for the same call.
 *
 * The filter AST and the `filter[*]` URL codec (design §1 and §2) land in this
 * module in a follow-up.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Product = Resource.make("products", {
 *   attributes: {
 *     name: Schema.NonEmptyString, // not filterable
 *     priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt])),
 *     status: Schema.Literals(["draft", "published"]).pipe(Filter.able()) // the whole core
 *   }
 * })
 *
 * Resource.filterable(Product).priceCents.operators // ["eq", "gt", "lt"]
 * Resource.filterable(Product).status.operators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"]
 * Filter.isOperator("like") // false — the core is closed
 * ```
 *
 * @since 0.13.0
 */
import { Schema } from "effect"
import { resolveOperators } from "./internal/operators.js"

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The filter operator vocabulary, as a schema: a `Schema.Literals` over the
 * closed core, in the grammar's order — the six comparisons, the two list
 * memberships and the null test.
 *
 *   - `eq` / `ne` / `lt` / `lte` / `gt` / `gte` compare against one literal;
 *   - `in` / `nin` test membership of a non-empty literal list;
 *   - `isnull` tests for `NULL` (`true`) or its absence (`false`). `NULL` is
 *     never a literal, so this is the only way to name it.
 *
 * Being a schema, the vocabulary decodes wire input (`Schema.decodeUnknownSync(Filter.Operator)("gt")`),
 * guards it ({@link isOperator}) and lists itself ({@link operators}) from one
 * definition.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Schema.decodeUnknownSync(Filter.Operator)("gt") // "gt"
 * Filter.Operator.literals.length // 9
 * ```
 *
 * @since 0.13.0
 * @category schemas
 */
export const Operator = Schema.Literals(["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"])

/**
 * A filter operator name — the decoded type of the {@link Operator} schema.
 *
 * @since 0.13.0
 * @category models
 */
export type Operator = typeof Operator.Type

/**
 * Every filter operator, in the grammar's order — the literals of the
 * {@link Operator} schema.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.operators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"]
 * Filter.operators.length // 9
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const operators: typeof Operator.literals = Operator.literals

/**
 * Whether a value names a filter operator — the {@link Operator} schema's guard.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.isOperator("in") // true
 * Filter.isOperator("between") // false
 * ```
 *
 * @since 0.13.0
 * @category guards
 */
export const isOperator: (u: unknown) => u is Operator = Schema.is(Operator)

/**
 * The operators as typed constants, for declaration sites: `Filter.Op.eq` is
 * the literal `"eq"`, so `Filter.able([Filter.Op.eq, Filter.Op.gt])` reads as
 * a vocabulary rather than as strings, and a typo (`Filter.Op.eqq`) is a
 * compile error. Plain string literals stay accepted everywhere — they are the
 * same type.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Product = Resource.make("products", {
 *   attributes: {
 *     priceCents: Schema.Int.pipe(Filter.able([Filter.Op.gte, Filter.Op.lte])),
 *     status: Resource.attribute(Schema.String, { filter: [Filter.Op.eq, Filter.Op.in] })
 *   }
 * })
 *
 * Filter.Op.eq // "eq"
 * Resource.filterable(Product).priceCents.operators // ["gte", "lte"]
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const Op = Object.freeze({
  eq: "eq",
  ne: "ne",
  lt: "lt",
  lte: "lte",
  gt: "gt",
  gte: "gte",
  in: "in",
  nin: "nin",
  isnull: "isnull"
} as const satisfies { readonly [K in Operator]: K })

// ---------------------------------------------------------------------------
// The per-attribute declaration
// ---------------------------------------------------------------------------

/**
 * The annotation key under which an attribute schema carries its filter
 * declaration at runtime — stamped by {@link able}, read back by
 * `Resource.filterable`. Namespaced so it never collides with a consumer's own
 * annotations.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * const priceCents = Schema.Int.pipe(Filter.able(["eq", "gt"]))
 * const declaration = Schema.resolveAnnotations(priceCents)?.[Filter.AnnotationId] as Filter.Annotation
 * declaration.operators // ["eq", "gt"]
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const AnnotationId = "@thomasfosterau/effect-jsonapi/filter"

/**
 * The runtime value stored under {@link AnnotationId}: the declared operators
 * (normalised — `true` expanded to the whole core, duplicates dropped, order
 * kept) and the explicit literal codec, if one was given.
 *
 * @since 0.13.0
 * @category models
 */
export interface Annotation {
  readonly operators: ReadonlyArray<Operator>
  readonly literal: Schema.Codec<unknown, string> | undefined
}

/**
 * The decoded type of a filter literal for an attribute schema: the schema's
 * own `Type`, minus `null` — `NULL` is never a literal (`isnull` names it), so
 * a `Schema.NullOr(X)` attribute's literals are `X`.
 *
 * @since 0.13.0
 * @category type-level
 */
export type LiteralType<S extends { readonly Type: unknown }> = Exclude<S["Type"], null>

/**
 * The phantom property key carrying the filter declaration at the *type*
 * level. It is never present at runtime; it exists only so `Resource.FilterableKeys`
 * and `Resource.FilterOperators` can read an attribute's declaration from its
 * schema type.
 *
 * @since 0.13.0
 * @category type-level
 */
export type MarkerKey = "~@thomasfosterau/effect-jsonapi/filter"

/**
 * The type-level declaration carried under {@link MarkerKey}: the declared
 * operators as a union of string literals, and the decoded literal type.
 *
 * @since 0.13.0
 * @category type-level
 */
export interface Marker<Op extends Operator, Literal> {
  readonly operators: Op
  readonly literal: Literal
}

/**
 * A schema declared filterable by {@link able}: the schema itself, tagged with
 * the type-level {@link Marker}. Structurally it *is* `S`, so it behaves as `S`
 * everywhere; only the declaration readers see the tag.
 *
 * @since 0.13.0
 * @category type-level
 */
export type Declared<S extends Schema.Top, Op extends Operator = Operator, Literal = LiteralType<S>> = S & {
  readonly [K in MarkerKey]: Marker<Op, Literal>
}

/**
 * The operators an {@link able} argument admits, as a union of string
 * literals: every {@link Operator} for `true` (or no argument), the elements
 * for an array.
 *
 * @since 0.13.0
 * @category type-level
 */
export type OperatorsIn<D extends true | ReadonlyArray<Operator>> = [D] extends [true]
  ? Operator
  : D extends ReadonlyArray<infer Op extends Operator>
    ? Op
    : never

/**
 * Declares an attribute filterable — a pipeable combinator on the attribute's
 * schema, in the manner of `Schema.brand`:
 *
 *   - `Filter.able()` (or `Filter.able(true)`) admits the whole operator core;
 *   - `Filter.able(["eq", "gt"])` admits that subset, in the order given
 *     (duplicates dropped). Use {@link Op} to spell the operators as constants.
 *
 * The declaration is a schema annotation under {@link AnnotationId} — the one
 * source of truth `Resource.filterable` reads — and a type-level
 * {@link Marker}, from which `Resource.FilterableKeys` / `Resource.FilterOperators`
 * resolve. `Resource.attribute(schema, { filter })` is sugar for this call, so
 * the two spellings are indistinguishable downstream.
 *
 * The literal codec (wire string ⇆ the attribute's `Type`) is derived from the
 * schema's encoded form — `string`, `number`, `boolean`, or `Schema.NullOr` of
 * one — when the resource is made; see `Resource.filterable`. For the rare
 * attribute whose encoded form is not a JSON scalar, pass `literal`, an
 * explicit `Codec<Type, string>` (its `Type` must admit the attribute's).
 *
 * Definition-time errors: an empty array, and an operator outside the core
 * (also a compile error).
 *
 * **Annotate last, for the types.** The runtime declaration survives any later
 * rebuild — `.check(...)`, `.annotate(...)`, `Schema.brand` — but a rebuild
 * yields the base schema *type*, dropping the type-level marker, so
 * `Resource.FilterableKeys` no longer names the attribute. Apply `Filter.able` /
 * `Sort.able` as the final step of the pipe; wrapping the declared schema in
 * `Schema.NullOr` or `Schema.optionalKey` afterwards keeps both (the readers
 * look through both).
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource, Sort } from "@thomasfosterau/effect-jsonapi"
 *
 * const Product = Resource.make("products", {
 *   attributes: {
 *     priceCents: Schema.Int.pipe(Filter.able([Filter.Op.eq, Filter.Op.gt, Filter.Op.lt]), Sort.able()),
 *     status: Schema.Literals(["draft", "published"]).pipe(Filter.able()),
 *     rating: Schema.NullOr(Schema.Number.pipe(Filter.able(["gte", "isnull"])))
 *   }
 * })
 *
 * Object.keys(Resource.filterable(Product)) // ["priceCents", "status", "rating"]
 * Resource.filterable(Product).priceCents.operators // ["eq", "gt", "lt"]
 * Schema.decodeUnknownSync(Resource.filterable(Product).rating.literal)("4.5") // 4.5
 * ```
 *
 * @since 0.13.0
 * @category combinators
 */
export function able<const Ops extends true | ReadonlyArray<Operator> = true>(
  operators?: Ops,
  options?: { readonly literal?: undefined }
): <S extends Schema.Top>(self: S) => Declared<S, OperatorsIn<Ops>>
export function able<const Ops extends true | ReadonlyArray<Operator>, Literal>(
  operators: Ops,
  options: { readonly literal: Schema.Codec<Literal, string> }
): <S extends Schema.Top>(self: S & { readonly Type: Literal | null }) => Declared<S, OperatorsIn<Ops>, Literal>
export function able(
  operators: true | ReadonlyArray<Operator> = true,
  options?: { readonly literal?: Schema.Codec<unknown, string> | undefined }
): (self: Schema.Top) => Schema.Top {
  const annotation: Annotation = {
    operators: resolveOperators(operators, Operator, "Filter.able"),
    literal: options?.literal
  }
  return (self) => self.annotate({ [AnnotationId]: annotation })
}
