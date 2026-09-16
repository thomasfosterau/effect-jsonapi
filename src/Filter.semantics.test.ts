/**
 * Conformance tests for the filter profile's semantics — `docs/filter-grammar.md`
 * §6, rule by rule, against the reference interpreter.
 *
 * Every assertion here is a normative statement of the profile, not an
 * implementation detail: a third-party server implementing the profile should
 * answer the same way, and these are the cases to check itself against.
 */
import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import * as Filter from "./Filter.js"
import * as Resource from "./Resource.js"

// A resource exercising each literal kind the profile admits.
const Article = Resource.make("articles", {
  attributes: {
    // nullable, so NULL is reachable
    status: Resource.attribute(Schema.NullOr(Schema.String), { filter: true }),
    views: Resource.attribute(Schema.Number, { filter: true }),
    title: Resource.attribute(Schema.String, { filter: true }),
    publishedAt: Resource.attribute(Schema.DateFromString, { filter: true }),
    flag: Resource.attribute(Schema.Boolean, { filter: true }),
    // an attribute declared filterable but left off some subjects entirely
    slug: Resource.attribute(Schema.optionalKey(Schema.String), { filter: true })
  }
})

const fields = Resource.filterable(Article)

const truth = (node: Filter.Node, subject: Filter.Subject): Filter.Truth => Filter.evaluate(node, subject, fields)
const matches = (node: Filter.Node, subject: Filter.Subject): boolean => Filter.matches(node, subject, fields)

// The three truths, as trees over a subject that supplies each.
const TRUE = Filter.eq("status", "open")
const FALSE = Filter.eq("status", "shut")
const UNKNOWN = Filter.eq("views", 1)
const subject = { status: "open", views: null }

