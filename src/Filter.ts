/**
 * The JSON:API `filter` query family — the operator vocabulary and the
 * per-attribute declaration.
 *
 * The filter grammar fixes a **closed** operator vocabulary: the core,
 * `eq ne lt lte gt gte in nin isnull`, which `filter: true` declares, and the
 * opt-in text operators `contains startsWith endsWith` for string attributes.
 * This module names it once — as a schema ({@link Operator}) with typed
 * constants ({@link Op}) — so a resource's per-attribute declaration and the
 * URL codec agree byte for byte on what an operator is.
 * An app extends it per attribute with operators of its own ({@link operator}),
 * which decode to {@link Custom} nodes, and can spell filters in another
 * query syntax than the bracket grammar ({@link Dialect}).
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
 * `Query.Filter(resource)`. What a decoded tree *means* — the truth tables,
 * NULL handling, comparison domains and coercion — is the profile's §6; this
 * package builds and canonicalises trees, and evaluates none.
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
 *     status: Schema.Literals(["draft", "published"]).pipe(Filter.able()), // the whole core
 *     sku: Schema.String.pipe(Filter.able([Filter.Op.eq, Filter.Op.startsWith])) // a text operator, opted into
 *   }
 * })
 *
 * Resource.filterable(Product).priceCents.operators // ["eq", "gt", "lt"]
 * Resource.filterable(Product).status.operators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"]
 * Resource.filterable(Product).sku.operators // ["eq", "startsWith"]
 * Filter.isOperator("like") // false — the vocabulary is closed
 * ```
 *
 * @since 0.13.0
 */
import * as Arr from "effect/Array";
import { identity } from "effect/Function";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import type * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import type * as R from "effect/Record";
import { declarationError } from "./internal/errors.js";
import { render } from "./internal/json.js";
import type { FieldCodecs } from "./internal/filter.js";
import {
  bracket as bracketDialect,
  DialectTypeId as dialectTypeId,
  listCheck,
  literalEncoder,
  dialectFrom,
  operatorCheck,
  prepare,
} from "./internal/filter.js";
import {
  compareOperators,
  conjunctions,
  coreOperators as core,
  operators as vocabulary,
  resolveOperators,
  textOperators as text,
} from "./internal/operators.js";

// ---------------------------------------------------------------------------
// The vocabulary
// ---------------------------------------------------------------------------

/**
 * The filter operator vocabulary, as a schema: a `Schema.Literals` over the
 * closed vocabulary, in the grammar's order — the core (the six comparisons,
 * the two list memberships and the null test), then the three text operators.
 *
 *   - `eq` / `ne` / `lt` / `lte` / `gt` / `gte` compare against one literal;
 *   - `in` / `nin` test membership of a non-empty literal list;
 *   - `isnull` tests for `NULL` (`true`) or its absence (`false`). `NULL` is
 *     never a literal, so this is the only way to name it;
 *   - `contains` / `startsWith` / `endsWith` match a string attribute against
 *     one string fragment ({@link Text}). Declared only by name, never by
 *     `filter: true`, and only on an attribute whose encoded form is a string.
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
 * Filter.Operator.literals.length // 12
 * ```
 *
 * @since 0.13.0
 * @category schemas
 */
// The tuple lives in `internal/operators.ts` so the URL grammar engine reads
// the same list without importing this module (a cycle at module init).
export const Operator = Schema.Literals(vocabulary);

/**
 * A filter operator name — the decoded type of the {@link Operator} schema.
 *
 * @since 0.13.0
 * @category models
 */
export type Operator = typeof Operator.Type;

/**
 * The operator core — the comparisons, list memberships and the null test —
 * as a union of string literals: what `Filter.able()` and `filter: true`
 * declare.
 *
 * @since 0.24.0
 * @category models
 */
export type CoreOperator = (typeof core)[number];

/**
 * The operators of the core, in the grammar's order: what `Filter.able()` and
 * `filter: true` declare.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.coreOperators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"]
 * ```
 *
 * @since 0.24.0
 * @category constants
 */
export const coreOperators: ReadonlyArray<CoreOperator> = core;

/**
 * The text-matching operators, as a union of string literals.
 *
 * @since 0.24.0
 * @category models
 */
export type TextOperator = (typeof text)[number];

/**
 * The text-matching operators, in the grammar's order. Each matches a string
 * attribute against one string fragment, case-sensitively and by code point;
 * see {@link Text} for the semantics.
 *
 * @since 0.24.0
 * @category constants
 */
export const textOperators: ReadonlyArray<TextOperator> = text;

/**
 * Every filter operator, in the grammar's order — the literals of the
 * {@link Operator} schema.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.operators // ["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull", "contains", "startsWith", "endsWith"]
 * Filter.operators.length // 12
 * ```
 *
 * @since 0.13.0
 * @category constants
 */
export const operators: typeof Operator.literals = Operator.literals;

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
export const isOperator: (u: unknown) => u is Operator = Schema.is(Operator);

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
  isnull: "isnull",
  contains: "contains",
  startsWith: "startsWith",
  endsWith: "endsWith",
} as const satisfies { readonly [K in Operator]: K });

