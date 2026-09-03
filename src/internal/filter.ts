/**
 * The `filter` URL grammar engine: flat `filter[...]` keys ↔ the filter AST,
 * per `docs/filter-grammar.md` §2 (surface syntax) and §3 (canonical
 * encoding). `Filter.ts` and `Query.ts` expose it.
 *
 * @internal
 */
import { Schema, SchemaIssue } from "effect"
import type { Node } from "../Filter.js"
import { conjunctions, listOperators, nullOperator, operators } from "./operators.js"

// ---------------------------------------------------------------------------
// The per-field declaration the engine reads
// ---------------------------------------------------------------------------

/**
 * One filterable field, as the engine needs it: the operators it admits and
 * the codec between a wire string and the decoded literal. Structurally the
 * runtime shape of a `Resource.Filterable` entry.
 */
export interface FieldCodec {
  readonly operators: ReadonlyArray<string>
  readonly literal: Schema.Top
}

/** The filterable fields of a resource, keyed by field name. */
export interface FieldCodecs {
  readonly [field: string]: FieldCodec
}

/**
 * Encodes one literal of a field to its wire string, before escaping. Throws
 * when the field is unknown or the literal does not encode.
 */
export type LiteralEncoder = (field: string, value: unknown) => string

/** A `LiteralEncoder` over a declaration's literal codecs. */
export const literalEncoder =
  (fields: FieldCodecs): LiteralEncoder =>
  (field, value) => {
    const codec = fields[field]
    if (codec === undefined) throw new Error(unknownField(field))
    return Schema.encodeUnknownSync(codec.literal as Schema.Codec<unknown, string>)(value)
  }

/**
 * Asserts a node's operator is one the field declares. Throws with the same
 * messages decoding rejects with, so a tree that would not decode does not
 * encode either.
 */
export type OperatorCheck = (field: string, operator: string) => void

/** An `OperatorCheck` over a declaration. */
export const operatorCheck =
  (fields: { readonly [field: string]: { readonly operators?: ReadonlyArray<string> | undefined } }): OperatorCheck =>
  (field, operator) => {
    const codec = fields[field]
    if (codec === undefined) throw new Error(unknownField(field))
    if (codec.operators !== undefined && !codec.operators.includes(operator)) {
      throw new Error(undeclaredOperator(field, operator, codec.operators))
    }
  }

const unknownField = (field: string): string => `Unknown filter field ${JSON.stringify(field)}`
const undeclaredOperator = (field: string, operator: string, declared: ReadonlyArray<string>): string =>
  `Operator ${JSON.stringify(operator)} is not declared on field ${JSON.stringify(field)}; declared operators are ${declared.join(", ")}`

// The message of a literal codec's failure, for the 400's `detail`.
const issueMessage = (error: Schema.SchemaError): string =>
  SchemaIssue.makeFormatterStandardSchemaV1()(error.issue)
    .issues.map((issue) => issue.message)
    .join("; ")

// ---------------------------------------------------------------------------
// The literal grammar (§2.3)
// ---------------------------------------------------------------------------

/** Escapes a wire literal: `\` → `\\`, `,` → `\,`. */
export const escape = (literal: string): string => literal.replace(/[\\,]/g, (c) => `\\${c}`)

/**
 * Unescapes a wire value, splitting it on unescaped commas in a list position.
 * Returns the items, or the reason the value is malformed.
 */
export const unescape = (
  raw: string,
  list: boolean
): { readonly items: ReadonlyArray<string> } | { readonly error: string } => {
  const items: Array<string> = []
  let current = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!
    if (c === "\\") {
      const next = raw[i + 1]
      if (next !== "," && next !== "\\") {
        return {
          error:
            next === undefined
              ? "Malformed literal: a trailing backslash; only \\, and \\\\ are escapes"
              : `Malformed literal: unknown escape \\${next}; only \\, and \\\\ are escapes`
        }
      }
      current += next
      i++
    } else if (c === ",") {
      if (!list) return { error: "Malformed literal: an unescaped comma in a scalar position (write \\, for a comma)" }
      items.push(current)
      current = ""
    } else {
      current += c
    }
  }
  items.push(current)
  return { items }
}

// ---------------------------------------------------------------------------
// Keys (§2)
// ---------------------------------------------------------------------------

const FILTER_KEY = /^filter((?:\[[^[\]]*\])+)$/

