/**
 * The filter operator vocabulary — named once, here, so `Filter.Operator`
 * (the public schema) and the URL grammar engine (`internal/filter.ts`) read
 * the same list without a module cycle — and the normalisation of a `filter`
 * declaration against it.
 *
 * @internal
 */
import { Schema } from "effect"

/** The six comparison operators: one literal against the field. */
export const compareOperators = ["eq", "ne", "lt", "lte", "gt", "gte"] as const

/** The two list-membership operators: a non-empty literal list. */
export const listOperators = ["in", "nin"] as const

/** The null test. */
export const nullOperator = "isnull"

/**
 * The closed operator core, in the grammar's order. `Filter.Operator` is the
 * `Schema.Literals` over exactly this tuple.
 */
export const operators = [...compareOperators, ...listOperators, nullOperator] as const

/** The conjunctions of the group form. */
export const conjunctions = ["AND", "OR", "NOT"] as const

/**
 * Normalises a `filter` declaration to the operator list it declares, checked
 * against `allowed` — a `Schema.Literals` over the vocabulary (the closed core
 * for an attribute, the id-comparison subset for a relationship): `true` is
 * every literal, an array is itself (deduplicated, order kept).
 *
 * An empty array, or one naming an operator outside `allowed`, is a definition
 * error, not a wire error; `subject` names the declaration in the message.
 */
export const resolveOperators = <const L extends ReadonlyArray<string>>(
  filter: true | ReadonlyArray<string>,
  allowed: Schema.Literals<L>,
  subject: string
): ReadonlyArray<L[number]> => {
  if (filter === true) return allowed.literals
  if (filter.length === 0) {
    throw new Error(`${subject} declares filter: [] — no operators; omit \`filter\` (or pass false) instead`)
  }
  const isAllowed = Schema.is(allowed)
  const operators: Array<L[number]> = []
  for (const operator of filter) {
    if (!isAllowed(operator)) {
      throw new Error(
        `${subject} declares filter operator ${JSON.stringify(operator)}; expected one of ${allowed.literals.join(", ")}`
      )
    }
    if (!operators.includes(operator)) operators.push(operator)
  }
  return operators
}
