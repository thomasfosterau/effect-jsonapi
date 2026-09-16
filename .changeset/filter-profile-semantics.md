---
"@thomasfosterau/effect-jsonapi": minor
---

**The filter profile now defines its own semantics, with a reference interpreter: `Filter.evaluate`
and `Filter.matches`.** The package published a filter **profile** — a URI advertised on the
`profile` media-type parameter — that specified an operator vocabulary, a URL encoding and a
canonical form, and then pointed at an architecture decision record in a different project, about a
different data structure, as the definition of what its operators meant. A profile exists to be
interoperable; a third-party implementer had nowhere to look.

`docs/filter-grammar.md` §6 is now that definition, written for a third-party JSON:API implementer
and citing nothing outside this repository. It answers every question the grammar had left open:

- **Three-valued logic.** A comparison whose field is NULL is UNKNOWN, and a server returns the
  resources for which the filter is TRUE — so `?filter[status][ne]=done` does not return a resource
  whose `status` is NULL. Full Kleene tables for `and` / `or` / `not`, with the reasoning for
  choosing three-valued over two-valued recorded.
- **An absent attribute is NULL**, indistinguishable from an explicit `null`.
- **`null` is never a literal**, now enforced: `Filter.Ast` rejects a `null` in scalar and list
  literal positions alike, naming `isnull` as the operator to use.
- **`NotIn` is exactly `Not(In)`**, UNKNOWN case included — SQL's divergence between the two needs a
  NULL inside the list, which the grammar cannot express.
- **Comparison.** Equality is equality of the encoded wire form, which is total over every
  declarable attribute. Ordering is the decoded order of a `string` (code point, not locale
  collation), `number`, `bigint` or `Date`; no other kind has an ordering in this profile, and an
  attribute outside those kinds must not declare an ordering operator.
- **Scope.** `sort` ordering is explicitly not governed by this profile, and neither is
  authorization.

**Profile versioning: writing the semantics down is a clarification of `v1`, not a `v2`.** Every
rule recorded is one a careful reading of the existing grammar already forced, so no conforming
implementation changes behaviour and no client re-negotiates; the reasoning, and the forward rule
(a change to any truth table, the comparison domain, or the absent-attribute rule _is_ a `v2`), are
recorded in §5.

**A reference interpreter ships.** `Filter.evaluate(node, subject, fields)` returns the three-valued
truth and `Filter.matches(node, subject, fields)` the TRUE-only predicate, over a record of decoded
attribute values. The reasoning is recorded in §6.8: a profile that cannot be executed is only
prose, an implementer needs an oracle, and a truth table asserted in Markdown alone drifts. It is a
plain predicate, not a query engine — `Schema`-only, so it costs a client nothing.

Every rule has a conformance test in `src/Filter.semantics.test.ts`, including the NULL cases for
`Not` and `NotIn`, a `null` in a literal position, and the code-point-versus-code-unit case where
the profile's string order disagrees with JavaScript's own `<`.

The one behavioural change is the null-literal rejection, which refuses a hand-built AST the grammar
already documented as illegal and which has no URL spelling.
