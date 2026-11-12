/**
 * The `filter` URL grammar engine: flat `filter[...]` keys ↔ the filter AST,
 * per `docs/filter-grammar.md` §2 (surface syntax) and §3 (canonical
 * encoding). `Filter.ts` and `Query.ts` expose it.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import type { Compare, Node } from "../Filter.js";
import { conjunctions, listOperators, nullOperator, operators } from "./operators.js";
import { render } from "./json.js";

// ---------------------------------------------------------------------------
// The per-field declaration the engine reads
// ---------------------------------------------------------------------------

/**
 * One filterable field, as the engine needs it: the operators it admits and
 * the codec between a wire string and the decoded literal. Structurally the
 * runtime shape of a `Resource.Filterable` entry.
 */
export interface FieldCodec {
  readonly operators: ReadonlyArray<string>;
  readonly literal: Schema.Top;
}

/** The filterable fields of a resource, keyed by field name. */
export interface FieldCodecs {
  readonly [field: string]: FieldCodec;
}

/**
 * A field, operator, literal or node the engine refuses. A `Schema.TaggedError`
 * is an `Error`, so the callers that turn a throw into a schema issue read its
 * `message` unchanged.
 */
class InvalidFilter extends Schema.TaggedError<InvalidFilter, { readonly brand: unique symbol }>()(
  "InvalidFilter",
  {
    message: Schema.String,
  },
) {}

// A field's declaration, or `undefined` when the field is undeclared. Only an
// own entry counts: the declaration is a plain object (`Resource.filterable`)
// and the field name comes from the request, so `constructor`, `__proto__`,
// `toString`, … must read as undeclared, not as an `Object.prototype` member.
const declaration = <V>(fields: { readonly [field: string]: V }, field: string) =>
  Option.getOrUndefined(R.get(fields, field));

/**
 * Encodes one literal of a field to its wire string, before escaping. Throws
 * when the field is unknown or the literal does not encode.
 */
export type LiteralEncoder = (field: string, value: Compare["value"]) => string;

/**
 * A `LiteralEncoder` over a declaration's literal codecs. A `null` literal is
 * refused here, ahead of the codec, with a pointer at `isnull`: NULL is never a
 * literal (`docs/filter-grammar.md` F-NULL-1), and the codec's own type check
 * would only say what it expected.
 */
export const literalEncoder =
  (fields: FieldCodecs): LiteralEncoder =>
  (field, value) => {
    const codec = declaration(fields, field);
    if (codec === undefined) throw new InvalidFilter({ message: unknownField(field) });
    if (value === null) throw new InvalidFilter({ message: nullLiteral(field) });
    return Schema.encodeUnknownSync(codec.literal as Schema.Codec<unknown, string>)(value);
  };

/**
 * Asserts a node's operator is one the field declares. Throws with the same
 * messages decoding rejects with, so a tree that would not decode does not
 * encode either.
 */
export type OperatorCheck = (field: string, operator: string) => void;

/** An `OperatorCheck` over a declaration. */
export const operatorCheck =
  (fields: {
    readonly [field: string]: { readonly operators?: ReadonlyArray<string> | undefined };
  }): OperatorCheck =>
  (field, operator) => {
    const codec = declaration(fields, field);
    if (codec === undefined) throw new InvalidFilter({ message: unknownField(field) });
    if (codec.operators !== undefined && !codec.operators.includes(operator)) {
      throw new InvalidFilter({ message: undeclaredOperator(field, operator, codec.operators) });
    }
  };

const unknownField = (field: string): string => `Unknown filter field ${render(field)}`;
const nullLiteral = (field: string): string =>
  `NULL is not a filter literal for field ${render(field)} (use the isnull operator)`;
const undeclaredOperator = (
  field: string,
  operator: string,
  declared: ReadonlyArray<string>,
): string =>
  `Operator ${render(operator)} is not declared on field ${render(field)}; declared operators are ${declared.join(", ")}`;

// The message of a literal codec's failure, for the 400's `detail`.
const issueMessage = (error: Schema.SchemaError): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
    .issues.map((issue) => issue.message)
    .join("; ");