// ---------------------------------------------------------------------------
// Custom operators
// ---------------------------------------------------------------------------

/**
 * The brand of a {@link CustomOperator}.
 *
 * @since 0.24.0
 * @category symbols
 */
export const CustomOperatorTypeId = "~@thomasfosterau/effect-jsonapi/Filter/CustomOperator";

/**
 * The JSON scalar kinds an attribute's encoded form can take: what a
 * {@link CustomOperator}'s `appliesTo` names.
 *
 * @since 0.24.0
 * @category models
 */
export type ScalarKind = "string" | "number" | "boolean";

/**
 * The type-level stand-in for "the field's own literal type", carried by a
 * {@link CustomOperator} with no `literal` codec of its own. Never a value.
 *
 * @since 0.24.0
 * @category type-level
 */
export interface FieldLiteral {
  readonly _FieldLiteral: "FieldLiteral";
}

/**
 * An operator an app adds to the vocabulary — made with {@link operator},
 * declared on an attribute like a built-in (`Filter.able(["eq", like])`) and
 * carried in the AST as a {@link Custom} node.
 *
 *   - `name` is its spelling on the wire (`filter[title][like]=…`) and in the
 *     node's `op`;
 *   - `list` makes its value a comma list, as `in` / `nin` take;
 *   - `appliesTo` names the encoded kinds of attribute it may be declared on
 *     (`None`: any), checked when the resource is made;
 *   - `literal` decodes its literals (`None`: the field's own codec).
 *
 * What the operator *means* is the app's: the filter profile defines only
 * the built-ins, so a server answering a `Custom` node documents its own
 * semantics.
 *
 * @since 0.24.0
 * @category models
 */
export interface CustomOperator<
  Name extends string = string,
  List extends boolean = boolean,
  Literal = unknown,
> {
  readonly [CustomOperatorTypeId]: { readonly _Literal: (_: never) => Literal };
  readonly name: Name;
  readonly list: List;
  readonly appliesTo: Option.Option<Arr.NonEmptyReadonlyArray<ScalarKind>>;
  readonly literal: Option.Option<Schema.Codec<unknown, string>>;
}

/**
 * Any {@link CustomOperator}.
 *
 * @since 0.24.0
 * @category models
 */
export type AnyCustomOperator = CustomOperator;

const scalarKinds: ReadonlyArray<ScalarKind> = ["string", "number", "boolean"];
const OPERATOR_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Makes a custom filter operator: a `name` outside the built-in vocabulary
 * (letters, digits and `_`, starting with a letter), and options:
 *
 *   - `list: true` — the value is a non-empty literal list, like `in`'s;
 *   - `appliesTo` — the encoded kinds of attribute (`"string"`, `"number"`,
 *     `"boolean"`) it may be declared on; any attribute when omitted;
 *   - `literal` — a `Codec<Literal, string>` for its literals, when they are
 *     not the field's own (a pattern, a range, a distance).
 *
 * Declare it on an attribute as a built-in is declared, by passing the
 * operator itself in the list: `Filter.able(["eq", like])`. A node built with
 * {@link custom} carries it.
 *
 * Definition-time errors: a malformed name, a built-in or conjunction name,
 * and an empty or unknown `appliesTo`.
 *
 * @example
 * ```ts
 * import { Schema } from "effect"
 * import { strictEqual, deepStrictEqual } from "node:assert"
 * import { Filter, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * const like = Filter.operator("like", { appliesTo: ["string"] })
 * const Article = Resource.make("articles", {
 *   attributes: { title: Schema.String.pipe(Filter.able(["eq", like])) }
 * })
 *
 * const filter = Query.Filter(Article)
 * deepStrictEqual(Schema.decodeUnknownSync(filter)({ "filter[title][like]": "%effect%" }), {
 *   _tag: "Custom", op: "like", field: "title", value: "%effect%"
 * })
 * strictEqual(Schema.encodeSync(filter)(Filter.custom(like, "title", "a%"))["filter[title][like]"], "a%")
 * ```
 *
 * @since 0.24.0
 * @category constructors
 */