/** The bracket segments of a `filter[...]` key, or `undefined` when malformed. */
export const keySegments = (key: string): ReadonlyArray<string> | undefined => {
  const match = FILTER_KEY.exec(key)
  if (match === null) return undefined
  return [...match[1]!.matchAll(/\[([^[\]]*)\]/g)].map((m) => m[1]!)
}

/**
 * Whether a flat query key belongs to the `filter` family: the bare `filter`
 * or anything starting `filter[`, well formed or not, so a malformed key is
 * rejected rather than ignored.
 */
export const isFilterKey = (key: string): boolean => key === "filter" || key.startsWith("filter[")

const MALFORMED_KEY =
  "Malformed filter key; expected filter[field], filter[field][operator], filter[id][group][member] or filter[id][condition][member]"

const allOperators: ReadonlyArray<string> = operators
const isListOperator = (operator: string): boolean => (listOperators as ReadonlyArray<string>).includes(operator)
const isConjunction = (value: string): value is (typeof conjunctions)[number] =>
  (conjunctions as ReadonlyArray<string>).includes(value)

// ---------------------------------------------------------------------------
// Decoding (§2.2, §2.4)
// ---------------------------------------------------------------------------

/** The outcome of a decode: the tree, or one issue per offending key. */
export type Decoded =
  | { readonly _tag: "Node"; readonly node: Node }
  | { readonly _tag: "Issues"; readonly issues: ReadonlyArray<SchemaIssue.Issue> }

const pointed = (key: string, message: string, input?: unknown): SchemaIssue.Issue =>
  new SchemaIssue.Pointer([key], new SchemaIssue.InvalidValue({ message }, input))

const quote = JSON.stringify

// The keys a condition's members were read from; in shorthand all three are
// the one key.
interface ConditionKeys {
  readonly field: string
  readonly operator: string
  readonly value: string
}

interface Draft {
  readonly kind: "group" | "condition"
  readonly members: Map<string, { readonly key: string; readonly value: string }>
}

/**
 * Decodes a record of `filter[...]` keys (string values) to one normalised
 * root node. Every rejection is a `Pointer` at the offending flat key.
 */