// ---------------------------------------------------------------------------
// The literal grammar (§2.3)
// ---------------------------------------------------------------------------

/** Escapes a wire literal: `\` → `\\`, `,` → `\,`. */
const escape = (literal: string): string => literal.replace(/[\\,]/g, (c) => `\\${c}`);

/**
 * Unescapes a wire value, splitting it on unescaped commas in a list position.
 * Returns the items, or the reason the value is malformed.
 */
const unescape = (
  raw: string,
  list: boolean,
): { readonly items: ReadonlyArray<string> } | { readonly error: string } => {
  // One token per escape (a backslash and the character after it, if any), unescaped
  // comma or run of plain characters, in input order.
  const tokens = Arr.fromIterable(raw.matchAll(/\\([\s\S]?)|(,)|([^\\,]+)/g));
  const error = Arr.findFirst(tokens, (token): Option.Option<string> => {
    if (token[2] !== undefined) {
      return list
        ? Option.none()
        : Option.some(
            "Malformed literal: an unescaped comma in a scalar position (write \\, for a comma)",
          );
    }
    const next = token[1];
    if (next === undefined || next === "," || next === "\\") return Option.none();
    return Option.some(
      next === ""
        ? "Malformed literal: a trailing backslash; only \\, and \\\\ are escapes"
        : `Malformed literal: unknown escape \\${next}; only \\, and \\\\ are escapes`,
    );
  });
  if (Option.isSome(error)) return { error: error.value };
  const items = Arr.reduce(tokens, [""], (acc, token) => {
    if (token[2] !== undefined) acc.push("");
    else acc[acc.length - 1] += token[3] ?? token[1];
    return acc;
  });
  return { items };
};

// ---------------------------------------------------------------------------
// Keys (§2)
// ---------------------------------------------------------------------------

const FILTER_KEY = /^filter((?:\[[^[\]]*\])+)$/;

/** The bracket segments of a `filter[...]` key, or `undefined` when malformed. */
export const keySegments = (key: string): ReadonlyArray<string> | undefined => {
  const match = FILTER_KEY.exec(key);
  if (match === null) return undefined;
  return [...match[1].matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]);
};

/**
 * Whether a flat query key belongs to the `filter` family: the bare `filter`
 * or anything starting `filter[`, well formed or not, so a malformed key is
 * rejected rather than ignored.
 */
export const isFilterKey = (key: string): boolean => key === "filter" || key.startsWith("filter[");

const MALFORMED_KEY =
  "Malformed filter key; expected filter[field], filter[field][operator], filter[id][group][member] or filter[id][condition][member]";

const allOperators: ReadonlyArray<string> = operators;
const isListOperator = (operator: string): boolean =>
  (listOperators as ReadonlyArray<string>).includes(operator);
const isConjunction = (value: string): value is (typeof conjunctions)[number] =>
  (conjunctions as ReadonlyArray<string>).includes(value);

// The `filter[...]` positions that admit a comma list: the shorthand field
// key, `field][operator]`, and a condition's `value` member — where a
// repeated key means what the comma form does. Every other position (a
// group's `conjunction`, any `memberOf`, a condition's `path` / `operator`)
// takes exactly one scalar, so a repeated key there is rejected outright.
const isListPosition = (segments: ReadonlyArray<string>): boolean =>
  segments.length === 1 ||
  segments.length === 2 ||
  (segments.length === 3 && segments[1] === "condition" && segments[2] === "value");

// ---------------------------------------------------------------------------
// Decoding (§2.2, §2.4)
// ---------------------------------------------------------------------------

/** The outcome of a decode: the tree, or one issue per offending key. */
export type Decoded =
  | { readonly _tag: "Node"; readonly node: Node }
  | { readonly _tag: "Issues"; readonly issues: ReadonlyArray<SchemaIssue.Issue> };

/**
 * A `filter[...]` value as the flat query carries it: one string, or the
 * strings of a repeated key (`Query.FilterWireValue`).
 */
export type WireValue = string | ReadonlyArray<string>;