export function operator<const Name extends string, const List extends boolean = false>(
  name: Name,
  options?: {
    readonly list?: List;
    readonly appliesTo?: Arr.NonEmptyReadonlyArray<ScalarKind>;
    readonly literal?: never;
  },
): CustomOperator<Name, List, FieldLiteral>;
export function operator<const Name extends string, Literal, const List extends boolean = false>(
  name: Name,
  options: {
    readonly list?: List;
    readonly appliesTo?: Arr.NonEmptyReadonlyArray<ScalarKind>;
    readonly literal: Schema.Codec<Literal, string>;
  },
): CustomOperator<Name, List, Literal>;
export function operator(
  name: string,
  options?: {
    readonly list?: boolean;
    readonly appliesTo?: ReadonlyArray<ScalarKind>;
    readonly literal?: Schema.Codec<unknown, string>;
  },
): AnyCustomOperator {
  const subject = `Filter.operator(${render(name)})`;
  if (!OPERATOR_NAME.test(name)) {
    throw declarationError(
      `${subject}: an operator name is letters, digits and _, starting with a letter`,
    );
  }
  if (isOperator(name) || (conjunctions as ReadonlyArray<string>).includes(name)) {
    throw declarationError(`${subject}: the name is taken by the built-in vocabulary`);
  }
  const appliesTo = options?.appliesTo;
  if (
    appliesTo !== undefined &&
    (!Arr.isReadonlyArrayNonEmpty(appliesTo) ||
      !appliesTo.every((kind) => scalarKinds.includes(kind)))
  ) {
    throw declarationError(`${subject}: appliesTo names at least one of ${scalarKinds.join(", ")}`);
  }
  return {
    [CustomOperatorTypeId]: { _Literal: identity },
    name,
    list: options?.list ?? false,
    appliesTo: Option.fromUndefinedOr(appliesTo),
    literal: Option.fromUndefinedOr(options?.literal),
  };
}

/**
 * Whether a value is a {@link CustomOperator}.
 *
 * @since 0.24.0
 * @category guards
 */
export const isCustomOperator = (u: unknown): u is AnyCustomOperator =>
  P.hasProperty(u, CustomOperatorTypeId);

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
export const AnnotationId = "@thomasfosterau/effect-jsonapi/filter";

/**
 * The runtime value stored under {@link AnnotationId}: the declared operators
 * (normalised — `true` expanded to the core, duplicates dropped, order
 * kept) and the explicit literal codec, if one was given.
 *
 * @since 0.13.0
 * @category models
 */
export interface Annotation {
  /** The declared operators' names: built-ins, and any custom operators'. */
  readonly operators: ReadonlyArray<string>;
  readonly literal?: Schema.Codec<unknown, string>;
  /** The custom operators the declaration names, when it names any. */
  readonly custom?: ReadonlyArray<AnyCustomOperator>;
}

/**
 * The decoded type of a filter literal for an attribute schema: the schema's
 * own `Type`, minus `null` — `NULL` is never a literal (`isnull` names it), so
 * a `Schema.NullOr(X)` attribute's literals are `X`.
 *
 * @since 0.13.0
 * @category type-level
 */
export type LiteralType<S extends { readonly Type: unknown }> = Exclude<S["Type"], null>;

/**
 * The phantom property key carrying the filter declaration at the *type*
 * level. It is never present at runtime; it exists only so `Resource.FilterableKeys`
 * and `Resource.FilterOperators` can read an attribute's declaration from its
 * schema type.
 *
 * @since 0.13.0
 * @category type-level
 */
export type MarkerKey = "~@thomasfosterau/effect-jsonapi/filter";

/**
 * The type-level declaration carried under {@link MarkerKey}: the declared
 * operators as a union of string literals (custom operators by name), the
 * decoded literal type, and the custom operators declared.
 *
 * @since 0.13.0
 * @category type-level
 */
export interface Marker<Op extends string, Literal, Custom extends AnyCustomOperator = never> {
  readonly operators: Op;
  readonly literal: Literal;
  readonly custom: Custom;
}

/**
 * A schema declared filterable by {@link able}: the schema itself, tagged with
 * the type-level {@link Marker}. Structurally it *is* `S`, so it behaves as `S`
 * everywhere; only the declaration readers see the tag.
 *
 * @since 0.13.0
 * @category type-level
 */
export type Declared<
  S extends Schema.Top,
  Op extends string = Operator,
  Literal = LiteralType<S>,
  Custom extends AnyCustomOperator = never,
> = S & {
  readonly [K in MarkerKey]: Marker<Op, Literal, Custom>;
};

/**
 * What an {@link able} argument may name: a built-in {@link Operator}, or a
 * {@link CustomOperator}.
 *
 * @since 0.24.0
 * @category models
 */
export type Declarable = Operator | AnyCustomOperator;

/**
 * The operators an {@link able} argument admits, as a union of string
 * literals: every {@link CoreOperator} for `true` (or no argument), the
 * elements for an array (a custom operator by its name).
 *
 * @since 0.13.0
 * @category type-level
 */
export type OperatorsIn<D extends true | ReadonlyArray<Declarable>> = [D] extends [true]
  ? CoreOperator
  : D extends ReadonlyArray<infer Op extends Declarable>
    ? Op extends AnyCustomOperator
      ? Op["name"]
      : Op
    : never;

/**
 * The custom operators an {@link able} argument names, as a union.
 *
 * @since 0.24.0
 * @category type-level
 */
export type CustomsIn<D extends true | ReadonlyArray<Declarable>> =
  D extends ReadonlyArray<infer Op extends Declarable> ? Extract<Op, AnyCustomOperator> : never;

