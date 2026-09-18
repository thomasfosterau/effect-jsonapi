import { describe, expect, it } from "vite-plus/test"
import * as Filter from "./Filter.js"
import { compareCodePoints } from "./internal/filter.js"

// ---------------------------------------------------------------------------
// The profile's semantics (docs/filter-grammar.md §6), as an executable table.
//
// This package evaluates no filter — a server does, against its store (§6.9).
// What is checked here is that §6 is *coherent*: that the truth tables compose
// into the outcomes §6.3 spells out, and that the corollaries §6.5 claims
// really follow from them. The reference fold below is a fixture of this file,
// not a shipped API; a conformance suite (#120) runs the same rules against a
// server, which is the thing that actually has to conform.
//
// Each test names the rule it pins, so a failure reads as "§6 says X" rather
// than as an assertion diff.
// ---------------------------------------------------------------------------

/** §6.3: the three truth values. */
type Truth = "TRUE" | "FALSE" | "UNKNOWN"

/** §6.4: the absence of a value for a field on one resource. Never a literal. */
const NULL = Symbol.for("effect-jsonapi/test/NULL")
type Null = typeof NULL

/** §6.2 F-ORD-1: every filterable field's values are a JSON scalar. */
type Json = string | number | boolean

/** One resource, as §6.1 F-EVAL-4 reads it: each field to its JSON value or NULL. */
interface Row {
  readonly [field: string]: Json | Null
}

const truth = (value: boolean): Truth => (value ? "TRUE" : "FALSE")

// --- §6.3.3 F-LOGIC-1: Kleene's strong three-valued connectives ------------

const AND: { readonly [A in Truth]: { readonly [B in Truth]: Truth } } = {
  TRUE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  FALSE: { TRUE: "FALSE", FALSE: "FALSE", UNKNOWN: "FALSE" },
  UNKNOWN: { TRUE: "UNKNOWN", FALSE: "FALSE", UNKNOWN: "UNKNOWN" }
}

const OR: { readonly [A in Truth]: { readonly [B in Truth]: Truth } } = {
  TRUE: { TRUE: "TRUE", FALSE: "TRUE", UNKNOWN: "TRUE" },
  FALSE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  UNKNOWN: { TRUE: "TRUE", FALSE: "UNKNOWN", UNKNOWN: "UNKNOWN" }
}

const NOT: { readonly [A in Truth]: Truth } = { TRUE: "FALSE", FALSE: "TRUE", UNKNOWN: "UNKNOWN" }

const values: ReadonlyArray<Truth> = ["TRUE", "FALSE", "UNKNOWN"]

// --- §6.2 F-ORD-1: comparison, in the domain of the field's JSON type ------

const compare = (value: Json, literal: Json): number => {
  if (typeof value !== typeof literal) {
    throw new Error(`§6.2 F-ORD-1: ${typeof value} and ${typeof literal} are not one domain`)
  }
  if (typeof value === "number") return value < (literal as number) ? -1 : value > (literal as number) ? 1 : 0
  if (typeof value === "boolean") return Number(value) - Number(literal as boolean)
  return compareCodePoints(value as string, literal as string)
}

// --- §6.3: the reference fold ----------------------------------------------

const evaluate = (node: Filter.Node, row: Row): Truth => {
  switch (node._tag) {
    case "Compare": {
      const value = row[node.field]
      // §6.3.1 F-CMP-1: every comparison against NULL is UNKNOWN.
      if (value === undefined || value === NULL) return "UNKNOWN"
      // §6.3.1 F-CMP-2: otherwise the two-valued result of the relation.
      const order = compare(value, node.value as Json)
      switch (node.op) {
        case "eq":
          return truth(order === 0)
        case "ne":
          return truth(order !== 0)
        case "lt":
          return truth(order < 0)
        case "lte":
          return truth(order <= 0)
        case "gt":
          return truth(order > 0)
        case "gte":
          return truth(order >= 0)
      }
    }
    // §6.3.2 F-IN-1: a disjunction of equalities.
    case "In":
      return evaluate(Filter.or(...node.values.map((value) => Filter.eq(node.field, value))) as Filter.Node, row)
    // §6.3.2 F-IN-2: the negation of F-IN-1.
    case "NotIn":
      return evaluate(Filter.not(Filter.isIn(node.field, node.values)) as Filter.Node, row)
    // §6.3.4 F-ISNULL-1 / F-ISNULL-2: total, never UNKNOWN.
    case "IsNull": {
      const value = row[node.field]
      const isNull = value === undefined || value === NULL
      return truth(node.negated ? !isNull : isNull)
    }
    // §6.3.3 F-AND-1 / F-AND-2: the folds, with TRUE and FALSE as identities.
    case "And":
      return node.members.reduce<Truth>((acc, member) => AND[acc][evaluate(member, row)], "TRUE")
    case "Or":
      return node.members.reduce<Truth>((acc, member) => OR[acc][evaluate(member, row)], "FALSE")
    // §6.3.3 F-NOT-1.
    case "Not":
      return NOT[evaluate(node.member, row)]
  }
}