// The offending value, carried as the issue's `actual`.
const pointed = (key: string, message: string, input?: WireValue): SchemaIssue.Issue =>
  new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message }, input));

// The keys a condition's members were read from; in shorthand all three are
// the one key.
interface ConditionKeys {
  readonly field: string;
  readonly operator: string;
  readonly value: string;
}

interface Draft {
  readonly kind: "group" | "condition";
  readonly members: Map<string, { readonly key: string; readonly value: string }>;
}

/**
 * Decodes a record of `filter[...]` keys (each a string, or a repeated key's
 * strings) to one normalised root node. Every rejection is a `Pointer` at the offending flat key.
 */
export const decodeFilter = (
  fields: FieldCodecs,
  input: { readonly [key: string]: WireValue },
): Decoded => {
  const issues = new Map<string, SchemaIssue.Issue>();
  const fail = (key: string, message: string, value?: WireValue): undefined => {
    if (!issues.has(key)) issues.set(key, pointed(key, message, value));
    return undefined;
  };

  // One condition, from wherever its members came from.
  const condition = (
    keys: ConditionKeys,
    field: string,
    op: string | undefined,
    raw: string,
  ): Node | undefined => {
    const codec = declaration(fields, field);
    if (codec === undefined) return fail(keys.field, unknownField(field), field);
    let items: ReadonlyArray<string>;
    let operator: string;
    if (op === undefined) {
      const parsed = unescape(raw, true);
      if ("error" in parsed) return fail(keys.value, parsed.error, raw);
      items = parsed.items;
      operator = items.length > 1 ? "in" : "eq";
    } else {
      if (!allOperators.includes(op)) {
        return fail(
          keys.operator,
          `Unknown filter operator ${render(op)}; expected one of ${allOperators.join(", ")}`,
          op,
        );
      }
      operator = op;
      if (op === nullOperator) {
        if (raw !== "true" && raw !== "false") {
          return fail(keys.value, `Expected true or false for isnull, got ${render(raw)}`, raw);
        }
        items = [raw];
      } else {
        const parsed = unescape(raw, isListOperator(op));
        if ("error" in parsed) return fail(keys.value, parsed.error, raw);
        items = parsed.items;
      }
    }
    if (!codec.operators.includes(operator)) {
      return fail(keys.operator, undeclaredOperator(field, operator, codec.operators), operator);
    }
    if (operator === nullOperator) return { _tag: "IsNull", field, negated: items[0] === "false" };
    const decode = Schema.decodeUnknownResult(codec.literal as Schema.Codec<unknown, string>);
    const values: Array<unknown> = [];
    const invalid = Arr.findFirst(items, (item) => {
      const result = decode(item);
      if (Result.isFailure(result)) return Option.some({ item, failure: result.failure });
      values.push(result.success);
      return Option.none();
    });
    if (Option.isSome(invalid)) {
      return fail(
        keys.value,
        `Invalid literal ${render(invalid.value.item)} for field ${render(field)}: ${issueMessage(invalid.value.failure)}`,
        raw,
      );
    }
    if (operator === "in" || operator === "nin") {
      return {
        _tag: operator === "in" ? "In" : "NotIn",
        field,
        values: values as [unknown, ...Array<unknown>],
      };
    }
    return { _tag: "Compare", op: operator as never, field, value: values[0] };
  };

  const roots: Array<Node> = [];
  const drafts = new Map<string, Draft>();
  // Ids seen as both a group and a condition: reported once, at the first key
  // of the second kind.
  const conflicted = new Set<string>();

  // The raw text of an entry's value, or `None` (after reporting) when a key
  // repeats where no comma list is possible.
  const rawOf = (
    key: string,
    value: string | ReadonlyArray<string>,
    segments: ReadonlyArray<string> | undefined,
  ): Option.Option<string> => {
    if (P.isString(value)) return Option.some(value);
    if (segments !== undefined && isListPosition(segments)) {
      // The repeated-key spelling of a comma list: `filter[f]=a&filter[f]=b`
      // is `filter[f]=a,b`. Each occurrence's raw value is preserved as-is —
      // one that is itself a comma list, or carries an escaped comma, still
      // means what it would in the single-value spelling; whether the result
      // is legal (a list operator declared, or none at all) is exactly the
      // check the comma form already goes through below.
      return Option.some(value.join(","));
    }
    fail(key, `Repeated filter key ${render(key)}; a filter key may appear once`, value);
    return Option.none();
  };

  // Records one member of a `filter[id][group|condition][member]` draft.
  const draftMember = (
    key: string,
    segments: readonly [string, "group" | "condition", string],
    raw: string,
  ): void => {
    const [id, kind, member] = segments;
    const allowed =
      kind === "group" ? ["conjunction", "memberOf"] : ["path", "operator", "value", "memberOf"];
    if (!allowed.includes(member)) {
      fail(key, `Unknown ${kind} member ${render(member)}; expected one of ${allowed.join(", ")}`);
      return;
    }
    let draft = drafts.get(id);
    if (draft === undefined) {
      draft = { kind, members: new Map() };
      drafts.set(id, draft);
    } else if (draft.kind !== kind) {
      if (!conflicted.has(id)) {
        conflicted.add(id);
        fail(key, `Filter id ${render(id)} is used as both a group and a condition`);
      }
      return;
    }
    draft.members.set(member, { key, value: raw });
  };

  Arr.forEach(Object.entries(input), ([key, value]) => {
    if (value === undefined) return;
    const segments = keySegments(key);
    const raw = rawOf(key, value, segments);
    if (Option.isNone(raw)) return;
    if (segments === undefined) {
      fail(key, MALFORMED_KEY);
      return;
    }
    if (segments.length === 1 || segments.length === 2) {
      const node = condition(
        { field: key, operator: key, value: key },
        segments[0],
        segments[1],
        raw.value,
      );
      if (node !== undefined) roots.push(node);
    } else if (segments.length === 3 && (segments[1] === "group" || segments[1] === "condition")) {
      draftMember(key, segments as [string, "group" | "condition", string], raw.value);
    } else {
      fail(key, MALFORMED_KEY);
    }
  });

  // Group form: build every node, then wire them up.
  interface Built {
    readonly kind: "group" | "condition";
    readonly node?: Node | undefined;
    readonly conjunction?: { readonly key: string; readonly value: string } | undefined;
    readonly memberOf?: { readonly key: string; readonly value: string } | undefined;
  }
  const built = new Map<string, Built>();
  Arr.forEach(drafts, ([id, draft]) => {
    const memberOf = draft.members.get("memberOf");
    if (draft.kind === "condition") {
      const path = draft.members.get("path");
      const operator = draft.members.get("operator");
      const value = draft.members.get("value");
      const missing = Arr.filter(
        [
          ["path", path],
          ["operator", operator],
          ["value", value],
        ] as const,
        ([, present]) => present === undefined,
      );
      Arr.forEach(missing, ([member]) => {
        fail(
          `filter[${id}][condition][${member}]`,
          `Missing required condition member ${render(member)}`,
        );
      });
      const node =
        path !== undefined && operator !== undefined && value !== undefined
          ? condition(
              { field: path.key, operator: operator.key, value: value.key },
              path.value,
              operator.value,
              value.value,
            )
          : undefined;
      built.set(id, { kind: "condition", node, memberOf });
    } else {
      const conjunction = draft.members.get("conjunction");
      if (conjunction === undefined) {
        fail(`filter[${id}][group][conjunction]`, `Missing required group member "conjunction"`);
      } else if (!isConjunction(conjunction.value)) {
        fail(
          conjunction.key,
          `Unknown conjunction ${render(conjunction.value)}; expected AND, OR or NOT`,
          conjunction.value,
        );
      }
      built.set(id, { kind: "group", conjunction, memberOf });
    }
  });

  // Parents must be declared groups, and the parent chain must be acyclic.
  const parentOf = new Map<string, string>();
  Arr.forEach(built, ([id, node]) => {
    if (node.memberOf === undefined) return;
    const target = built.get(node.memberOf.value);
    if (target === undefined) {
      fail(
        node.memberOf.key,
        `memberOf names an unknown group ${render(node.memberOf.value)}`,
        node.memberOf.value,
      );
    } else if (target.kind !== "group") {
      fail(
        node.memberOf.key,
        `memberOf names ${render(node.memberOf.value)}, which is a condition, not a group`,
        node.memberOf.value,
      );
    } else {
      parentOf.set(id, node.memberOf.value);
    }
  });
  const cyclic = new Set<string>();
  const parentOfId = (id: string): Option.Option<string> =>
    Option.fromUndefinedOr(parentOf.get(id));
  // Follows the parent chain from `id` until it runs out (`None`) or reaches a
  // node already in `seen`, which it returns.
  const follow = (id: Option.Option<string>, seen: Set<string>): Option.Option<string> => {
    if (Option.isNone(id) || seen.has(id.value)) return id;
    seen.add(id.value);
    return follow(parentOfId(id.value), seen);
  };
  // The members of the cycle that `id` is on.
  const collect = (id: string, cycle: Set<string>): Set<string> => {
    if (cycle.has(id)) return cycle;
    cycle.add(id);
    return collect(defined(parentOf.get(id)), cycle);
  };
  Arr.forEach(Arr.fromIterable(parentOf.keys()), (start) => {
    if (cyclic.has(start)) return;
    const current = follow(parentOfId(start), new Set<string>([start]));
    if (Option.isNone(current)) return;
    // `current` is on a cycle; report it at the first cycle member in input order.
    const cycle = collect(current.value, new Set<string>());
    const first = Arr.findFirst(built, ([id, node]) =>
      cycle.has(id) ? Option.fromNullishOr(node.memberOf) : Option.none(),
    );
    if (Option.isSome(first)) fail(first.value.key, "memberOf forms a cycle");
    Arr.forEach(cycle, (id) => {
      cyclic.add(id);
    });
  });

  if (issues.size > 0) return { _tag: "Issues", issues: [...issues.values()] };

  // Assemble the tree from the leaves up.
  const children = new Map<string, Array<string>>();
  Arr.forEach(built, ([id, node]) => {
    const parent = node.memberOf?.value;
    if (parent === undefined) return;
    let list = children.get(parent);
    if (list === undefined) {
      list = [];
      children.set(parent, list);
    }
    list.push(id);
  });
  const build = (id: string): Node => {
    const node = defined(built.get(id));
    if (node.kind === "condition") return defined(node.node);
    const members = (children.get(id) ?? []).map(build);
    const { key: conjunctionKey, value: conjunction } = defined(node.conjunction);
    if (conjunction === "NOT") {
      if (members.length !== 1) {
        fail(conjunctionKey, `A NOT group must have exactly one member, got ${members.length}`);
        return { _tag: "And", members: [] };
      }
      return { _tag: "Not", member: members[0] };
    }
    return { _tag: conjunction === "AND" ? "And" : "Or", members };
  };
  Arr.forEach(built, ([id, node]) => {
    if (node.memberOf === undefined) roots.push(build(id));
  });
  if (issues.size > 0) return { _tag: "Issues", issues: [...issues.values()] };

  if (Arr.isReadonlyArrayEmpty(roots)) {
    return {
      _tag: "Issues",
      issues: [new SchemaIssue.InvalidValue({ message: "Expected at least one filter[...] key" })],
    };
  }
  return { _tag: "Node", node: roots.length === 1 ? roots[0] : { _tag: "And", members: roots } };
};