/**
 * Refuses, at the type level, a declaration of a {@link TextOperator} on a
 * schema whose decoded literal is not a string: `unknown` when `Op` names no
 * text operator, or the literal is a string or erased (`unknown`, left to the
 * runtime check), `never` otherwise.
 *
 * @since 0.24.0
 * @category type-level
 */
export type TextOnString<Op extends string, Literal> = [Extract<Op, TextOperator>] extends [never]
  ? unknown
  : unknown extends Literal
    ? unknown
    : [Literal] extends [string]
      ? unknown
      : never;

/**
 * Declares an attribute filterable — a pipeable combinator on the attribute's
 * schema, in the manner of `Schema.brand`:
 *
 *   - `Filter.able()` (or `Filter.able(true)`) admits the whole operator core;
 *   - `Filter.able(["eq", "gt"])` admits that subset, in the order given
 *     (duplicates dropped). Use {@link Op} to spell the operators as constants.
 *     The text operators (`contains`, `startsWith`, `endsWith`) are declared
 *     this way only, and only on a schema whose decoded type is a string.
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
 * explicit `Codec<Type, string>` (its `Type` must admit the attribute's). It
 * must not decode any wire string to `null`: NULL is never a literal, so a
 * filter that decodes to one is a 400 (and a tree holding one does not
 * encode); `isnull` names it.
 *
 * Definition-time errors: an empty array, an operator outside the
 * vocabulary (also a compile error), and — when the resource is made — a text
 * operator on an attribute whose encoded form is not a string (a compile error
 * too, when the decoded type is not a string).
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
 *     rating: Schema.NullOr(Schema.Finite.pipe(Filter.able(["gte", "isnull"])))
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
export function able<const Ops extends true | ReadonlyArray<Declarable> = true>(
  operators?: Ops,
  options?: { readonly literal?: never },
): <S extends Schema.Top>(
  self: S & TextOnString<OperatorsIn<Ops>, LiteralType<S>>,
) => Declared<S, OperatorsIn<Ops>, LiteralType<S>, CustomsIn<Ops>>;
export function able<const Ops extends true | ReadonlyArray<Declarable>, Literal>(
  operators: Ops,
  options: { readonly literal: Schema.Codec<Literal, string> },
): <S extends Schema.Top>(
  self: S & { readonly Type: Schema.NullOr<Schema.Schema<Literal>>["Type"] } & TextOnString<
      OperatorsIn<Ops>,
      Literal
    >,
) => Declared<S, OperatorsIn<Ops>, Literal, CustomsIn<Ops>>;
export function able(
  operators: true | ReadonlyArray<Declarable> = true,
  options?: { readonly literal?: Schema.Codec<unknown, string> },
): (self: Schema.Top) => Schema.Top {
  const annotation = annotationOf(
    operators,
    Option.fromUndefinedOr(options?.literal),
    "Filter.able",
  );
  return (self) => self.annotate({ [AnnotationId]: annotation });
}

/**
 * The {@link Annotation} a declaration stamps: the operators by name, checked
 * against the vocabulary and the custom operators it names, which must not
 * reuse one name for two operators.
 */
const annotationOf = (
  operators: true | ReadonlyArray<Declarable>,
  literal: Option.Option<Schema.Codec<unknown, string>>,
  subject: string,
): Annotation => {
  const custom: Array<AnyCustomOperator> = [];
  const names =
    operators === true
      ? operators
      : Arr.map(operators, (entry) => {
          if (!isCustomOperator(entry)) return entry;
          const same = custom.find((known) => known.name === entry.name);
          if (same === undefined) custom.push(entry);
          else if (same !== entry) {
            throw declarationError(
              `${subject} declares two custom operators named ${render(entry.name)}`,
            );
          }
          return entry.name;
        });
  const allowed = Arr.isArrayNonEmpty(custom)
    ? Schema.Literals([...vocabulary, ...custom.map((entry) => entry.name)])
    : Operator;
  const resolved: ReadonlyArray<string> = resolveOperators(names, allowed, subject, core);
  const declared: Annotation = Option.match(literal, {
    onNone: () => ({ operators: resolved }),
    onSome: (codec) => ({ operators: resolved, literal: codec }),
  });
  return Arr.isArrayNonEmpty(custom) ? { ...declared, custom } : declared;
};

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
export type CompareOperator = (typeof compareOperators)[number];

/**
 * The field vocabulary a filter AST is typed over: each declared field name to
 * its decoded literal type. `Query.Filter(resource)` builds it from
 * `Resource.filterable`; the untyped {@link Node} uses the widest one.
 *
 * @since 0.13.0
 * @category models
 */
export type FieldTypes = R.ReadonlyRecord<string, unknown>;

/**
 * A comparison of one field against one typed literal.
 *
 * @since 0.13.0
 * @category models
 */
export interface Compare<Field extends string = string, Literal = unknown> {
  readonly _tag: "Compare";
  readonly op: CompareOperator;
  readonly field: Field;
  readonly value: Literal;
}

/**
 * Membership of one field's value in a non-empty list of typed literals.
 *
 * @since 0.13.0
 * @category models
 */