describe("§6.2 the logic is three-valued", () => {
  it("fixes the three trees the truth tables below are written over", () => {
    expect(truth(TRUE, subject)).toBe(true)
    expect(truth(FALSE, subject)).toBe(false)
    expect(truth(UNKNOWN, subject)).toBe(undefined)
  })

  it("makes every comparison against NULL UNKNOWN", () => {
    const nulled = { status: null }
    expect(truth(Filter.eq("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.ne("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.lt("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.lte("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.gt("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.gte("status", "open"), nulled)).toBe(undefined)
    expect(truth(Filter.isIn("status", ["open"]), nulled)).toBe(undefined)
    expect(truth(Filter.notIn("status", ["open"]), nulled)).toBe(undefined)
  })

  it("keeps a negated UNKNOWN UNKNOWN — so `not(eq(f, x))` does not match a NULL row", () => {
    // The question §6.2 exists to answer. Under two-valued logic this row would
    // match; under this profile it does not.
    const nulled = { status: null }
    expect(truth(Filter.not(Filter.eq("status", "open")), nulled)).toBe(undefined)
    expect(matches(Filter.not(Filter.eq("status", "open")), nulled)).toBe(false)
    expect(matches(Filter.ne("status", "open"), nulled)).toBe(false)
  })

  it("negates TRUE and FALSE as usual", () => {
    expect(truth(Filter.not(TRUE), subject)).toBe(false)
    expect(truth(Filter.not(FALSE), subject)).toBe(true)
    expect(truth(Filter.not(Filter.not(UNKNOWN)), subject)).toBe(undefined)
  })

  it("gives AND the Kleene table: FALSE dominates, else UNKNOWN if any is", () => {
    const and = (...members: ReadonlyArray<Filter.Node>) => truth(Filter.and(...members), subject)
    expect(and(TRUE, TRUE)).toBe(true)
    expect(and(TRUE, FALSE)).toBe(false)
    expect(and(TRUE, UNKNOWN)).toBe(undefined)
    expect(and(FALSE, FALSE)).toBe(false)
    expect(and(FALSE, UNKNOWN)).toBe(false)
    expect(and(UNKNOWN, UNKNOWN)).toBe(undefined)
  })

  it("gives OR the Kleene table: TRUE dominates, else UNKNOWN if any is", () => {
    const or = (...members: ReadonlyArray<Filter.Node>) => truth(Filter.or(...members), subject)
    expect(or(TRUE, TRUE)).toBe(true)
    expect(or(TRUE, FALSE)).toBe(true)
    expect(or(TRUE, UNKNOWN)).toBe(true)
    expect(or(FALSE, FALSE)).toBe(false)
    expect(or(FALSE, UNKNOWN)).toBe(undefined)
    expect(or(UNKNOWN, UNKNOWN)).toBe(undefined)
  })

  it("makes the empty groups the identities of their conjunctions", () => {
    expect(truth(Filter.and(), subject)).toBe(true)
    expect(truth(Filter.or(), subject)).toBe(false)
  })

  it("puts a resource in the result set only when the filter is TRUE", () => {
    expect(matches(TRUE, subject)).toBe(true)
    expect(matches(FALSE, subject)).toBe(false)
    expect(matches(UNKNOWN, subject)).toBe(false)
  })
})

describe("§6.3 an absent attribute is NULL", () => {
  it("treats an absent key exactly as an explicit null", () => {
    expect(truth(Filter.eq("slug", "a"), {})).toBe(undefined)
    expect(truth(Filter.eq("slug", "a"), { slug: null })).toBe(undefined)
    expect(truth(Filter.isNull("slug"), {})).toBe(true)
    expect(truth(Filter.isNull("slug"), { slug: null })).toBe(true)
  })

  it("distinguishes it from a present value", () => {
    expect(truth(Filter.isNull("slug"), { slug: "a" })).toBe(false)
    expect(truth(Filter.eq("slug", "a"), { slug: "a" })).toBe(true)
  })
})

describe("§6.4 NULL is never a literal, and `isnull` is the only NULL test", () => {
  it("refuses a null in a scalar literal position", () => {
    expect(Schema.is(Filter.Ast)({ _tag: "Compare", op: "eq", field: "status", value: null })).toBe(false)
    expect(() =>
      Schema.decodeUnknownSync(Filter.Ast)({ _tag: "Compare", op: "eq", field: "status", value: null })
    ).toThrow(/isnull/)
  })

  it("refuses a null in a list literal position", () => {
    expect(Schema.is(Filter.Ast)({ _tag: "In", field: "status", values: ["a", null] })).toBe(false)
    expect(Schema.is(Filter.Ast)({ _tag: "NotIn", field: "status", values: [null] })).toBe(false)
  })

  it("still admits every non-null literal, including falsy ones", () => {
    expect(Schema.is(Filter.Ast)({ _tag: "Compare", op: "eq", field: "title", value: "" })).toBe(true)
    expect(Schema.is(Filter.Ast)({ _tag: "Compare", op: "eq", field: "views", value: 0 })).toBe(true)
    expect(Schema.is(Filter.Ast)({ _tag: "Compare", op: "eq", field: "flag", value: false })).toBe(true)
  })

  it("makes `isnull` total — it is the one node that is never UNKNOWN", () => {
    expect(truth(Filter.isNull("status"), { status: null })).toBe(true)
    expect(truth(Filter.isNull("status"), { status: "open" })).toBe(false)
    expect(truth(Filter.isNull("status", true), { status: null })).toBe(false)
    expect(truth(Filter.isNull("status", true), { status: "open" })).toBe(true)
  })
})

describe("§6.5 NotIn is exactly the negation of In", () => {
  const subjects: ReadonlyArray<Filter.Subject> = [{ status: "open" }, { status: "done" }, { status: null }, {}]

  it("agrees with `not(in(...))` on every subject, NULL included", () => {
    // The SQL `NOT IN` trap needs a NULL inside the list, and §6.4 makes that
    // unrepresentable — so the two spellings cannot diverge here.
    for (const s of subjects) {
      expect(truth(Filter.notIn("status", ["open", "shut"]), s)).toBe(
        truth(Filter.not(Filter.isIn("status", ["open", "shut"])), s)
      )
    }
  })

  it("is UNKNOWN, not TRUE, for a NULL field", () => {
    expect(truth(Filter.notIn("status", ["open"]), { status: null })).toBe(undefined)
    expect(matches(Filter.notIn("status", ["open"]), { status: null })).toBe(false)
  })

  it("matches a non-NULL field outside the list", () => {
    expect(truth(Filter.notIn("status", ["open"]), { status: "done" })).toBe(true)
  })
})

describe("§6.6 equality is equality of the encoded form", () => {
  it("compares a Date by its encoding, not by object identity", () => {
    const when = new Date("2026-01-02T03:04:05.000Z")
    expect(truth(Filter.eq("publishedAt", new Date(when.getTime())), { publishedAt: when })).toBe(true)
    expect(truth(Filter.eq("publishedAt", new Date("2020-01-01T00:00:00.000Z")), { publishedAt: when })).toBe(false)
  })

  it("is insensitive to a brand, which the encoding erases", () => {
    expect(truth(Filter.eq("title", "Hello"), { title: "Hello" })).toBe(true)
  })

  it("drives `in` and `nin` too", () => {
    const when = new Date("2026-01-02T03:04:05.000Z")
    expect(truth(Filter.isIn("publishedAt", [new Date(when.getTime())]), { publishedAt: when })).toBe(true)
    expect(truth(Filter.notIn("publishedAt", [new Date(when.getTime())]), { publishedAt: when })).toBe(false)
  })
})

describe("§6.6 ordering is defined per decoded kind", () => {
  it("orders numbers numerically, not as their encodings", () => {
    // The case that distinguishes the two: "10" sorts before "9" as text.
    expect(truth(Filter.gt("views", 9), { views: 10 })).toBe(true)
    expect(truth(Filter.lt("views", 9), { views: 10 })).toBe(false)
  })

  it("orders strings by code point, not by UTF-16 code unit", () => {
    // U+FFFD is one code unit; U+1F600 is a surrogate pair whose first unit
    // (0xD83D) is lower — so JS's own `<` disagrees with code-point order.
    const replacement = "�"
    const emoji = "\u{1F600}"
    expect(replacement < emoji).toBe(false) // what JS string comparison says
    expect(truth(Filter.lt("title", emoji), { title: replacement })).toBe(true) // what the profile says
    expect(truth(Filter.gt("title", replacement), { title: emoji })).toBe(true)
  })

  it("orders dates chronologically", () => {
    const early = new Date("2020-01-01T00:00:00.000Z")
    const late = new Date("2026-01-01T00:00:00.000Z")
    expect(truth(Filter.gte("publishedAt", early), { publishedAt: late })).toBe(true)
    expect(truth(Filter.lte("publishedAt", early), { publishedAt: late })).toBe(false)
    expect(truth(Filter.lte("publishedAt", early), { publishedAt: early })).toBe(true)
  })

  it("refuses to order a kind the profile gives no ordering", () => {
    // A boolean is comparable for equality and nothing else; the profile says
    // so, and the reference interpreter refuses rather than inventing an order.
    expect(truth(Filter.eq("flag", true), { flag: true })).toBe(true)
    expect(() => truth(Filter.gt("flag", false), { flag: true })).toThrow(/no ordering in this profile/)
  })
})

describe("§6 the semantics cover the closed operator core and nothing else", () => {
  it("has a rule for every operator in the vocabulary", () => {
    // If an operator is ever added to §4, this fails until §6 grows a rule and
    // the interpreter grows a case.
    const covered = new Set(["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"])
    expect([...Filter.operators].sort()).toEqual([...covered].sort())
  })

  it("evaluates a nested tree of them", () => {
    const filter = Filter.or(Filter.and(Filter.eq("status", "open"), Filter.gt("views", 5)), Filter.isNull("status"))
    expect(matches(filter, { status: "open", views: 10 })).toBe(true)
    expect(matches(filter, { status: "open", views: 1 })).toBe(false)
    expect(matches(filter, { status: null, views: 1 })).toBe(true)
  })
})