export const decodeFilter = (fields: FieldCodecs, input: { readonly [key: string]: unknown }): Decoded => {
  const issues = new Map<string, SchemaIssue.Issue>()
  const fail = (key: string, message: string, value?: unknown): undefined => {
    if (!issues.has(key)) issues.set(key, pointed(key, message, value))
    return undefined
  }

  // One condition, from wherever its members came from.
  const condition = (keys: ConditionKeys, field: string, op: string | undefined, raw: string): Node | undefined => {
    const codec = fields[field]
    if (codec === undefined) return fail(keys.field, unknownField(field), field)
    let items: ReadonlyArray<string>
    let operator: string
    if (op === undefined) {
      const parsed = unescape(raw, true)
      if ("error" in parsed) return fail(keys.value, parsed.error, raw)
      items = parsed.items
      operator = items.length > 1 ? "in" : "eq"
    } else {
      if (!allOperators.includes(op)) {
        return fail(
          keys.operator,
          `Unknown filter operator ${quote(op)}; expected one of ${allOperators.join(", ")}`,
          op
        )
      }
      operator = op
      if (op === nullOperator) {
        if (raw !== "true" && raw !== "false") {
          return fail(keys.value, `Expected true or false for isnull, got ${quote(raw)}`, raw)
        }
        items = [raw]
      } else {
        const parsed = unescape(raw, isListOperator(op))
        if ("error" in parsed) return fail(keys.value, parsed.error, raw)
        items = parsed.items
      }
    }
    if (!codec.operators.includes(operator)) {
      return fail(keys.operator, undeclaredOperator(field, operator, codec.operators), operator)
    }
    if (operator === nullOperator) return { _tag: "IsNull", field, negated: items[0] === "false" }
    const decode = Schema.decodeUnknownResult(codec.literal as Schema.Codec<unknown, string>)
    const values: Array<unknown> = []
    for (const item of items) {
      const result = decode(item)
      if (result._tag === "Failure") {
        return fail(
          keys.value,
          `Invalid literal ${quote(item)} for field ${quote(field)}: ${issueMessage(result.failure)}`,
          raw
        )
      }
      values.push(result.success)
    }
    if (operator === "in" || operator === "nin") {
      return { _tag: operator === "in" ? "In" : "NotIn", field, values: values as [unknown, ...Array<unknown>] }
    }
    return { _tag: "Compare", op: operator as never, field, value: values[0] }
  }

  const roots: Array<Node> = []
  const drafts = new Map<string, Draft>()
  // Ids seen as both a group and a condition: reported once, at the first key
  // of the second kind.
  const conflicted = new Set<string>()

  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue
    if (typeof value !== "string") {
      fail(
        key,
        Array.isArray(value)
          ? `Repeated filter key ${quote(key)}; a filter key may appear once`
          : `Expected a string, got ${quote(value)}`,
        value
      )
      continue
    }
    const segments = keySegments(key)
    if (segments === undefined) {
      fail(key, MALFORMED_KEY)
      continue
    }
    if (segments.length === 1) {
      const node = condition({ field: key, operator: key, value: key }, segments[0]!, undefined, value)
      if (node !== undefined) roots.push(node)
    } else if (segments.length === 2) {
      const node = condition({ field: key, operator: key, value: key }, segments[0]!, segments[1]!, value)
      if (node !== undefined) roots.push(node)
    } else if (segments.length === 3 && (segments[1] === "group" || segments[1] === "condition")) {
      const [id, kind, member] = segments as [string, "group" | "condition", string]
      const allowed = kind === "group" ? ["conjunction", "memberOf"] : ["path", "operator", "value", "memberOf"]
      if (!allowed.includes(member)) {
        fail(key, `Unknown ${kind} member ${quote(member)}; expected one of ${allowed.join(", ")}`)
        continue
      }
      let draft = drafts.get(id)
      if (draft === undefined) {
        draft = { kind, members: new Map() }
        drafts.set(id, draft)
      } else if (draft.kind !== kind) {
        if (!conflicted.has(id)) {
          conflicted.add(id)
          fail(key, `Filter id ${quote(id)} is used as both a group and a condition`)
        }
        continue
      }
      draft.members.set(member, { key, value })
    } else {
      fail(key, MALFORMED_KEY)
    }
  }

  // Group form: build every node, then wire them up.
  interface Built {
    readonly kind: "group" | "condition"
    readonly node?: Node
    readonly conjunction?: { readonly key: string; readonly value: string }
    readonly memberOf?: { readonly key: string; readonly value: string }
  }
  const built = new Map<string, Built>()
  for (const [id, draft] of drafts) {
    const memberOf = draft.members.get("memberOf")
    if (draft.kind === "condition") {
      const path = draft.members.get("path")
      const operator = draft.members.get("operator")
      const value = draft.members.get("value")
      let complete = true
      for (const [member, present] of [
        ["path", path],
        ["operator", operator],
        ["value", value]
      ] as const) {
        if (present === undefined) {
          fail(`filter[${id}][condition][${member}]`, `Missing required condition member ${quote(member)}`)
          complete = false
        }
      }
      const node = complete
        ? condition(
            { field: path!.key, operator: operator!.key, value: value!.key },
            path!.value,
            operator!.value,
            value!.value
          )
        : undefined
      built.set(id, { kind: "condition", node, memberOf })
    } else {
      const conjunction = draft.members.get("conjunction")
      if (conjunction === undefined) {
        fail(`filter[${id}][group][conjunction]`, `Missing required group member "conjunction"`)
      } else if (!isConjunction(conjunction.value)) {
        fail(
          conjunction.key,
          `Unknown conjunction ${quote(conjunction.value)}; expected AND, OR or NOT`,
          conjunction.value
        )
      }
      built.set(id, { kind: "group", conjunction, memberOf })
    }
  }

  // Parents must be declared groups, and the parent chain must be acyclic.
  const parentOf = new Map<string, string>()
  for (const [id, node] of built) {
    if (node.memberOf === undefined) continue
    const target = built.get(node.memberOf.value)
    if (target === undefined) {
      fail(node.memberOf.key, `memberOf names an unknown group ${quote(node.memberOf.value)}`, node.memberOf.value)
    } else if (target.kind !== "group") {
      fail(
        node.memberOf.key,
        `memberOf names ${quote(node.memberOf.value)}, which is a condition, not a group`,
        node.memberOf.value
      )
    } else {
      parentOf.set(id, node.memberOf.value)
    }
  }
  const cyclic = new Set<string>()
  for (const [start] of parentOf) {
    if (cyclic.has(start)) continue
    const seen = new Set<string>([start])
    let current = parentOf.get(start)
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      current = parentOf.get(current)
    }
    if (current === undefined) continue
    // `current` is on a cycle; report it at the first cycle member in input order.
    const cycle = new Set<string>()
    for (let id = current; !cycle.has(id); id = parentOf.get(id)!) cycle.add(id)
    for (const id of built.keys()) {
      if (cycle.has(id)) {
        fail(built.get(id)!.memberOf!.key, "memberOf forms a cycle")
        break
      }
    }
    for (const id of cycle) cyclic.add(id)
  }

  if (issues.size > 0) return { _tag: "Issues", issues: [...issues.values()] }

  // Assemble the tree from the leaves up.
  const children = new Map<string, Array<string>>()
  for (const [id, node] of built) {
    const parent = node.memberOf?.value
    if (parent === undefined) continue
    let list = children.get(parent)
    if (list === undefined) {
      list = []
      children.set(parent, list)
    }
    list.push(id)
  }
  const build = (id: string): Node => {
    const node = built.get(id)!
    if (node.kind === "condition") return node.node!
    const members = (children.get(id) ?? []).map(build)
    const conjunction = node.conjunction!.value
    if (conjunction === "NOT") {
      if (members.length !== 1) {
        fail(node.conjunction!.key, `A NOT group must have exactly one member, got ${members.length}`)
        return { _tag: "And", members: [] }
      }
      return { _tag: "Not", member: members[0]! }
    }
    return { _tag: conjunction === "AND" ? "And" : "Or", members }
  }
  for (const [id, node] of built) {
    if (node.memberOf === undefined) roots.push(build(id))
  }
  if (issues.size > 0) return { _tag: "Issues", issues: [...issues.values()] }

  if (roots.length === 0) {
    return {
      _tag: "Issues",
      issues: [new SchemaIssue.InvalidValue({ message: "Expected at least one filter[...] key" })]
    }
  }
  return { _tag: "Node", node: roots.length === 1 ? roots[0]! : { _tag: "And", members: roots } }
}