export interface In<Field extends string = string, Literal = unknown> {
  readonly _tag: "In";
  readonly field: Field;
  readonly values: readonly [Literal, ...Array<Literal>];
}

/**
 * Non-membership of one field's value in a non-empty list of typed literals.
 *
 * @since 0.13.0
 * @category models
 */
export interface NotIn<Field extends string = string, Literal = unknown> {
  readonly _tag: "NotIn";
  readonly field: Field;
  readonly values: readonly [Literal, ...Array<Literal>];
}

/**
 * A text match of one string field against one string fragment: `contains`
 * (the fragment occurs anywhere in the value), `startsWith` (it is a prefix)
 * or `endsWith` (a suffix). The fragment is the wire string itself, unescaped
 * — never decoded through the field's schema, since a fragment of a valid
 * value need not be one.
 *
 * The profile's semantics: matching is case-sensitive and by code point, with
 * no Unicode normalisation or collation; the empty fragment matches every
 * value; a NULL value gives UNKNOWN, as every comparison does.
 *
 * @since 0.24.0
 * @category models
 */
export interface Text<Field extends string = string> {
  readonly _tag: "Text";
  readonly op: TextOperator;
  readonly field: Field;
  readonly value: string;
}

/**
 * The null test: `IS NULL` (`negated: false`) or `IS NOT NULL` (`negated:
 * true`). `NULL` is never a literal, so this is the only way to name it.
 *
 * @since 0.13.0
 * @category models
 */
export interface IsNull<Field extends string = string> {
  readonly _tag: "IsNull";
  readonly field: Field;
  readonly negated: boolean;
}

/**
 * A condition under a {@link CustomOperator}: `op` is the operator's name,
 * `value` one literal — or a non-empty list, for a `list` operator — of the
 * operator's literal type (the field's own, unless it has a codec of its
 * own). The filter profile gives it no meaning; the app defines it.
 *
 * @since 0.24.0
 * @category models
 */
export interface Custom<
  Field extends string = string,
  Op extends string = string,
  Value = unknown,
> {
  readonly _tag: "Custom";
  readonly op: Op;
  readonly field: Field;
  readonly value: Value;
}

/**
 * The {@link Custom} nodes a field's declared custom operators admit, over the
 * field's literal type.
 *
 * @since 0.24.0
 * @category type-level
 */
export type CustomNodes<Field extends string, C extends AnyCustomOperator, FieldType> =
  C extends CustomOperator<infer Name, infer List, infer Literal>
    ? Custom<
        Field,
        Name,
        ([Literal] extends [FieldLiteral] ? FieldType : Literal) extends infer V
          ? List extends true
            ? readonly [V, ...Array<V>]
            : V
          : never
      >
    : never;

/**
 * A conjunction. Members are a set: order carries no meaning, and the codec
 * sorts them. `And([])` is "true".
 *
 * @since 0.13.0
 * @category models
 */
export interface And<
  Fields extends FieldTypes = FieldTypes,
  TextFields extends string = never,
  Customs extends Custom = never,
> {
  readonly _tag: "And";
  readonly members: ReadonlyArray<Ast<Fields, TextFields, Customs>>;
}

/**
 * A disjunction. Members are a set: order carries no meaning, and the codec
 * sorts them. `Or([])` is "false".
 *
 * @since 0.13.0
 * @category models
 */
export interface Or<
  Fields extends FieldTypes = FieldTypes,
  TextFields extends string = never,
  Customs extends Custom = never,
> {
  readonly _tag: "Or";
  readonly members: ReadonlyArray<Ast<Fields, TextFields, Customs>>;
}

/**
 * A negation of exactly one member of any kind. `Not(Not(x))` is a legal tree
 * and encodes as two nested groups; the codec does not simplify it.
 *
 * @since 0.13.0
 * @category models
 */
export interface Not<
  Fields extends FieldTypes = FieldTypes,
  TextFields extends string = never,
  Customs extends Custom = never,
> {
  readonly _tag: "Not";
  readonly member: Ast<Fields, TextFields, Customs>;
}

/**
 * The condition nodes of a filter AST over a field vocabulary: for each
 * declared field, a {@link Compare}, {@link In}, {@link NotIn} or
 * {@link IsNull} whose `field` is that name and whose literals are that
 * field's type — and, for a field named in `TextFields` (the fields declaring
 * a text operator; none by default), a {@link Text}. `Customs` adds the
 * {@link Custom} nodes the fields' custom operators admit (none by default).
 *
 * @since 0.13.0
 * @category models
 */
export type Condition<
  Fields extends FieldTypes = FieldTypes,
  TextFields extends string = never,
  Customs extends Custom = never,
> =
  | {
      readonly [F in keyof Fields & string]:
        | Compare<F, Fields[F]>
        | In<F, Fields[F]>
        | NotIn<F, Fields[F]>
        | IsNull<F>
        | (F extends TextFields ? Text<F> : never);
    }[keyof Fields & string]
  | Customs;