/** §6.1 F-EVAL-3: a resource is in the primary data iff the root is TRUE. */
const matches = (node: Filter.Node, row: Row): boolean => evaluate(node, row) === "TRUE"

// ---------------------------------------------------------------------------

describe("filter profile §6.1 — the evaluation model", () => {
  it("F-EVAL-3: a resource matches iff the root is TRUE; FALSE and UNKNOWN both exclude", () => {
    const node = Filter.eq("status", "open")
    expect(evaluate(node, { status: "open" })).toBe("TRUE")
    expect(evaluate(node, { status: "done" })).toBe("FALSE")
    expect(evaluate(node, { status: NULL })).toBe("UNKNOWN")
    const collection: ReadonlyArray<Row> = [{ status: "open" }, { status: "done" }, { status: NULL }]
    expect(collection.filter((row) => matches(node, row))).toEqual([{ status: "open" }])
  })

  it("F-EVAL-4 / F-EVAL-5: an absent member and a null member are one and the same NULL", () => {
    const absent: Row = {}
    const explicit: Row = { status: NULL }
    for (const node of [
      Filter.eq("status", "open"),
      Filter.ne("status", "open"),
      Filter.isIn("status", ["open"]),
      Filter.notIn("status", ["open"]),
      Filter.isNull("status"),
      Filter.isNull("status", true)
    ] as ReadonlyArray<Filter.Node>) {
      expect(evaluate(node, absent)).toBe(evaluate(node, explicit))
    }
  })

  it("F-EVAL-4: a to-one relationship field is the related id, NULL when the linkage is empty", () => {
    const node = Filter.eq("author", "9")
    expect(evaluate(node, { author: "9" })).toBe("TRUE")
    expect(evaluate(node, { author: "10" })).toBe("FALSE")
    expect(evaluate(node, { author: NULL })).toBe("UNKNOWN")
    expect(evaluate(Filter.isNull("author"), { author: NULL })).toBe("TRUE")
  })
})

