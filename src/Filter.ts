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
 * It also holds the filter **AST** (design §1) — {@link Ast}, its node
 * types and constructors, the runtime {@link Ast} schema — its normal form
 * ({@link normalise}, design §3.2) and the grammar's profile URI
 * ({@link PROFILE_URI}). The URL codec over a resource's declaration is
 * `Query.Filter(resource)`.
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
import type { FieldCodecs } from "./internal/filter.js"
import { literalEncoder, operatorCheck, prepare } from "./internal/filter.js"
import { compareOperators, operators as vocabulary, resolveOperators } from "./internal/operators.js"

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
// The tuple lives in `internal/operators.ts` so the URL grammar engine reads
// the same list without importing this module (a cycle at module init).
export const Operator = Schema.Literals(vocabulary)

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

// ---------------------------------------------------------------------------
// The AST (design §1)
// ---------------------------------------------------------------------------

/**
 * The operators of a {@link Compare} node: the six comparisons against one
 * literal.
 *
 * @since 0.13.0
 * @category models
 */
export type CompareOperator = (typeof compareOperators)[number]

/**
 * The field vocabulary a filter AST is typed over: each declared field name to
 * its decoded literal type. `Query.Filter(resource)` builds it from
 * `Resource.filterable`; the untyped {@link Node} uses the widest one.
 *
 * @since 0.13.0
 * @category models
 */
export interface FieldTypes {
  readonly [field: string]: unknown
}

/**
 * A comparison of one field against one typed literal.
 *
 * @since 0.13.0
 * @category models
 */
export interface Compare<Field extends string = string, Literal = unknown> {
  readonly _tag: "Compare"
  readonly op: CompareOperator
  readonly field: Field
  readonly value: Literal
}

/**
 * Membership of one field's value in a non-empty list of typed literals.
 *
 * @since 0.13.0
 * @category models
 */
export interface In<Field extends string = string, Literal = unknown> {
  readonly _tag: "In"
  readonly field: Field
  readonly values: readonly [Literal, ...Array<Literal>]
}

/**
 * Non-membership of one field's value in a non-empty list of typed literals.
 *
 * @since 0.13.0
 * @category models
 */
export interface NotIn<Field extends string = string, Literal = unknown> {
  readonly _tag: "NotIn"
  readonly field: Field
  readonly values: readonly [Literal, ...Array<Literal>]
}

/**
 * The null test: `IS NULL` (`negated: false`) or `IS NOT NULL` (`negated:
 * true`). `NULL` is never a literal, so this is the only way to name it.
 *
 * @since 0.13.0
 * @category models
 */
export interface IsNull<Field extends string = string> {
  readonly _tag: "IsNull"
  readonly field: Field
  readonly negated: boolean
}

/**
 * A conjunction. Members are a set: order carries no meaning, and the codec
 * sorts them. `And([])` is "true".
 *
 * @since 0.13.0
 * @category models
 */
export interface And<Fields extends FieldTypes = FieldTypes> {
  readonly _tag: "And"
  readonly members: ReadonlyArray<Ast<Fields>>
}

/**
 * A disjunction. Members are a set: order carries no meaning, and the codec
 * sorts them. `Or([])` is "false".
 *
 * @since 0.13.0
 * @category models
 */
export interface Or<Fields extends FieldTypes = FieldTypes> {
  readonly _tag: "Or"
  readonly members: ReadonlyArray<Ast<Fields>>
}

/**
 * A negation of exactly one member of any kind. `Not(Not(x))` is a legal tree
 * and encodes as two nested groups; the codec does not simplify it.
 *
 * @since 0.13.0
 * @category models
 */
export interface Not<Fields extends FieldTypes = FieldTypes> {
  readonly _tag: "Not"
  readonly member: Ast<Fields>
}

/**
 * The condition nodes of a filter AST over a field vocabulary: for each
 * declared field, a {@link Compare}, {@link In}, {@link NotIn} or
 * {@link IsNull} whose `field` is that name and whose literals are that
 * field's type.
 *
 * @since 0.13.0
 * @category models
 */
export type Condition<Fields extends FieldTypes = FieldTypes> = {
  readonly [F in keyof Fields & string]: Compare<F, Fields[F]> | In<F, Fields[F]> | NotIn<F, Fields[F]> | IsNull<F>
}[keyof Fields & string]