/**
 * The filter AST: an initial encoding — plain data, no methods — that every
 * consumer pattern-matches on. `Fields` narrows `field` to the declared names
 * and each literal to its field's decoded type, so over a resource the type is
 * `Compare<"age", number> | Compare<"title", string> | …`. `TextFields` names
 * the fields a {@link Text} node may test — those that declare a text
 * operator; none by default, and `Query.FilterAst` fills it in from the
 * resource. The decoded `filter` of a query is one root node.
 *
 * The AST itself carries no evaluator — it is plain data. What a tree
 * *means*, though, is not open: the filter profile defines it, operator by
 * operator, in its §6 (three-valued logic, the NULL
 * rules, the comparison domains and the coercion rules). A server that
 * advertises {@link PROFILE_URI} answers according to those tables.
 *
 * @since 0.13.0
 * @category models
 */
export type Ast<
  Fields extends FieldTypes = FieldTypes,
  TextFields extends string = never,
  Customs extends Custom = never,
> =
  | Condition<Fields, TextFields, Customs>
  | And<Fields, TextFields, Customs>
  | Or<Fields, TextFields, Customs>
  | Not<Fields, TextFields, Customs>;

/**
 * The untyped filter AST: any field name, any literal. What the runtime
 * {@link Ast} schema validates.
 *
 * @since 0.13.0
 * @category models
 */
export type Node = Ast<FieldTypes, string, Custom>;

const Literal = Schema.Unknown;
const LazyNode: Schema.Codec<Node> = Schema.suspend((): Schema.Codec<Node> => Ast);
const CompareNode = Schema.TaggedStruct("Compare", {
  op: Schema.Literals(compareOperators),
  field: Schema.String,
  value: Literal,
});
const InNode = Schema.TaggedStruct("In", {
  field: Schema.String,
  values: Schema.NonEmptyArray(Literal),
});
const NotInNode = Schema.TaggedStruct("NotIn", {
  field: Schema.String,
  values: Schema.NonEmptyArray(Literal),
});
const TextNode = Schema.TaggedStruct("Text", {
  op: Schema.Literals(text),
  field: Schema.String,
  value: Schema.String,
});
const CustomNode = Schema.TaggedStruct("Custom", {
  op: Schema.String,
  field: Schema.String,
  value: Literal,
});
const IsNullNode = Schema.TaggedStruct("IsNull", {
  field: Schema.String,
  negated: Schema.Boolean,
});
const AndNode = Schema.TaggedStruct("And", { members: Schema.Array(LazyNode) });
const OrNode = Schema.TaggedStruct("Or", { members: Schema.Array(LazyNode) });
const NotNode = Schema.TaggedStruct("Not", { member: LazyNode });

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
  CompareNode,
  InNode,
  NotInNode,
  TextNode,
  CustomNode,
  IsNullNode,
  AndNode,
  OrNode,
  NotNode,
]);

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

const compare =
  <Op extends CompareOperator>(op: Op) =>
  <const Field extends string, const Literal>(
    field: Field,
    value: Literal,
  ): Compare<Field, Literal> => ({
    _tag: "Compare",
    op,
    field,
    value,
  });

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
export const eq = compare("eq");

/**
 * `field ≠ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const ne = compare("ne");

/**
 * `field < value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const lt = compare("lt");

/**
 * `field ≤ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const lte = compare("lte");

/**
 * `field > value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const gt = compare("gt");

/**
 * `field ≥ value`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const gte = compare("gte");

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
  values: readonly [Literal, ...Array<Literal>],
): In<Field, Literal> => ({ _tag: "In", field, values });

/**
 * `field NOT IN (values)` — at least one value.
 *
 * @since 0.13.0
 * @category constructors
 */
export const notIn = <const Field extends string, const Literal>(
  field: Field,
  values: readonly [Literal, ...Array<Literal>],
): NotIn<Field, Literal> => ({ _tag: "NotIn", field, values });

const textMatch =
  <Op extends TextOperator>(op: Op) =>
  <const Field extends string>(field: Field, value: string): Text<Field> => ({
    _tag: "Text",
    op,
    field,
    value,
  });

/**
 * `field` contains the fragment `value` (case-sensitive). The field must
 * declare `contains`.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * Filter.contains("title", "effect") // { _tag: "Text", op: "contains", field: "title", value: "effect" }
 * ```
 *
 * @since 0.24.0
 * @category constructors
 */
export const contains = textMatch("contains");

/**
 * `field` starts with the fragment `value` (case-sensitive). The field must
 * declare `startsWith`.
 *
 * @since 0.24.0
 * @category constructors
 */
export const startsWith = textMatch("startsWith");

/**
 * `field` ends with the fragment `value` (case-sensitive). The field must
 * declare `endsWith`.
 *
 * @since 0.24.0
 * @category constructors
 */
export const endsWith = textMatch("endsWith");