// ---------------------------------------------------------------------------
// Normal form and the node order (§3.2)
// ---------------------------------------------------------------------------

/** A node with its wire strings alongside, so ordering and encoding are pure. */
export type Prepared = PreparedCondition | PreparedGroup

export interface PreparedCondition {
  readonly kind: "condition"
  readonly node: Node
  readonly field: string
  readonly op: string
  /** The escaped wire value: one literal, or the joined list. */
  readonly value: string
  /** How many list items the value carries (1 for a scalar). */
  readonly arity: number
}

export interface PreparedGroup {
  readonly kind: "group"
  readonly node: Node
  readonly conjunction: "AND" | "OR" | "NOT"
  readonly members: ReadonlyArray<Prepared>
}

/** Code-point order on strings (`<` on strings is code-unit order). */
export const compareCodePoints = (a: string, b: string): number => {
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!
    const cb = b.codePointAt(j)!
    if (ca !== cb) return ca < cb ? -1 : 1
    i += ca > 0xffff ? 2 : 1
    j += cb > 0xffff ? 2 : 1
  }
  return i < a.length ? 1 : j < b.length ? -1 : 0
}

/** The total node order of §3.2. */
export const compareNodes = (a: Prepared, b: Prepared): number => {
  if (a.kind !== b.kind) return a.kind === "condition" ? -1 : 1
  if (a.kind === "condition" && b.kind === "condition") {
    return compareCodePoints(a.field, b.field) || compareCodePoints(a.op, b.op) || compareCodePoints(a.value, b.value)
  }
  if (a.kind === "group" && b.kind === "group") {
    const byConjunction = compareCodePoints(a.conjunction, b.conjunction)
    if (byConjunction !== 0) return byConjunction
    const n = Math.min(a.members.length, b.members.length)
    for (let i = 0; i < n; i++) {
      const c = compareNodes(a.members[i]!, b.members[i]!)
      if (c !== 0) return c
    }
    return a.members.length - b.members.length
  }
  return 0
}

const sortedUnique = <A>(items: ReadonlyArray<A>, compare: (a: A, b: A) => number): Array<A> => {
  const sorted = [...items].sort(compare)
  return sorted.filter((item, index) => index === 0 || compare(sorted[index - 1]!, item) !== 0)
}

/**
 * Normalises a tree (§3.2), computing each node's wire strings on the way:
 * `In` / `NotIn` values sorted by encoded string and deduplicated, `And` /
 * `Or` members sorted by the node order and deduplicated. `check` asserts each
 * condition's operator against its field's declaration, so a tree the codec
 * would reject on decode is rejected on encode too.
 */