/**
 * The filter AST: an initial encoding — plain data, no methods — that every
 * consumer pattern-matches on. `Fields` narrows `field` to the declared names
 * and each literal to its field's decoded type, so over a resource the type is
 * `Compare<"age", number> | Compare<"title", string> | …`. The decoded
 * `filter` of a query is one root node.
 *
 * The AST carries no semantics: what a tree *means* (NULL handling,
 * collation, coercion) is the interpreter's business.
 *
 * @since 0.13.0
 * @category models
 */
export type Ast<Fields extends FieldTypes = FieldTypes> = Condition<Fields> | And<Fields> | Or<Fields> | Not<Fields>

/**
 * The untyped filter AST: any field name, any literal. What the runtime
 * {@link Ast} schema validates.
 *
 * @since 0.13.0
 * @category models
 */
export type Node = Ast<FieldTypes>

const Literal = Schema.Unknown
const NodeSchema: Schema.Codec<Node> = Schema.suspend((): Schema.Codec<Node> => Ast)
const CompareSchema = Schema.TaggedStruct("Compare", {
  op: Schema.Literals(compareOperators),
  field: Schema.String,
  value: Literal
})
const InSchema = Schema.TaggedStruct("In", { field: Schema.String, values: Schema.NonEmptyArray(Literal) })
const NotInSchema = Schema.TaggedStruct("NotIn", { field: Schema.String, values: Schema.NonEmptyArray(Literal) })
const IsNullSchema = Schema.TaggedStruct("IsNull", { field: Schema.String, negated: Schema.Boolean })
const AndSchema = Schema.TaggedStruct("And", { members: Schema.Array(NodeSchema) })
const OrSchema = Schema.TaggedStruct("Or", { members: Schema.Array(NodeSchema) })
const NotSchema = Schema.TaggedStruct("Not", { member: NodeSchema })

/**
 * The runtime schema of the untyped AST ({@link Node}): validates a tree's
 * shape — tags, operators, non-empty `In` / `NotIn` lists, recursion — with
 * literals left open, since their types come from the resource declaration.
 * Use it to validate a tree from an untrusted source before interpreting it;
 * `Query.Filter(resource)` is the typed codec.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Schema.decodeUnknownSync(Filter.Ast)({ _tag: "Compare", op: "gt", field: "age", value: 18 })
 * // → { _tag: "Compare", op: "gt", field: "age", value: 18 }
 * Schema.is(Filter.Ast)({ _tag: "In", field: "status", values: [] }) // false — lists are non-empty
 * ```
 *
 * @since 0.13.0
 * @category schemas
 */
export const Ast: Schema.Codec<Node> = Schema.Union([
  CompareSchema,
  InSchema,
  NotInSchema,
  IsNullSchema,
  AndSchema,
  OrSchema,
  NotSchema
]) as unknown as Schema.Codec<Node>

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const compare =
  <Op extends CompareOperator>(op: Op) =>
  <const Field extends string, const Literal>(field: Field, value: Literal): Compare<Field, Literal> => ({
    _tag: "Compare",
    op,
    field,
    value
  })

/**
 * `field = value`.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.eq("status", "open") // { _tag: "Compare", op: "eq", field: "status", value: "open" }
 * ```
 *
 * @since 0.13.0
 * @category constructors
 */
export const eq = compare("eq")

/**
 * `field ≠ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const ne = compare("ne")

/**
 * `field < value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const lt = compare("lt")

/**
 * `field ≤ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const lte = compare("lte")

/**
 * `field > value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const gt = compare("gt")

/**
 * `field ≥ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const gte = compare("gte")

/**
 * `field IN (values)` — at least one value.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.isIn("priority", [1, 2]) // { _tag: "In", field: "priority", values: [1, 2] }
 * ```
 *
 * @since 0.13.0
 * @category constructors
 */
export const isIn = <const Field extends string, const Literal>(
  field: Field,
  values: readonly [Literal, ...Array<Literal>]
): In<Field, Literal> => ({ _tag: "In", field, values })

/**
 * `field NOT IN (values)` — at least one value.
 *
 * @since 0.13.0
 * @category constructors
 */