/**
 * A condition under a custom operator ({@link operator}): `value` is one
 * literal, or a non-empty list for a `list` operator.
 *
 * @example
 * ```ts
 * import { Filter } from "@thomasfosterau/effect-jsonapi"
 *
 * const near = Filter.operator("near", { list: true })
 * Filter.custom(near, "location", ["51.5", "-0.1"])
 * // { _tag: "Custom", op: "near", field: "location", value: ["51.5", "-0.1"] }
 * ```
 *
 * @since 0.24.0
 * @category constructors
 */
export const custom = <
  const C extends AnyCustomOperator,
  const Field extends string,
  const Value extends (C["list"] extends true ? readonly [unknown, ...Array<unknown>] : unknown),
>(
  operator: C,
  field: Field,
  value: Value,
): Custom<Field, C["name"], Value> => ({ _tag: "Custom", op: operator.name, field, value });

/**
 * `field IS NULL`, or `IS NOT NULL` when `negated`.
 *
 * @since 0.13.0
 * @category constructors
 */
export const isNull = <const Field extends string>(
  field: Field,
  negated: boolean = false,
): IsNull<Field> => ({
  _tag: "IsNull",
  field,
  negated,
});

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
export const and = <const Members extends ReadonlyArray<Node>>(...members: Members) =>
  ({ _tag: "And", members }) as const;

/**
 * A disjunction of any number of members.
 *
 * @since 0.13.0
 * @category constructors
 */
export const or = <const Members extends ReadonlyArray<Node>>(...members: Members) =>
  ({ _tag: "Or", members }) as const;

/**
 * The negation of one member.
 *
 * @since 0.13.0
 * @category constructors
 */
export const not = <const Member extends Node>(member: Member) =>
  ({ _tag: "Not", member }) as const;

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
    readonly literal: Schema.Top;
    /** When present, each condition's operator is checked against it. */
    readonly operators?: ReadonlyArray<string>;
    /** The field's custom operators, whose own literal codecs apply. */
    readonly custom?: ReadonlyArray<AnyCustomOperator>;
  };
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
 *     age: Resource.attribute(Schema.Finite, { filter: true })
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
  prepare(
    node,
    literalEncoder(fields as FieldCodecs),
    operatorCheck(fields),
    listCheck(fields as FieldCodecs),
  ).node as N;

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

/**
 * The brand of a {@link Dialect}.
 *
 * @since 0.24.0
 * @category symbols
 */
export const DialectTypeId: typeof dialectTypeId = dialectTypeId;

/**
 * One rejection a {@link Dialect} reports: its `message`, the query `key` it
 * points at (the 400's `source.parameter`; the whole family when absent) and
 * the offending value.
 *
 * @since 0.24.0
 * @category models
 */
export interface DialectIssue {
  readonly message: string;
  readonly key?: string;
  readonly actual?: string | ReadonlyArray<string>;
}

/**
 * The query keys a condition's members were read from, for the issues a
 * {@link DialectContext} reports. A single key stands for all three.
 *
 * @since 0.24.0
 * @category models
 */
export interface ConditionSource {
  readonly field: string;
  readonly operator: string;
  readonly value: string;
}

/**
 * What a {@link Dialect}'s decoder is handed alongside the query: the
 * resource's filter declaration, under the fields' wire names, and the one
 * check every condition goes through.
 *
 *   - `operators(field)` — the operators a field declares; `None` for a
 *     field that is not filterable;
 *   - `isOperator(name)` — whether a name is in the vocabulary (the
 *     built-ins, and the custom operators any field declares);
 *   - `isList(field, operator)` — whether the operator takes a literal list
 *     (`in`, `nin`, or a `list` custom operator);
 *   - `condition` — checks one condition (the field, the operator against
 *     its declaration, the arity, each wire literal through its codec) and
 *     returns its node, or the issue, pointed at `source`, that every dialect
 *     rejects it with.
 *
 * @since 0.24.0
 * @category models
 */
export interface DialectContext {
  readonly operators: (field: string) => Option.Option<ReadonlyArray<string>>;
  readonly isOperator: (name: string) => boolean;
  readonly isList: (field: string, operator: string) => boolean;
  readonly condition: (
    condition: {
      readonly field: string;
      readonly operator: string;
      readonly values: ReadonlyArray<string>;
    },
    source: string | ConditionSource,
  ) => Result.Result<Node, DialectIssue>;
}

/**
 * One condition of a {@link WireNode}: a field's wire name, the operator's
 * name and its literals as wire strings (unescaped), in normal-form order.
 * `isnull` carries `"true"` or `"false"`.
 *
 * @since 0.24.0
 * @category models
 */
export interface WireCondition {
  readonly _tag: "Condition";
  readonly field: string;
  readonly operator: string;
  readonly values: Arr.NonEmptyReadonlyArray<string>;
}

/**
 * One group of a {@link WireNode}: `NOT` has exactly one member.
 *
 * @since 0.24.0
 * @category models
 */
export interface WireGroup {
  readonly _tag: "Group";
  readonly conjunction: "AND" | "OR" | "NOT";
  readonly members: ReadonlyArray<WireNode>;
}