describe("filter profile §6.2 — comparison domains", () => {
  it("F-ORD-1: numbers compare numerically, not as text", () => {
    expect(evaluate(Filter.gt("age", 9), { age: 10 })).toBe("TRUE")
    // the same pair as strings orders the other way — the domain decides
    expect(evaluate(Filter.gt("title", "9"), { title: "10" })).toBe("FALSE")
    // F-ORD-1: -0 and 0 are equal
    expect(evaluate(Filter.eq("age", 0), { age: -0 })).toBe("TRUE")
  })

  it("F-ORD-1: booleans order false < true", () => {
    expect(evaluate(Filter.gt("flag", false), { flag: true })).toBe("TRUE")
    expect(evaluate(Filter.lt("flag", true), { flag: false })).toBe("TRUE")
    expect(evaluate(Filter.eq("flag", true), { flag: true })).toBe("TRUE")
  })

  it("F-ORD-2: strings compare by code point — no case folding, no normalisation, no trimming", () => {
    // code point, not code unit: U+1F600 sorts after "z"
    expect(evaluate(Filter.gt("title", "z"), { title: "\u{1F600}" })).toBe("TRUE")
    // case is significant, and uppercase sorts before lowercase
    expect(evaluate(Filter.eq("title", "hello"), { title: "Hello" })).toBe("FALSE")
    expect(evaluate(Filter.lt("title", "a"), { title: "Z" })).toBe("TRUE")
    // NFC and NFD spellings of "e-acute" are different values: no normalisation
    expect(evaluate(Filter.eq("title", "\u00E9"), { title: "e\u0301" })).toBe("FALSE")
    // no trimming, no blank padding
    expect(evaluate(Filter.eq("title", "a"), { title: "a  " })).toBe("FALSE")
  })

  it("F-ORD-3: a Date attribute's ISO-8601 UTC text orders chronologically", () => {
    const instants = ["2025-12-31T23:59:59.999Z", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.001Z"]
    for (let i = 0; i < instants.length; i++) {
      for (let j = 0; j < instants.length; j++) {
        const chronological = Date.parse(instants[i]!) < Date.parse(instants[j]!)
        expect(evaluate(Filter.lt("createdAt", instants[j]!), { createdAt: instants[i]! })).toBe(truth(chronological))
      }
    }
    // exact at the precision the grammar can express: no rounding to match
    expect(
      evaluate(Filter.eq("createdAt", "2026-01-01T00:00:00.000Z"), { createdAt: "2026-01-01T00:00:00.001Z" })
    ).toBe("FALSE")
  })

  it("F-ORD-4: a literal union orders alphabetically, not by declaration order", () => {
    // declared ["draft", "published", "archived"]; the order is over the names
    expect(evaluate(Filter.lt("status", "draft"), { status: "archived" })).toBe("TRUE")
    expect(evaluate(Filter.gt("status", "draft"), { status: "published" })).toBe("TRUE")
  })
})

describe("filter profile §6.3.1 — the comparison truth table", () => {
  const rows = [
    { relation: "V < L", value: 1 },
    { relation: "V = L", value: 2 },
    { relation: "V > L", value: 3 }
  ] as const

  const expected: { readonly [op in Filter.CompareOperator]: readonly [Truth, Truth, Truth] } = {
    eq: ["FALSE", "TRUE", "FALSE"],
    ne: ["TRUE", "FALSE", "TRUE"],
    lt: ["TRUE", "FALSE", "FALSE"],
    lte: ["TRUE", "TRUE", "FALSE"],
    gt: ["FALSE", "FALSE", "TRUE"],
    gte: ["FALSE", "TRUE", "TRUE"]
  }

  const node = (op: Filter.CompareOperator): Filter.Node => ({ _tag: "Compare", op, field: "age", value: 2 })

  for (const op of ["eq", "ne", "lt", "lte", "gt", "gte"] as const) {
    it(`F-CMP-1 / F-CMP-2: ${op}`, () => {
      // F-CMP-1: NULL on the left is UNKNOWN, for every comparison
      expect(evaluate(node(op), { age: NULL })).toBe("UNKNOWN")
      // F-CMP-2: the documented row
      rows.forEach(({ value }, index) => {
        expect(evaluate(node(op), { age: value })).toBe(expected[op][index])
      })
    })
  }

  it("F-CMP-3: eq and ne do not partition — a NULL is in neither", () => {
    const row: Row = { status: NULL }
    expect(matches(Filter.eq("status", "done"), row)).toBe(false)
    expect(matches(Filter.ne("status", "done"), row)).toBe(false)
    // and they do partition everywhere else
    for (const status of ["done", "open"]) {
      expect(matches(Filter.eq("status", "done"), { status })).not.toBe(
        matches(Filter.ne("status", "done"), { status })
      )
    }
  })
})

describe("filter profile §6.3.2 — membership", () => {
  const values = ["a", "b"] as const
  const isIn = Filter.isIn("title", values) as Filter.Node
  const notIn = Filter.notIn("title", values) as Filter.Node

  it("F-IN-3: the in / nin table, including NULL", () => {
    const table = [
      { row: { title: NULL } as Row, in: "UNKNOWN", nin: "UNKNOWN" },
      { row: { title: "a" } as Row, in: "TRUE", nin: "FALSE" },
      { row: { title: "z" } as Row, in: "FALSE", nin: "TRUE" }
    ] as const
    for (const { row, in: inTruth, nin } of table) {
      expect(evaluate(isIn, row)).toBe(inTruth)
      expect(evaluate(notIn, row)).toBe(nin)
    }
  })

  it("F-IN-3: SQL's NOT IN and the negation of IN coincide, because a list never holds NULL", () => {
    for (const row of [{ title: NULL }, { title: "a" }, { title: "z" }] as ReadonlyArray<Row>) {
      expect(evaluate(notIn, row)).toBe(evaluate(Filter.not(isIn) as Filter.Node, row))
    }
  })

  it("F-IN-4: order and multiplicity of a list carry no meaning", () => {
    const rows: ReadonlyArray<Row> = [{ title: "a" }, { title: "b" }, { title: "z" }, { title: NULL }]
    for (const row of rows) {
      expect(evaluate(Filter.isIn("title", ["b", "a", "b"]) as Filter.Node, row)).toBe(evaluate(isIn, row))
    }
  })
})

describe("filter profile §6.3.3 — the connectives", () => {
  const leaf = (value: Truth): Filter.Node =>
    value === "UNKNOWN" ? Filter.eq("age", 1) : Filter.eq("flag", value === "TRUE")
  const row: Row = { age: NULL, flag: true }

  it("F-LOGIC-1: the fixtures realise each truth value", () => {
    for (const value of values) expect(evaluate(leaf(value), row)).toBe(value)
  })

  it("F-LOGIC-1: And and Or fold the Kleene tables", () => {
    for (const a of values) {
      for (const b of values) {
        expect(evaluate(Filter.and(leaf(a), leaf(b)) as Filter.Node, row)).toBe(AND[a][b])
        expect(evaluate(Filter.or(leaf(a), leaf(b)) as Filter.Node, row)).toBe(OR[a][b])
        expect(evaluate(Filter.not(leaf(a)) as Filter.Node, row)).toBe(NOT[a])
      }
    }
  })

  it("F-AND-1: the folds are commutative, associative and idempotent, so §3.2's sorting is safe", () => {
    for (const a of values) {
      for (const b of values) {
        expect(AND[a][b]).toBe(AND[b][a])
        expect(OR[a][b]).toBe(OR[b][a])
        expect(AND[a][a]).toBe(a)
        expect(OR[a][a]).toBe(a)
        for (const c of values) {
          expect(AND[AND[a][b]][c]).toBe(AND[a][AND[b][c]])
          expect(OR[OR[a][b]][c]).toBe(OR[a][OR[b][c]])
        }
      }
    }
  })

  it("F-AND-2: And([]) matches everything and Or([]) matches nothing", () => {
    for (const candidate of [{ status: "open" }, { status: NULL }, {}] as ReadonlyArray<Row>) {
      expect(matches({ _tag: "And", members: [] }, candidate)).toBe(true)
      expect(matches({ _tag: "Or", members: [] }, candidate)).toBe(false)
    }
  })
})

describe("filter profile §6.3.4 — isnull", () => {
  it("F-ISNULL-1 / F-ISNULL-2: total, never UNKNOWN", () => {
    for (const row of [{ deletedAt: NULL }, { deletedAt: "2026-01-01T00:00:00.000Z" }, {}] as ReadonlyArray<Row>) {
      for (const negated of [false, true]) {
        expect(evaluate(Filter.isNull("deletedAt", negated), row)).not.toBe("UNKNOWN")
      }
    }
    expect(evaluate(Filter.isNull("deletedAt"), { deletedAt: NULL })).toBe("TRUE")
    expect(evaluate(Filter.isNull("deletedAt", true), { deletedAt: NULL })).toBe("FALSE")
  })

  it("F-ISNULL-3: negated isnull is exactly Not(isnull)", () => {
    for (const row of [{ deletedAt: NULL }, { deletedAt: "x" }, {}] as ReadonlyArray<Row>) {
      expect(evaluate(Filter.isNull("deletedAt", true), row)).toBe(
        evaluate(Filter.not(Filter.isNull("deletedAt")) as Filter.Node, row)
      )
    }
  })

  it("F-ISNULL-4: on a field that can never be NULL it is a constant, not an error", () => {
    const row: Row = { title: "x" }
    expect(matches(Filter.isNull("title"), row)).toBe(false)
    expect(matches(Filter.isNull("title", true), row)).toBe(true)
  })
})

describe("filter profile §6.5 — the consequences", () => {
  const rows: ReadonlyArray<Row> = [{ title: "a", age: 1 }, { title: "z", age: 9 }, { title: NULL, age: NULL }, {}]
  const a = Filter.eq("title", "a") as Filter.Node
  const b = Filter.gt("age", 5) as Filter.Node

  it("F-CONS-1: excluded middle fails — Or(x, Not(x)) misses the NULLs", () => {
    const everything = Filter.or(a, Filter.not(a)) as Filter.Node
    expect(rows.map((row) => matches(everything, row))).toEqual([true, true, false, false])
    // the complement of a filter names the NULLs explicitly
    const complement = Filter.or(Filter.not(a), Filter.isNull("title")) as Filter.Node
    for (const row of rows) expect(matches(a, row) || matches(complement, row)).toBe(true)
  })

  it("F-CONS-2: De Morgan holds in both directions, for all three values", () => {
    for (const row of rows) {
      expect(evaluate(Filter.not(Filter.and(a, b)) as Filter.Node, row)).toBe(
        evaluate(Filter.or(Filter.not(a), Filter.not(b)) as Filter.Node, row)
      )
      expect(evaluate(Filter.not(Filter.or(a, b)) as Filter.Node, row)).toBe(
        evaluate(Filter.and(Filter.not(a), Filter.not(b)) as Filter.Node, row)
      )
    }
  })

  it("F-CONS-3: Not(In) is NotIn", () => {
    const list = Filter.isIn("title", ["a", "b"]) as Filter.Node
    for (const row of rows) {
      expect(evaluate(Filter.not(list) as Filter.Node, row)).toBe(
        evaluate(Filter.notIn("title", ["a", "b"]) as Filter.Node, row)
      )
    }
  })

  it("F-CONS-4: Not(Not(x)) is x, so leaving a double negation unsimplified is syntax only", () => {
    for (const row of rows) {
      expect(evaluate(Filter.not(Filter.not(a)) as Filter.Node, row)).toBe(evaluate(a, row))
    }
  })
})
