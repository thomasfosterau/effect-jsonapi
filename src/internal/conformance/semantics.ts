/**
 * The filter profile's evaluation semantics — `docs/filter-grammar.md` §6 — as
 * a fold over the filter AST: the conformance kit's own oracle (#161).
 *
 * The package evaluates no filter (§6.9): a server does, against its store.
 * The kit needs an oracle anyway, to say which resources a filtered request
 * should have returned, so it keeps this one internal. Nothing here is
 * exported from `Filter`, and the comparison domain (F-ORD-1) is not read off
 * a resource definition: it is the JSON type of the value the kit observed,
 * which is the domain §6.2 defines comparison on.
 *
 * `src/Filter.semantics.test.ts` imports this fold rather than keeping a copy,
 * so the tables it checks for coherence are the ones the kit runs.
 *
 * @since 0.17.0
 * @internal
 */
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Filter from "../../Filter.js";
import { compareCodePoints } from "../filter.js";

/**
 * §6.3: the three truth values.
 *
 * @internal
 */
export type Truth = "TRUE" | "FALSE" | "UNKNOWN";

/**
 * §6.4: the absence of a value for a field on one resource. Never a literal.
 *
 * @internal
 */
export const NULL: unique symbol = Symbol.for("@thomasfosterau/effect-jsonapi/conformance/NULL");

/** @internal */
export type Null = typeof NULL;

/**
 * §6.2 F-ORD-1: every filterable field's values, and every literal, are a JSON
 * scalar.
 *
 * @internal
 */
export type Json = string | number | boolean;

/**
 * One resource as §6.1 F-EVAL-4 reads it: each field to its JSON value, or
 * NULL. A field the row does not carry is NULL too (F-EVAL-5).
 *
 * @internal
 */
export interface Row {
  readonly [field: string]: Json | Null;
}

/** @internal */
export const truth = (value: boolean): Truth => (value ? "TRUE" : "FALSE");

/**
 * §6.3.3 F-LOGIC-1: Kleene's strong conjunction.
 *
 * @internal
 */
export const AND = {
  TRUE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  FALSE: { TRUE: "FALSE", FALSE: "FALSE", UNKNOWN: "FALSE" },
  UNKNOWN: { TRUE: "UNKNOWN", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
} as const satisfies { readonly [A in Truth]: { readonly [B in Truth]: Truth } };

/**
 * §6.3.3 F-LOGIC-1: Kleene's strong disjunction.
 *
 * @internal
 */
export const OR = {
  TRUE: { TRUE: "TRUE", FALSE: "TRUE", UNKNOWN: "TRUE" },
  FALSE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  UNKNOWN: { TRUE: "TRUE", FALSE: "UNKNOWN", UNKNOWN: "UNKNOWN" },
} as const satisfies { readonly [A in Truth]: { readonly [B in Truth]: Truth } };

/**
 * §6.3.3 F-LOGIC-1: Kleene negation.
 *
 * @internal
 */
export const NOT = {
  TRUE: "FALSE",
  FALSE: "TRUE",
  UNKNOWN: "UNKNOWN",
} as const satisfies { readonly [A in Truth]: Truth };

/**
 * A comparison F-ORD-1 defines no domain for — a literal that is not a JSON
 * scalar, or one of another JSON type than the value — and a defect of the
 * caller, since the kit only compares a field against a literal it observed
 * in that field.
 *
 * @internal
 */
export class DomainMismatch extends Schema.TaggedError<DomainMismatch>()("DomainMismatch", {
  value: Schema.Unknown,
  literal: Schema.Unknown,
}) {}

/** F-ORD-1: a JSON string, number or boolean. */
export const isJson: Predicate.Refinement<unknown, Json> = Predicate.or(
  Predicate.or(Predicate.isString, Predicate.isNumber),
  Predicate.isBoolean,
);

/**
 * §6.2 F-ORD-1 / F-ORD-2: the order of a value against a literal, in the
 * domain of their JSON type — numeric for numbers, `false < true` for
 * booleans, code-point order for strings. Throws {@link DomainMismatch} for
 * two values of different JSON types.
 *
 * @internal
 */
export const compare = (value: Json, literal: Json): number => {
  if (Predicate.isNumber(value) && Predicate.isNumber(literal))
    return value < literal ? -1 : value > literal ? 1 : 0;
  if (Predicate.isBoolean(value) && Predicate.isBoolean(literal))
    return Number(value) - Number(literal);
  if (Predicate.isString(value) && Predicate.isString(literal))
    return compareCodePoints(value, literal);
  throw new DomainMismatch({ value, literal });
};

/** §6.3.1 F-CMP-2: each operator's relation on a non-NULL value's order. */
const RELATIONS = {
  eq: (order) => order === 0,
  ne: (order) => order !== 0,
  lt: (order) => order < 0,
  lte: (order) => order <= 0,
  gt: (order) => order > 0,
  gte: (order) => order >= 0,
} as const satisfies { readonly [Op in Filter.CompareOperator]: (order: number) => boolean };

/** §6.4 / F-EVAL-5: a member that is `null` and one that is absent are one NULL. */
const isNullIn = (row: Row, field: string): boolean => {
  const value = row[field];
  return value === undefined || value === NULL;
};

/** §6.3.1: one comparison of the row's field against one literal. */
const comparison = (
  op: Filter.CompareOperator,
  row: Row,
  field: string,
  literal: Filter.Compare["value"],
): Truth => {
  const value = row[field];
  // F-CMP-1: every comparison against NULL is UNKNOWN.
  if (value === undefined || value === NULL) return "UNKNOWN";
  if (!isJson(literal)) throw new DomainMismatch({ value, literal });
  // F-CMP-2: otherwise the two-valued result of the relation.
  return truth(RELATIONS[op](compare(value, literal)));
};

/** F-IN-1: a disjunction of equalities. */
const membership = (row: Row, field: string, literals: Filter.In["values"]): Truth =>
  literals.reduce<Truth>((acc, literal) => OR[acc][comparison("eq", row, field, literal)], "FALSE");

/**
 * §6.3: the truth value of a filter tree for one resource. Its literals are
 * JSON scalars (F-ORD-1), as the kit builds them; one that is not throws
 * {@link DomainMismatch}.
 *
 * @internal
 */
export const evaluate = (node: Filter.Node, row: Row): Truth =>
  Match.valueTags(node, {
    Compare: ({ op, field, value }) => comparison(op, row, field, value),
    In: ({ field, values }) => membership(row, field, values),
    // F-IN-2: the negation of F-IN-1.
    NotIn: ({ field, values }) => NOT[membership(row, field, values)],
    // F-ISNULL-1 / F-ISNULL-2: total, never UNKNOWN.
    IsNull: ({ field, negated }) => truth(isNullIn(row, field) !== negated),
    // F-AND-1 / F-AND-2: the folds, with TRUE and FALSE as identities.
    And: ({ members }) =>
      members.reduce<Truth>((acc, member) => AND[acc][evaluate(member, row)], "TRUE"),
    Or: ({ members }) =>
      members.reduce<Truth>((acc, member) => OR[acc][evaluate(member, row)], "FALSE"),
    // F-NOT-1.
    Not: ({ member }) => NOT[evaluate(member, row)],
  });

/**
 * §6.1 F-EVAL-3: a resource is in the primary data iff the root is TRUE.
 *
 * @internal
 */
export const matches = (node: Filter.Node, row: Row): boolean => evaluate(node, row) === "TRUE";