/**
 * The tree a {@link Dialect} encodes: a normal-form filter with every literal
 * already encoded to its wire string, so a dialect spells a tree without
 * knowing any codec.
 *
 * @since 0.24.0
 * @category models
 */
export type WireNode = WireCondition | WireGroup;

/**
 * A filter query syntax: how `filter` family keys spell a tree. The
 * {@link bracket} grammar is the default; an app can supply another — an
 * expression syntax in the bare `filter` key, say — and keep everything
 * `Query.schema` derives from the declaration: the typed AST, the checks on
 * fields, operators and literals, and the 400s naming the key.
 *
 *   - `decode` reads the query's `filter` family keys (the bare `filter` and
 *     every `filter[…]`, each a string or a repeated key's strings) and builds
 *     a tree, checking each condition through the {@link DialectContext}. It
 *     fails with one {@link DialectIssue} per offending key. The tree is put in
 *     normal form afterwards.
 *   - `encode` spells a normal-form {@link WireNode} as `filter` family keys.
 *     Emitting the same keys for the same tree makes URLs canonical.
 *
 * The filter profile ({@link PROFILE_URI}) describes the bracket grammar: an
 * endpoint on another dialect should not advertise it.
 *
 * @since 0.24.0
 * @category models
 */
export interface Dialect {
  readonly [DialectTypeId]: typeof DialectTypeId;
  /** A name for the dialect, for diagnostics. */
  readonly name: string;
  readonly decode: (
    input: R.ReadonlyRecord<string, string | ReadonlyArray<string>>,
    context: DialectContext,
  ) => Result.Result<Node, Arr.NonEmptyReadonlyArray<DialectIssue>>;
  readonly encode: (root: WireNode) => R.ReadonlyRecord<string, string>;
}

/**
 * Makes a {@link Dialect} from its name, decoder and encoder. Pass it as a
 * query's `filter` option (`Endpoint.list(Article, { filter: dialect })`) or
 * to `Query.Filter(resource, { dialect })`.
 *
 * @example
 * ```ts
 * import { Result, Schema } from "effect"
 * import { deepStrictEqual } from "node:assert"
 * import { Filter, Query, Resource } from "@thomasfosterau/effect-jsonapi"
 *
 * // `filter=status:open`: one `field:value` equality in the bare key.
 * const colon = Filter.dialect({
 *   name: "colon",
 *   decode: (input, context) => {
 *     const raw = input["filter"]
 *     const [field = "", value = ""] = typeof raw === "string" ? raw.split(":") : []
 *     return Result.mapError(
 *       context.condition({ field, operator: "eq", values: [value] }, "filter"),
 *       (issue) => [issue] as const
 *     )
 *   },
 *   encode: (root): Record<string, string> =>
 *     root._tag === "Condition" ? { filter: `${root.field}:${root.values[0]}` } : {}
 * })
 *
 * const Article = Resource.make("articles", {
 *   attributes: { status: Schema.String.pipe(Filter.able(["eq"])) }
 * })
 * const filter = Query.Filter(Article, { dialect: colon })
 * deepStrictEqual(Schema.decodeUnknownSync(filter)({ filter: "status:open" }), Filter.eq("status", "open"))
 * deepStrictEqual(Schema.encodeSync(filter)(Filter.eq("status", "done")), { filter: "status:done" })
 * ```
 *
 * @since 0.24.0
 * @category constructors
 */
export const dialect: (definition: {
  readonly name: string;
  readonly decode: Dialect["decode"];
  readonly encode: Dialect["encode"];
}) => Dialect = dialectFrom;

/**
 * Whether a value is a {@link Dialect}.
 *
 * @since 0.24.0
 * @category guards
 */
export const isDialect = (u: unknown): u is Dialect => P.hasProperty(u, DialectTypeId);

/**
 * The bracket grammar of the filter profile, the default {@link Dialect}:
 * the shorthand (`filter[f]=v`, `filter[f]=a,b`, `filter[f][op]=v`) and the
 * group form (`filter[id][group][conjunction]=OR`,
 * `filter[id][condition][path]=…`), with `\,` and `\\` escapes.
 *
 * @since 0.24.0
 * @category constants
 */
export const bracket: Dialect = bracketDialect;

// ---------------------------------------------------------------------------
// Profile (design §5)
// ---------------------------------------------------------------------------

/**
 * The JSON:API profile URI of the filter grammar, version 1. Servers that
 * implement the grammar advertise it on the media type of their responses:
 * `Content-Type: application/vnd.api+json; profile="…"`. Pass it in an
 * endpoint's `profiles` option to have the endpoint do so. Nothing about request
 * handling keys off it — an endpoint declared with `filter: true` speaks the
 * grammar whether or not the client names the profile.
 *
 * The profile has two halves: the URL surface,
 * operator core and canonical encoding (§1–§4), and the **semantics** (§6) —
 * three-valued logic, the per-operator truth tables, the comparison domains
 * and the coercion rules. Advertising the URI is a claim to answer according
 * to §6.
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
export const PROFILE_URI =
  "https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1";
