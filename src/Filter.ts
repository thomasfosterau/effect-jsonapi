/**
 * The JSON:API `filter` query family — the operator vocabulary.
 *
 * The filter grammar (`docs/filter-grammar.md`) fixes a **closed** operator
 * core: `eq ne lt lte gt gte in nin isnull`. This module names it once, so a
 * resource's per-attribute declaration (`Resource.attribute(schema, { filter })`)
 * and the URL codec agree byte for byte on what an operator is.
 *
 * The filter AST and the `filter[*]` URL codec (design §1 and §2) land in this
 * module in a follow-up; for now it holds only the vocabulary.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.operators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"]
 * Filter.isOperator("gt") // true
 * Filter.isOperator("like") // false — the core is closed
 * ```
 *
 * @since 0.13.0
 */

/**
 * Every filter operator, in the grammar's order: the six comparisons, the two
 * list memberships and the null test.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.operators.length // 9
 * Filter.operators[0] // "eq"
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const operators = ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"] as const

/**
 * A filter operator name — one of {@link operators}.
 *
 *   - `eq` / `ne` / `lt` / `lte` / `gt` / `gte` compare against one literal;
 *   - `in` / `nin` test membership of a non-empty literal list;
 *   - `isnull` tests for `NULL` (`true`) or its absence (`false`). `NULL` is
 *     never a literal, so this is the only way to name it.
 *
 * @since 0.13.0
 * @category models
 */
export type Operator = (typeof operators)[number]

/**
 * Whether a string names a filter operator.
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
export const isOperator = (u: unknown): u is Operator =>
  typeof u === "string" && (operators as ReadonlyArray<string>).includes(u)