// ---------------------------------------------------------------------------
// Normal form and the node order (§3.2)
// ---------------------------------------------------------------------------

/** A node with its wire strings alongside, so ordering and encoding are pure. */
export type Prepared = PreparedCondition | PreparedGroup;

export interface PreparedCondition {
  readonly kind: "condition";
  readonly node: Node;
  readonly field: string;
  readonly op: string;
  /** The escaped wire value: one literal, or the joined list. */
  readonly value: string;
  /** How many list items the value carries (1 for a scalar). */
  readonly arity: number;
}

export interface PreparedGroup {
  readonly kind: "group";
  readonly node: Node;
  readonly conjunction: "AND" | "OR" | "NOT";
  readonly members: ReadonlyArray<Prepared>;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/**
 * A value an invariant guarantees is present. An absent one is a defect in
 * this module, so reading it throws rather than letting `undefined` flow on.
 */
const defined = <A>(value: A): NonNullable<A> =>
  Option.getOrThrowWith(
    Option.fromNullishOr(value),
    () => new Cause.NoSuchElementError("An invariant guaranteed a value that is absent"),
  );

/** Code-point order on strings (`<` on strings is code-unit order). */
export const compareCodePoints = (a: string, b: string): number => {
  if (a === b) return 0;
  // Without a surrogate, code-unit order is code-point order.
  if (!SURROGATE.test(a) && !SURROGATE.test(b)) return a < b ? -1 : 1;
  const cpsA = Arr.fromIterable(a);
  const cpsB = Arr.fromIterable(b);
  return Option.getOrElse(
    Arr.findFirst(cpsA, (cp, i) => {
      const other = cpsB[i];
      if (other === undefined || cp === other) return Option.none();
      return Option.some(defined(cp.codePointAt(0)) < defined(other.codePointAt(0)) ? -1 : 1);
    }),
    () => (cpsA.length > cpsB.length ? 1 : cpsA.length < cpsB.length ? -1 : 0),
  );
};

/** The total node order of §3.2. */
const compareNodes = (a: Prepared, b: Prepared): number => {
  if (a.kind !== b.kind) return a.kind === "condition" ? -1 : 1;
  if (a.kind === "condition" && b.kind === "condition") {
    return (
      compareCodePoints(a.field, b.field) ||
      compareCodePoints(a.op, b.op) ||
      compareCodePoints(a.value, b.value)
    );
  }
  if (a.kind === "group" && b.kind === "group") {
    const byConjunction = compareCodePoints(a.conjunction, b.conjunction);
    if (byConjunction !== 0) return byConjunction;
    return Option.getOrElse(
      Arr.findFirst(a.members, (member, i) => {
        if (i >= b.members.length) return Option.none();
        const c = compareNodes(member, b.members[i]);
        return c === 0 ? Option.none() : Option.some(c);
      }),
      () => a.members.length - b.members.length,
    );
  }
  return 0;
};

/**
 * The {@link Order.Order} of a numeric comparator (negative, zero or
 * positive), for `Arr.sort`.
 */
export const orderOf = <A>(compare: (a: A, b: A) => number): Order.Order<A> =>
  Order.make((a, b) => {
    const c = compare(a, b);
    return c < 0 ? -1 : c > 0 ? 1 : 0;
  });

const sortedUnique = <A>(items: ReadonlyArray<A>, compare: (a: A, b: A) => number): Array<A> => {
  const sorted = Arr.sort(items, orderOf(compare));
  return sorted.filter((item, index) => index === 0 || compare(sorted[index - 1], item) !== 0);
};

/**
 * Normalises a tree (§3.2), computing each node's wire strings on the way:
 * `In` / `NotIn` values sorted by encoded string and deduplicated, `And` /
 * `Or` members sorted by the node order and deduplicated. `check` asserts each
 * condition's operator against its field's declaration, so a tree the codec
 * would reject on decode is rejected on encode too.
 */
export const prepare = (
  node: Node,
  encode: LiteralEncoder,
  check: OperatorCheck = () => {},
): Prepared =>
  Match.value(node).pipe(
    Match.tag("Compare", (node): Prepared => {
      check(node.field, node.op);
      return {
        kind: "condition",
        node,
        field: node.field,
        op: node.op,
        value: escape(encode(node.field, node.value)),
        arity: 1,
      };
    }),
    Match.tag("In", "NotIn", (node): Prepared => {
      check(node.field, P.isTagged(node, "In") ? "in" : "nin");
      if (Arr.isReadonlyArrayEmpty(node.values))
        throw new InvalidFilter({ message: `A ${node._tag} node needs at least one value` });
      const items = sortedUnique(
        node.values.map((value) => ({ wire: escape(encode(node.field, value)), value })),
        (a, b) => compareCodePoints(a.wire, b.wire),
      );
      return {
        kind: "condition",
        node: {
          _tag: node._tag,
          field: node.field,
          values: items.map((item) => item.value) as [unknown, ...Array<unknown>],
        },
        field: node.field,
        op: P.isTagged(node, "In") ? "in" : "nin",
        value: items.map((item) => item.wire).join(","),
        arity: items.length,
      };
    }),
    Match.tag("IsNull", (node): Prepared => {
      check(node.field, nullOperator);
      return {
        kind: "condition",
        node,
        field: node.field,
        op: nullOperator,
        value: node.negated ? "false" : "true",
        arity: 1,
      };
    }),
    Match.tag("And", "Or", (node): Prepared => {
      const members = sortedUnique(
        node.members.map((member) => prepare(member, encode, check)),
        compareNodes,
      );
      return {
        kind: "group",
        node: { _tag: node._tag, members: members.map((member) => member.node) },
        conjunction: P.isTagged(node, "And") ? "AND" : "OR",
        members,
      };
    }),
    Match.tag("Not", (node): Prepared => {
      const member = prepare(node.member, encode, check);
      return {
        kind: "group",
        node: { _tag: "Not", member: member.node },
        conjunction: "NOT",
        members: [member],
      };
    }),
    // An untyped caller can still hand over a node outside the union.
    Match.orElse((): never => {
      throw new InvalidFilter({
        message: `Unknown filter node ${render((node as { readonly _tag?: unknown })._tag)}`,
      });
    }),
  );

// ---------------------------------------------------------------------------
// Canonical encoding (§3.1, §3.3)
// ---------------------------------------------------------------------------

const shorthandPair = (condition: PreparedCondition): readonly [string, string] => {
  if (condition.op === "eq") return [`filter[${condition.field}]`, condition.value];
  if (condition.op === "in" && condition.arity >= 2)
    return [`filter[${condition.field}]`, condition.value];
  return [`filter[${condition.field}][${condition.op}]`, condition.value];
};

// The shorthand pairs of a prepared tree, when shorthand decodes back to the
// same tree (§3.1); `undefined` otherwise.
const shorthand = (root: Prepared): ReadonlyArray<readonly [string, string]> | undefined => {
  let conditions: ReadonlyArray<PreparedCondition>;
  if (root.kind === "condition") {
    conditions = [root];
  } else if (root.conjunction === "AND" && root.members.length >= 2) {
    if (!root.members.every((member) => member.kind === "condition")) return undefined;
    conditions = root.members;
  } else {
    return undefined;
  }
  const pairs = conditions.map(shorthandPair);
  // A key names one condition; two conditions on the same key (the same field
  // and operator, or a bare `eq` next to a bare `in`) need the group form.
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return undefined;
  return Arr.sort(
    pairs,
    orderOf<(typeof pairs)[number]>(([a], [b]) => compareCodePoints(a, b)),
  );
};

/**
 * The canonical flat pairs of a normalised tree, in canonical order: the
 * shorthand when it round-trips, the group form with pre-order ids otherwise.
 */
export const encodeFilter = (root: Prepared) => {
  const pairs: Array<readonly [string, string]> = [];
  const short = shorthand(root);
  if (short !== undefined) {
    pairs.push(...short);
  } else {
    let groups = 0;
    let conditions = 0;
    const visit = (node: Prepared, parent: string | undefined): void => {
      if (node.kind === "group") {
        const id = `g${groups++}`;
        pairs.push([`filter[${id}][group][conjunction]`, node.conjunction]);
        if (parent !== undefined) pairs.push([`filter[${id}][group][memberOf]`, parent]);
        Arr.forEach(node.members, (member) => {
          visit(member, id);
        });
      } else {
        const id = `c${conditions++}`;
        pairs.push([`filter[${id}][condition][path]`, node.field]);
        pairs.push([`filter[${id}][condition][operator]`, node.op]);
        pairs.push([`filter[${id}][condition][value]`, node.value]);
        if (parent !== undefined) pairs.push([`filter[${id}][condition][memberOf]`, parent]);
      }
    };
    visit(root, undefined);
  }
  return R.fromEntries(pairs);
};
