/**
 * Normalising a `filter` declaration against a closed operator vocabulary.
 *
 * @internal
 */
import { Schema } from "effect"

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