export const prepare = (node: Node, encode: LiteralEncoder, check: OperatorCheck = () => {}): Prepared => {
  switch (node._tag) {
    case "Compare":
      check(node.field, node.op)
      return {
        kind: "condition",
        node,
        field: node.field,
        op: node.op,
        value: escape(encode(node.field, node.value)),
        arity: 1
      }
    case "In":
    case "NotIn": {
      check(node.field, node._tag === "In" ? "in" : "nin")
      if (node.values.length === 0) throw new Error(`A ${node._tag} node needs at least one value`)
      const items = sortedUnique(
        node.values.map((value) => ({ wire: escape(encode(node.field, value)), value })),
        (a, b) => compareCodePoints(a.wire, b.wire)
      )
      return {
        kind: "condition",
        node: {
          _tag: node._tag,
          field: node.field,
          values: items.map((item) => item.value) as [unknown, ...Array<unknown>]
        },
        field: node.field,
        op: node._tag === "In" ? "in" : "nin",
        value: items.map((item) => item.wire).join(","),
        arity: items.length
      }
    }
    case "IsNull":
      check(node.field, nullOperator)
      return {
        kind: "condition",
        node,
        field: node.field,
        op: nullOperator,
        value: node.negated ? "false" : "true",
        arity: 1
      }
    case "And":
    case "Or": {
      const members = sortedUnique(
        node.members.map((member) => prepare(member, encode, check)),
        compareNodes
      )
      return {
        kind: "group",
        node: { _tag: node._tag, members: members.map((member) => member.node) },
        conjunction: node._tag === "And" ? "AND" : "OR",
        members
      }
    }
    case "Not": {
      const member = prepare(node.member, encode, check)
      return { kind: "group", node: { _tag: "Not", member: member.node }, conjunction: "NOT", members: [member] }
    }
    default:
      throw new Error(`Unknown filter node ${quote((node as { readonly _tag?: unknown })._tag)}`)
  }
}

// ---------------------------------------------------------------------------
// Canonical encoding (§3.1, §3.3)
// ---------------------------------------------------------------------------

const shorthandPair = (condition: PreparedCondition): readonly [string, string] => {
  if (condition.op === "eq") return [`filter[${condition.field}]`, condition.value]
  if (condition.op === "in" && condition.arity >= 2) return [`filter[${condition.field}]`, condition.value]
  return [`filter[${condition.field}][${condition.op}]`, condition.value]
}

// The shorthand pairs of a prepared tree, when shorthand decodes back to the
// same tree (§3.1); `undefined` otherwise.
const shorthand = (root: Prepared): ReadonlyArray<readonly [string, string]> | undefined => {
  let conditions: ReadonlyArray<PreparedCondition>
  if (root.kind === "condition") {
    conditions = [root]
  } else if (root.conjunction === "AND" && root.members.length >= 2) {
    if (!root.members.every((member) => member.kind === "condition")) return undefined
    conditions = root.members as ReadonlyArray<PreparedCondition>
  } else {
    return undefined
  }
  const pairs = conditions.map(shorthandPair)
  // A key names one condition; two conditions on the same key (the same field
  // and operator, or a bare `eq` next to a bare `in`) need the group form.
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) return undefined
  return [...pairs].sort(([a], [b]) => compareCodePoints(a, b))
}

/**
 * The canonical flat pairs of a normalised tree, in canonical order: the
 * shorthand when it round-trips, the group form with pre-order ids otherwise.
 */
export const encodeFilter = (root: Prepared): Record<string, string> => {
  const pairs: Array<readonly [string, string]> = []
  const short = shorthand(root)
  if (short !== undefined) {
    pairs.push(...short)
  } else {
    let groups = 0
    let conditions = 0
    const visit = (node: Prepared, parent: string | undefined): void => {
      if (node.kind === "group") {
        const id = `g${groups++}`
        pairs.push([`filter[${id}][group][conjunction]`, node.conjunction])
        if (parent !== undefined) pairs.push([`filter[${id}][group][memberOf]`, parent])
        for (const member of node.members) visit(member, id)
      } else {
        const id = `c${conditions++}`
        pairs.push([`filter[${id}][condition][path]`, node.field])
        pairs.push([`filter[${id}][condition][operator]`, node.op])
        pairs.push([`filter[${id}][condition][value]`, node.value])
        if (parent !== undefined) pairs.push([`filter[${id}][condition][memberOf]`, parent])
      }
    }
    visit(root, undefined)
  }
  const record: Record<string, string> = {}
  for (const [key, value] of pairs) record[key] = value
  return record
}