export const notIn = <const Field extends string, const Literal>(
  field: Field,
  values: readonly [Literal, ...Array<Literal>]
): NotIn<Field, Literal> => ({ _tag: "NotIn", field, values })

/**
 * `field IS NULL`, or `IS NOT NULL` when `negated`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const isNull = <const Field extends string>(field: Field, negated: boolean = false): IsNull<Field> => ({
  _tag: "IsNull",
  field,
  negated
})

/**
 * A conjunction of any number of members. The members' own types are kept, so
 * the result is an {@link And} of whichever field vocabulary they draw on.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.and(Filter.eq("status", "open"), Filter.gt("age", 18))
 * // { _tag: "And", members: [ …eq…, …gt… ] }
 * ```
 *
 * @since 0.13.0
 * @category constructors
 */
export const and = <const Members extends ReadonlyArray<Node>>(
  ...members: Members
): { readonly _tag: "And"; readonly members: Members } => ({ _tag: "And", members })

/**
 * A disjunction of any number of members.
 *
 * @since 0.13.0
 * @category constructors
 */
export const or = <const Members extends ReadonlyArray<Node>>(
  ...members: Members
): { readonly _tag: "Or"; readonly members: Members } => ({ _tag: "Or", members })

/**
 * The negation of one member.
 *
 * @since 0.13.0
 * @category constructors
 */
export const not = <const Member extends Node>(member: Member): { readonly _tag: "Not"; readonly member: Member } => ({
  _tag: "Not",
  member
})

// ---------------------------------------------------------------------------
// Normal form (design §3.2)
// ---------------------------------------------------------------------------

/**
 * The per-field literal codecs {@link normalise} sorts by: what
 * `Resource.filterable(resource)` returns, or any record of `{ literal }`
 * entries whose `literal` encodes the field's decoded literal to its wire
 * string.
 *
 * @since 0.13.0
 * @category models
 */
export interface LiteralCodecs {
  readonly [field: string]: {
    readonly literal: Schema.Top
    /** When present, each condition's operator is checked against it. */
    readonly operators?: ReadonlyArray<string> | undefined
  }
}

/**
 * Puts a tree in normal form: `In` / `NotIn` values sorted by their encoded
 * wire string (code-point order) and deduplicated, `And` / `Or` members sorted
 * by the node order — conditions before groups; conditions by field, operator,
 * then encoded value; groups by conjunction (`AND` < `NOT` < `OR`), then
 * members pairwise — and deduplicated. The literal codecs come from the
 * resource's declaration, since the order is over *encoded* strings.
 *
 * Decoding always returns normal form, and encoding normalises first, so a
 * hand-built tree encodes canonically without calling this; it is for
 * comparing trees structurally. Throws for an unknown field, an operator the
 * field does not declare (when the record carries `operators`, as
 * `Resource.filterable` does), a literal the codec refuses, or an empty `In` /
 * `NotIn` list.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { Filter, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const Article = Resource.make("articles", {
 *   attributes: {
 *     status: Resource.attribute(Schema.String, { filter: true }),
 *     age: Resource.attribute(Schema.Number, { filter: true })
 *   }
 * })
 *
 * Filter.normalise(
 *   Filter.and(Filter.eq("status", "open"), Filter.isIn("age", [3, 1, 3])),
 *   Resource.filterable(Article)
 * )
 * // → And([In("age", [1, 3]), Compare(eq, "status", "open")])
 * ```
 *
 * @since 0.13.0
 * @category combinators
 */
export const normalise = <N extends Node>(node: N, fields: LiteralCodecs): N =>
  prepare(node, literalEncoder(fields as FieldCodecs), operatorCheck(fields)).node as N

// ---------------------------------------------------------------------------
// Profile (design §5)
// ---------------------------------------------------------------------------

/**
 * The JSON:API profile URI of the filter grammar, version 1. Servers that
 * implement the grammar advertise it on the media type of their responses:
 * `Content-Type: application/vnd.api+json; profile="…"`. Nothing about request
 * handling keys off it — an endpoint declared with `filter: true` speaks the
 * grammar whether or not the client names the profile.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * const contentType = `application/vnd.api+json; profile="${Filter.PROFILE_URI}"`
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const PROFILE_URI = "https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1"
