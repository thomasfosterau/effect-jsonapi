import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect, Layer, Schema, SchemaIssue } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApi, HttpApiBuilder, OpenApi } from "effect/unstable/httpapi"
import * as ApiError from "./ApiError.js"
import * as Endpoint from "./Endpoint.js"
import * as Filter from "./Filter.js"
import * as Group from "./Group.js"
import * as Middleware from "./Middleware.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { attribute, filterable, make as Resource, readOnlyAttribute } from "./Resource.js"
import type { FilterableKeys } from "./Resource.js"

// ---------------------------------------------------------------------------
// Fixture: every literal kind the grammar types, plus a filterable relationship
// ---------------------------------------------------------------------------

const Person = Resource("people", { attributes: { name: Schema.NonEmptyString } })

const Article = Resource("articles", {
  attributes: {
    status: attribute(Schema.Literals(["open", "done", "archived"]), { filter: true }),
    age: attribute(Schema.Number, { filter: true }),
    priority: attribute(Schema.Int, { filter: ["eq", "in", "nin"] }),
    title: attribute(Schema.String, { filter: ["eq", "ne", "in", "nin"] }),
    deletedAt: attribute(Schema.NullOr(Schema.DateFromString), { filter: ["isnull", "gte", "lte"] }),
    createdAt: readOnlyAttribute(Schema.DateFromString, { filter: ["eq", "gte", "lte"] }),
    flag: attribute(Schema.Boolean, { filter: ["eq"] }),
    limit: attribute(Schema.Number, { filter: ["eq"] }),
    body: Schema.String // not filterable
  },
  relationships: {
    author: Relationship.one(() => Person, { filter: true }),
    editor: Relationship.optional(() => Person),
    comments: Relationship.many(() => Person)
  }
})

const fields = filterable(Article)
const codec = Query.Filter(Article)
type Ast = typeof codec.Type
const decode = (record: Record<string, unknown>): Ast => Schema.decodeUnknownSync(codec)(record)
const encode = (ast: Ast): Record<string, string> => Schema.encodeSync(codec)(ast) as Record<string, string>
const canonical = (record: Record<string, unknown>): ReadonlyArray<readonly [string, string]> =>
  Object.entries(encode(decode(record)))

// The offending keys of a failed decode, in order, with their messages.
const failures = (
  record: Record<string, unknown>
): ReadonlyArray<{ readonly key: string; readonly message: string }> => {
  const result = Schema.decodeUnknownResult(codec)(record)
  if (result._tag === "Success") throw new Error("expected the decode to fail")
  return SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.map((issue) => ({
    key: String(issue.path?.[0]),
    message: issue.message
  }))
}

const eq = Filter.eq
const gt = Filter.gt
const lte = Filter.lte

// The query-string spelling of a pair list, for reading the design's examples
// side by side with the assertions.
const url = (pairs: ReadonlyArray<readonly [string, string]>): string => pairs.map(([k, v]) => `${k}=${v}`).join("&")

// ---------------------------------------------------------------------------
// §3.4 worked examples
// ---------------------------------------------------------------------------

describe("Query.Filter: the design's worked examples (§3.4)", () => {
  const examples: ReadonlyArray<readonly [string, string, Ast]> = [
    ["filter[status]", "open", eq("status", "open")],
    ["filter[status][ne]", "done", Filter.ne("status", "done")],
    ["filter[age][lt]", "18", Filter.lt("age", 18)],
    ["filter[age][lte]", "18", lte("age", 18)],
    ["filter[age][gt]", "18", gt("age", 18)],
    ["filter[age][gte]", "18", Filter.gte("age", 18)],
    ["filter[priority]", "1,2", Filter.isIn("priority", [1, 2])],
    ["filter[priority][in]", "1", Filter.isIn("priority", [1])],
    ["filter[status][nin]", "archived,done", Filter.notIn("status", ["archived", "done"])],
    ["filter[deletedAt][isnull]", "true", Filter.isNull("deletedAt")],
    ["filter[deletedAt][isnull]", "false", Filter.isNull("deletedAt", true)],
    ["filter[title]", "Hello\\, world", eq("title", "Hello, world")]
  ]

  for (const [key, value, ast] of examples) {
    it(`${key}=${value} decodes and re-encodes canonically`, () => {
      expect(decode({ [key]: value })).toEqual(ast)
      expect(encode(ast)).toEqual({ [key]: value })
      expect(canonical({ [key]: value })).toEqual([[key, value]])
    })
  }

  it("decodes the two-condition filter written three ways to one tree and one canonical string", () => {
    const tree = Filter.and(gt("age", 18), eq("status", "open"))
    const spellings = [
      { "filter[status]": "open", "filter[age][gt]": "18" },
      { "filter[age][gt]": "18", "filter[status]": "open" },
      {
        "filter[c1][condition][path]": "status",
        "filter[c1][condition][operator]": "eq",
        "filter[c1][condition][value]": "open",
        "filter[x][condition][path]": "age",
        "filter[x][condition][operator]": "gt",
        "filter[x][condition][value]": "18"
      }
    ]
    for (const spelling of spellings) {
      expect(decode(spelling)).toEqual(tree)
      expect(url(canonical(spelling))).toBe("filter[age][gt]=18&filter[status]=open")
    }
  })

  it("decodes and canonicalises the nested OR of two ANDs byte for byte", () => {
    const input = {
      "filter[or][group][conjunction]": "OR",
      "filter[a][group][conjunction]": "AND",
      "filter[a][group][memberOf]": "or",
      "filter[a1][condition][path]": "status",
      "filter[a1][condition][operator]": "eq",
      "filter[a1][condition][value]": "open",
      "filter[a1][condition][memberOf]": "a",
      "filter[a2][condition][path]": "age",
      "filter[a2][condition][operator]": "gt",
      "filter[a2][condition][value]": "18",
      "filter[a2][condition][memberOf]": "a",
      "filter[b][group][conjunction]": "AND",
      "filter[b][group][memberOf]": "or",
      "filter[b1][condition][path]": "status",
      "filter[b1][condition][operator]": "eq",
      "filter[b1][condition][value]": "done",
      "filter[b1][condition][memberOf]": "b",
      "filter[b2][condition][path]": "age",
      "filter[b2][condition][operator]": "lte",
      "filter[b2][condition][value]": "18",
      "filter[b2][condition][memberOf]": "b"
    }
    const tree = Filter.or(
      Filter.and(gt("age", 18), eq("status", "open")),
      Filter.and(lte("age", 18), eq("status", "done"))
    )
    expect(decode(input)).toEqual(tree)
    const expected: ReadonlyArray<readonly [string, string]> = [
      ["filter[g0][group][conjunction]", "OR"],
      ["filter[g1][group][conjunction]", "AND"],
      ["filter[g1][group][memberOf]", "g0"],
      ["filter[c0][condition][path]", "age"],
      ["filter[c0][condition][operator]", "gt"],
      ["filter[c0][condition][value]", "18"],
      ["filter[c0][condition][memberOf]", "g1"],
      ["filter[c1][condition][path]", "status"],
      ["filter[c1][condition][operator]", "eq"],
      ["filter[c1][condition][value]", "open"],
      ["filter[c1][condition][memberOf]", "g1"],
      ["filter[g2][group][conjunction]", "AND"],
      ["filter[g2][group][memberOf]", "g0"],
      ["filter[c2][condition][path]", "age"],
      ["filter[c2][condition][operator]", "lte"],
      ["filter[c2][condition][value]", "18"],
      ["filter[c2][condition][memberOf]", "g2"],
      ["filter[c3][condition][path]", "status"],
      ["filter[c3][condition][operator]", "eq"],
      ["filter[c3][condition][value]", "done"],
      ["filter[c3][condition][memberOf]", "g2"]
    ]
    expect(canonical(input)).toEqual(expected)
    // ids are a function of the tree: a hand-built tree in any member order encodes the same
    expect(
      Object.entries(
        encode(
          Filter.or(Filter.and(eq("status", "done"), lte("age", 18)), Filter.and(eq("status", "open"), gt("age", 18)))
        )
      )
    ).toEqual(expected)
    // and the canonical string decodes to the same tree
    expect(decode(Object.fromEntries(expected))).toEqual(tree)
  })

  it("encodes NOT (status = open) in the group form", () => {
    const pairs = Object.entries(encode(Filter.not(eq("status", "open"))))
    expect(pairs).toEqual([
      ["filter[g0][group][conjunction]", "NOT"],
      ["filter[c0][condition][path]", "status"],
      ["filter[c0][condition][operator]", "eq"],
      ["filter[c0][condition][value]", "open"],
      ["filter[c0][condition][memberOf]", "g0"]
    ])
    expect(decode(Object.fromEntries(pairs))).toEqual(Filter.not(eq("status", "open")))
  })
})

// ---------------------------------------------------------------------------
// Shorthand (§2.2), literals (§2.3) and the encoder's choice of form (§3.1)
// ---------------------------------------------------------------------------

describe("Query.Filter: shorthand and literals", () => {
  it("keeps `filter[f]=v` as eq and `filter[f]=a,b` as in (unchanged for today's consumers)", () => {
    expect(decode({ "filter[status]": "open" })).toEqual(eq("status", "open"))
    expect(decode({ "filter[priority]": "1,2" })).toEqual(Filter.isIn("priority", [1, 2]))
    // a relationship field, valued by the related id (branded)
    const author = decode({ "filter[author]": "9" })
    expect(author).toEqual(eq("author", "9"))
    expect(decode({ "filter[author]": "9,10" })).toEqual(
      Filter.isIn("author", [Person.Id.make("10"), Person.Id.make("9")])
    )
  })

  it("accepts the explicit eq spelling and canonicalises it bare", () => {
    expect(decode({ "filter[status][eq]": "open" })).toEqual(eq("status", "open"))
    expect(canonical({ "filter[status][eq]": "open" })).toEqual([["filter[status]", "open"]])
  })

  it("types every literal through the attribute schema", () => {
    expect(decode({ "filter[age][gt]": "1.5" })).toEqual(gt("age", 1.5))
    expect(decode({ "filter[flag]": "true" })).toEqual(eq("flag", true))
    const when = decode({ "filter[createdAt][gte]": "2026-01-01T00:00:00.000Z" })
    expect(when).toEqual(Filter.gte("createdAt", new Date("2026-01-01T00:00:00.000Z")))
    // NullOr is stripped: the literal is the Date, never null
    expect(decode({ "filter[deletedAt][gte]": "2026-01-01T00:00:00.000Z" })).toEqual(
      Filter.gte("deletedAt", new Date("2026-01-01T00:00:00.000Z"))
    )
    expect(decode({ "filter[status]": "done" })).toEqual(eq("status", "done"))
  })

  it("re-encodes literals through the attribute schema (canonical values)", () => {
    expect(canonical({ "filter[limit]": "010" })).toEqual([["filter[limit]", "10"]])
    expect(canonical({ "filter[createdAt]": "2026-01-01T00:00:00Z" })).toEqual([
      ["filter[createdAt]", "2026-01-01T00:00:00.000Z"]
    ])
    expect(canonical({ "filter[age][gt]": "+1e1" })).toEqual([["filter[age][gt]", "10"]])
  })

  it("applies the escape grammar: \\, and \\\\ only", () => {
    expect(decode({ "filter[title]": "a\\\\b" })).toEqual(eq("title", "a\\b"))
    expect(decode({ "filter[title]": "a\\,b,c" })).toEqual(Filter.isIn("title", ["a,b", "c"]))
    expect(decode({ "filter[title][in]": "x\\,y" })).toEqual(Filter.isIn("title", ["x,y"]))
    expect(encode(eq("title", "a,b\\c"))).toEqual({ "filter[title]": "a\\,b\\\\c" })
    expect(encode(Filter.isIn("title", ["b,", "a"]))).toEqual({ "filter[title]": "a,b\\," })
    expect(failures({ "filter[title]": "bad\\x" })).toEqual([
      { key: "filter[title]", message: "Malformed literal: unknown escape \\x; only \\, and \\\\ are escapes" }
    ])
    expect(failures({ "filter[title]": "trailing\\" })[0]?.message).toMatch(/trailing backslash/)
  })

  it("rejects an unescaped comma in a scalar position", () => {
    expect(failures({ "filter[title][ne]": "a,b" })).toEqual([
      {
        key: "filter[title][ne]",
        message: "Malformed literal: an unescaped comma in a scalar position (write \\, for a comma)"
      }
    ])
    expect(failures({ "filter[age][gt]": "1,2" })[0]?.key).toBe("filter[age][gt]")
  })

  it("treats the empty string as a literal", () => {
    expect(decode({ "filter[title]": "" })).toEqual(eq("title", ""))
    expect(encode(eq("title", ""))).toEqual({ "filter[title]": "" })
    // …which the number literal codec then rejects
    expect(failures({ "filter[age]": "" })[0]).toMatchObject({ key: "filter[age]" })
    // and a list with an empty item is a list
    expect(decode({ "filter[title]": "a," })).toEqual(Filter.isIn("title", ["", "a"]))
  })

  it("rejects an isnull value other than true / false", () => {
    expect(failures({ "filter[deletedAt][isnull]": "yes" })).toEqual([
      { key: "filter[deletedAt][isnull]", message: 'Expected true or false for isnull, got "yes"' }
    ])
  })

  it("chooses shorthand only when it decodes back to the same tree (§3.1)", () => {
    // single-value In is written [in], so it does not come back as eq
    expect(encode(Filter.isIn("priority", [1]))).toEqual({ "filter[priority][in]": "1" })
    // And with one member is a different tree from the member alone
    expect(Object.keys(encode(Filter.and(eq("status", "open"))))).toEqual([
      "filter[g0][group][conjunction]",
      "filter[c0][condition][path]",
      "filter[c0][condition][operator]",
      "filter[c0][condition][value]",
      "filter[c0][condition][memberOf]"
    ])
    expect(decode(encode(Filter.and(eq("status", "open"))))).toEqual(Filter.and(eq("status", "open")))
    // a repeated (field, operator) pair needs the group form
    const repeated = Filter.and(gt("age", 18), gt("age", 20))
    expect(Object.keys(encode(repeated))[0]).toBe("filter[g0][group][conjunction]")
    expect(decode(encode(repeated))).toEqual(repeated)
    // a bare eq and a bare in on the same field would share a key
    const shared = Filter.and(eq("title", "a"), Filter.isIn("title", ["a", "b"]))
    expect(Object.keys(encode(shared))[0]).toBe("filter[g0][group][conjunction]")
    expect(decode(encode(shared))).toEqual(shared)
    // empty groups are representable, in the group form
    expect(encode(Filter.and())).toEqual({ "filter[g0][group][conjunction]": "AND" })
    expect(encode(Filter.or())).toEqual({ "filter[g0][group][conjunction]": "OR" })
    expect(decode({ "filter[g][group][conjunction]": "OR" })).toEqual(Filter.or())
    // any Or or Not, or a nested group, is the group form
    expect(Object.keys(encode(Filter.or(eq("status", "open"), eq("status", "done"))))[0]).toBe(
      "filter[g0][group][conjunction]"
    )
    expect(Object.keys(encode(Filter.and(eq("status", "open"), Filter.and())))[0]).toBe(
      "filter[g0][group][conjunction]"
    )
  })

  it("sorts shorthand pairs by key, code-point order (§3.3)", () => {
    expect(
      Object.keys(encode(Filter.and(eq("status", "open"), Filter.isNull("deletedAt"), gt("age", 1), lte("age", 9))))
    ).toEqual(["filter[age][gt]", "filter[age][lte]", "filter[deletedAt][isnull]", "filter[status]"])
  })
})

// ---------------------------------------------------------------------------
// Normal form (§3.2)
// ---------------------------------------------------------------------------

describe("Query.Filter: normal form", () => {
  it("sorts and deduplicates In / NotIn values by encoded string", () => {
    expect(decode({ "filter[priority]": "3,1,3,10,2" })).toEqual(Filter.isIn("priority", [1, 10, 2, 3]))
    expect(canonical({ "filter[status][nin]": "open,done,open" })).toEqual([["filter[status][nin]", "done,open"]])
    expect(Filter.normalise(Filter.isIn("priority", [3, 1, 3]), fields)).toEqual(Filter.isIn("priority", [1, 3]))
  })

  it("sorts And / Or members by the node order and deduplicates them", () => {
    // conditions before groups; conditions by field, operator, value; groups by conjunction then members
    const tree = Filter.or(
      Filter.not(eq("status", "open")),
      Filter.and(),
      Filter.or(),
      eq("status", "open"),
      gt("age", 2),
      gt("age", 1),
      eq("age", 5),
      eq("status", "open")
    )
    expect(Filter.normalise(tree, fields)).toEqual(
      Filter.or(
        eq("age", 5),
        gt("age", 1),
        gt("age", 2),
        eq("status", "open"),
        Filter.and(),
        Filter.not(eq("status", "open")),
        Filter.or()
      )
    )
    // `filter[f]=v` and `filter[f][eq]=v` are two keys that decode to one member
    expect(decode({ "filter[status]": "open", "filter[status][eq]": "open" })).toEqual(Filter.and(eq("status", "open")))
  })

  it("orders groups by their members pairwise, a shorter list first on a tie", () => {
    const short = Filter.and(gt("age", 1))
    const long = Filter.and(gt("age", 1), gt("age", 2))
    expect(Filter.normalise(Filter.or(long, short), fields)).toEqual(Filter.or(short, long))
    expect(Filter.normalise(Filter.or(Filter.and(gt("age", 2)), Filter.and(gt("age", 1))), fields)).toEqual(
      Filter.or(Filter.and(gt("age", 1)), Filter.and(gt("age", 2)))
    )
  })

  it("compares strings by code point, not code unit", () => {
    // U+FF01 (one code unit, 0xFF01) sorts before U+1F600 (code units 0xD83D 0xDE00) by code point,
    // after it by code unit
    expect(decode({ "filter[title][in]": "\u{1F600},！" })).toEqual(Filter.isIn("title", ["！", "\u{1F600}"]))
    expect(["\u{1F600}", "！"].sort()).toEqual(["\u{1F600}", "！"])
  })

  it("decode returns normal form, and encode normalises a hand-built tree", () => {
    const messy = Filter.and(eq("status", "open"), Filter.isIn("age", [2, 1, 2]), eq("status", "open"))
    expect(encode(messy)).toEqual({ "filter[age]": "1,2", "filter[status]": "open" })
    expect(decode(encode(messy))).toEqual(Filter.normalise(messy, fields))
  })
})

// ---------------------------------------------------------------------------
// Rejections (§2, §2.4, §7): one issue per offending key
// ---------------------------------------------------------------------------

describe("Query.Filter: rejections name the offending key", () => {
  it("rejects an unknown field", () => {
    expect(failures({ "filter[body]": "x" })).toEqual([{ key: "filter[body]", message: 'Unknown filter field "body"' }])
    expect(failures({ "filter[editor]": "1" })[0]?.key).toBe("filter[editor]")
    expect(failures({ "filter[nope][gt]": "1" })).toEqual([
      { key: "filter[nope][gt]", message: 'Unknown filter field "nope"' }
    ])
  })

  it("rejects an operator outside the closed core, and one the field does not declare", () => {
    expect(failures({ "filter[title][like]": "x" })).toEqual([
      {
        key: "filter[title][like]",
        message: 'Unknown filter operator "like"; expected one of eq, ne, lt, lte, gt, gte, in, nin, isnull'
      }
    ])
    expect(failures({ "filter[title][gt]": "x" })).toEqual([
      {
        key: "filter[title][gt]",
        message: 'Operator "gt" is not declared on field "title"; declared operators are eq, ne, in, nin'
      }
    ])
    // the bare list spelling is `in`, which must be declared too
    expect(failures({ "filter[flag]": "true,false" })[0]?.message).toMatch(/Operator "in" is not declared/)
  })

  it("rejects a literal the attribute schema refuses", () => {
    expect(failures({ "filter[age][gt]": "abc" })).toEqual([
      {
        key: "filter[age][gt]",
        message: 'Invalid literal "abc" for field "age": Expected a number filter literal, got "abc"'
      }
    ])
    expect(failures({ "filter[status]": "bogus" })[0]).toMatchObject({ key: "filter[status]" })
    expect(failures({ "filter[priority]": "1,1.5" })[0]?.message).toMatch(/Invalid literal "1.5"/)
    expect(failures({ "filter[flag]": "1" })[0]?.key).toBe("filter[flag]")
  })

  it("rejects a repeated key (only include is repeatable)", () => {
    expect(failures({ "filter[status]": ["open", "done"] })).toEqual([
      { key: "filter[status]", message: 'Repeated filter key "filter[status]"; a filter key may appear once' }
    ])
  })

  it("rejects malformed keys", () => {
    for (const key of [
      "filter[a][b][c]",
      "filter[a][b][c][d]",
      "filter[a][group][conjunction][x]",
      "filter[",
      "filter"
    ]) {
      const [failure] = failures({ [key]: "x" })
      expect(failure?.key).toBe(key)
      expect(failure?.message).toMatch(/^Malformed filter key/)
    }
  })

  it("reports one issue per offending key, in key order", () => {
    expect(
      failures({ "filter[body]": "x", "filter[age][gt]": "abc", "filter[status]": "open" }).map((f) => f.key)
    ).toEqual(["filter[body]", "filter[age][gt]"])
  })

  it("rejects on encode what it would reject on decode: an unknown field or undeclared operator", () => {
    const encoded = (ast: Filter.Node) => Schema.encodeUnknownResult(codec)(ast)
    // `title` declares eq ne in nin; `flag` declares eq only; `deletedAt` declares isnull gte lte
    for (const [tree, message] of [
      [Filter.lt("title", "x"), /Operator "lt" is not declared on field "title"/],
      [Filter.isIn("flag", [true]), /Operator "in" is not declared on field "flag"/],
      [Filter.notIn("flag", [true]), /Operator "nin" is not declared on field "flag"/],
      [Filter.isNull("title"), /Operator "isnull" is not declared on field "title"/],
      [Filter.and(eq("status", "open"), Filter.not(gt("title", "x"))), /Operator "gt" is not declared/],
      [eq("body", "x"), /Unknown filter field "body"/]
    ] as const) {
      const result = encoded(tree)
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") expect(result.failure.message).toMatch(message)
    }
    // …so a URL the codec emits always decodes back
    expect(decode(encode(Filter.isNull("deletedAt", true)))).toEqual(Filter.isNull("deletedAt", true))
  })

  it("rejects an empty record: an absent filter is Query.schema's concern", () => {
    const result = Schema.decodeUnknownResult(codec)({})
    expect(result._tag).toBe("Failure")
  })

  describe("group form", () => {
    const condition = (id: string, path: string, operator: string, value: string, memberOf?: string) => ({
      [`filter[${id}][condition][path]`]: path,
      [`filter[${id}][condition][operator]`]: operator,
      [`filter[${id}][condition][value]`]: value,
      ...(memberOf === undefined ? {} : { [`filter[${id}][condition][memberOf]`]: memberOf })
    })
    const group = (id: string, conjunction: string, memberOf?: string) => ({
      [`filter[${id}][group][conjunction]`]: conjunction,
      ...(memberOf === undefined ? {} : { [`filter[${id}][group][memberOf]`]: memberOf })
    })

    it("names the member's own key for a bad path, operator or value", () => {
      expect(failures(condition("c", "body", "eq", "x"))).toEqual([
        { key: "filter[c][condition][path]", message: 'Unknown filter field "body"' }
      ])
      expect(failures(condition("c", "title", "gt", "x"))[0]?.key).toBe("filter[c][condition][operator]")
      expect(failures(condition("c", "title", "like", "x"))[0]?.key).toBe("filter[c][condition][operator]")
      expect(failures(condition("c", "age", "gt", "x"))[0]?.key).toBe("filter[c][condition][value]")
      expect(failures(condition("c", "deletedAt", "isnull", "maybe"))[0]?.key).toBe("filter[c][condition][value]")
      expect(failures(condition("c", "title", "ne", "a,b"))[0]?.key).toBe("filter[c][condition][value]")
    })

    it("rejects an id used as both a group and a condition", () => {
      expect(failures({ ...group("x", "AND"), ...condition("x", "age", "gt", "1") })).toEqual([
        { key: "filter[x][condition][path]", message: 'Filter id "x" is used as both a group and a condition' }
      ])
    })

    it("rejects an unknown member name", () => {
      expect(failures({ "filter[g][group][conjunction]": "AND", "filter[g][group][mode]": "x" })).toEqual([
        { key: "filter[g][group][mode]", message: 'Unknown group member "mode"; expected one of conjunction, memberOf' }
      ])
      expect(failures({ ...condition("c", "age", "gt", "1"), "filter[c][condition][op]": "x" })).toEqual([
        {
          key: "filter[c][condition][op]",
          message: 'Unknown condition member "op"; expected one of path, operator, value, memberOf'
        }
      ])
    })

    it("rejects an unknown conjunction", () => {
      expect(failures(group("g", "XOR"))).toEqual([
        { key: "filter[g][group][conjunction]", message: 'Unknown conjunction "XOR"; expected AND, OR or NOT' }
      ])
    })

    it("names the missing key for a missing required member", () => {
      expect(failures({ "filter[g][group][memberOf]": "h", ...group("h", "AND") })).toEqual([
        { key: "filter[g][group][conjunction]", message: 'Missing required group member "conjunction"' }
      ])
      expect(
        failures({ "filter[c][condition][path]": "age", "filter[c][condition][value]": "1" }).map((f) => f.key)
      ).toEqual(["filter[c][condition][operator]"])
      expect(failures({ "filter[c][condition][path]": "age" }).map((f) => f.key)).toEqual([
        "filter[c][condition][operator]",
        "filter[c][condition][value]"
      ])
    })

    it("rejects a dangling or non-group memberOf at the memberOf key", () => {
      expect(failures(condition("c", "age", "gt", "1", "nowhere"))).toEqual([
        { key: "filter[c][condition][memberOf]", message: 'memberOf names an unknown group "nowhere"' }
      ])
      expect(failures({ ...condition("a", "age", "gt", "1"), ...condition("b", "age", "gt", "2", "a") })).toEqual([
        { key: "filter[b][condition][memberOf]", message: 'memberOf names "a", which is a condition, not a group' }
      ])
      expect(failures(group("g", "AND", "h"))[0]?.key).toBe("filter[g][group][memberOf]")
    })

    it("rejects a memberOf cycle at the first cycle member's memberOf key", () => {
      expect(failures({ ...group("a", "AND", "b"), ...group("b", "AND", "a") })).toEqual([
        { key: "filter[a][group][memberOf]", message: "memberOf forms a cycle" }
      ])
      expect(failures(group("self", "AND", "self"))).toEqual([
        { key: "filter[self][group][memberOf]", message: "memberOf forms a cycle" }
      ])
      // a cycle reached from outside is still one issue, at the cycle
      expect(
        failures({
          ...group("root", "AND"),
          ...group("a", "AND", "b"),
          ...group("b", "OR", "a"),
          ...group("c", "AND", "a")
        })
      ).toEqual([{ key: "filter[a][group][memberOf]", message: "memberOf forms a cycle" }])
    })

    it("rejects a NOT group without exactly one member", () => {
      expect(failures(group("n", "NOT"))).toEqual([
        { key: "filter[n][group][conjunction]", message: "A NOT group must have exactly one member, got 0" }
      ])
      expect(
        failures({
          ...group("n", "NOT"),
          ...condition("a", "age", "gt", "1", "n"),
          ...condition("b", "age", "gt", "2", "n")
        })
      ).toEqual([{ key: "filter[n][group][conjunction]", message: "A NOT group must have exactly one member, got 2" }])
    })

    it("mixes shorthand and group keys: shorthand keys are root conditions", () => {
      expect(
        decode({ "filter[status]": "open", ...group("g", "OR"), ...condition("c", "age", "gt", "1", "g") })
      ).toEqual(Filter.and(eq("status", "open"), Filter.or(gt("age", 1))))
      // several root members become an implicit root And; one root member is the root
      expect(decode({ ...group("g", "OR"), ...condition("c", "age", "gt", "1", "g") })).toEqual(Filter.or(gt("age", 1)))
      expect(decode(condition("c", "age", "gt", "1"))).toEqual(gt("age", 1))
    })

    it("decodes list and isnull values in the group form", () => {
      expect(decode(condition("c", "priority", "in", "2,1"))).toEqual(Filter.isIn("priority", [1, 2]))
      expect(decode(condition("c", "priority", "in", "2"))).toEqual(Filter.isIn("priority", [2]))
      expect(decode(condition("c", "deletedAt", "isnull", "false"))).toEqual(Filter.isNull("deletedAt", true))
      // a bare group-form value is the operator's, never inferred from commas
      expect(failures(condition("c", "age", "gt", "1,2"))[0]?.key).toBe("filter[c][condition][value]")
    })
  })
})

// ---------------------------------------------------------------------------
// Generated round trips (§3.2 invariants)
// ---------------------------------------------------------------------------

// A small deterministic PRNG (mulberry32), so a failure reproduces from the seed.
const mulberry32 = (seed: number) => (): number => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const SEED = 20260903
const CASES = 400

// A seeded generator of filter trees over the fixture, shared by the codec's
// round trips and the canonical query string's.
const filterGenerator = (seed: number) => {
  const random = mulberry32(seed)
  const int = (max: number): number => Math.floor(random() * max)
  const pick = <A>(items: ReadonlyArray<A>): A => items[int(items.length)]!

  const literal: { readonly [K in FilterableKeys<typeof Article>]: () => unknown } = {
    status: () => pick(["open", "done", "archived"]),
    age: () => int(2001) - 1000 + pick([0, 0.5, 0.25, 0.125]),
    priority: () => int(21) - 10,
    title: () =>
      Array.from({ length: int(4) }, () => pick(["a", "b", ",", "\\", " ", "é", "\u{1F600}", "！", "x,y", "\\,"])).join(
        ""
      ),
    deletedAt: () => new Date(int(2_000_000_000) * 1000),
    createdAt: () => new Date(int(2_000_000_000) * 1000),
    flag: () => random() < 0.5,
    limit: () => int(100),
    author: () => Person.Id.make(String(int(50)))
  }
  const fieldNames = Object.keys(literal) as ReadonlyArray<FilterableKeys<typeof Article>>

  const condition = (): Filter.Node => {
    const field = pick(fieldNames)
    const op = pick(fields[field].operators as ReadonlyArray<string>)
    const values = (): [unknown, ...Array<unknown>] => [
      literal[field](),
      ...Array.from({ length: int(4) }, literal[field])
    ]
    switch (op) {
      case "in":
        return { _tag: "In", field, values: values() }
      case "nin":
        return { _tag: "NotIn", field, values: values() }
      case "isnull":
        return { _tag: "IsNull", field, negated: random() < 0.5 }
      default:
        return { _tag: "Compare", op: op as Filter.CompareOperator, field, value: literal[field]() }
    }
  }

  const node = (depth: number): Filter.Node => {
    if (depth >= 4 || random() < 0.45) return condition()
    const kind = int(3)
    if (kind === 2) return { _tag: "Not", member: node(depth + 1) }
    const members = Array.from({ length: int(5) }, () => node(depth + 1))
    return { _tag: kind === 0 ? "And" : "Or", members }
  }

  return { random, int, pick, node }
}

describe(`Query.Filter: generated round trips (seed ${SEED}, ${CASES} cases)`, () => {
  const { node } = filterGenerator(SEED)

  const cases = Array.from({ length: CASES }, (_, i) => [i, node(0)] as const)

  it.each(cases)(
    "case %i: decode ∘ encode is identity on normal form, and encode ∘ decode ∘ encode is encode",
    (_, tree) => {
      const normal = Filter.normalise(tree as Ast, fields)
      const encoded = encode(normal)
      const decoded = decode(encoded)
      expect(decoded).toEqual(normal)
      expect(Object.entries(encode(decoded))).toEqual(Object.entries(encoded))
      // encoding never depends on the input's order or duplicates
      expect(Object.entries(encode(tree as Ast))).toEqual(Object.entries(encoded))
    }
  )

  it("covers the shapes the invariants are meant to stress", () => {
    const trees = cases.map(([, tree]) => tree)
    const has = (predicate: (n: Filter.Node) => boolean): boolean => {
      const visit = (n: Filter.Node): boolean =>
        predicate(n) ||
        (n._tag === "And" || n._tag === "Or" ? n.members.some(visit) : n._tag === "Not" ? visit(n.member) : false)
      return trees.some(visit)
    }
    expect(has((n) => (n._tag === "And" || n._tag === "Or") && n.members.length === 1)).toBe(true)
    expect(has((n) => n._tag === "Not" && n.member._tag === "Not")).toBe(true)
    expect(has((n) => (n._tag === "And" || n._tag === "Or") && n.members.length === 0)).toBe(true)
    expect(
      has(
        (n) =>
          (n._tag === "And" || n._tag === "Or") &&
          new Set(n.members.filter((m) => m._tag === "Compare").map((m) => `${m.field}/${(m as Filter.Compare).op}`))
            .size < n.members.filter((m) => m._tag === "Compare").length
      )
    ).toBe(true)
    expect(
      has(
        (n) => (n._tag === "In" || n._tag === "NotIn") && n.values.some((v) => typeof v === "string" && /[,\\]/.test(v))
      )
    ).toBe(true)
    expect(
      has((n) => n._tag === "Not" && n.member._tag === "Or" && n.member.members.some((m) => m._tag === "And"))
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The canonical query string over the grammar (#85)
// ---------------------------------------------------------------------------

const CANONICAL_SEED = 20260985
const CANONICAL_CASES = 300

describe("Query.canonical with filter: true", () => {
  const query = Query.schema(Article, {
    include: true,
    fields: true,
    sort: true,
    page: Query.Page.Offset,
    filter: true
  })
  type Decoded = typeof query.Type
  const decodeQuery = Schema.decodeUnknownSync(query as Schema.Codec<any, any>) as (
    input: Record<string, unknown>
  ) => Decoded
  const canonical = Query.canonical(query)
  const parse = (s: string): Record<string, string> => Object.fromEntries(new URLSearchParams(s))

  it("places the grammar's pairs between fields and sort, in the encoder's order", () => {
    expect(
      canonical({
        page: { limit: 10, offset: 0 },
        sort: [{ field: "age", direction: "desc" }],
        filter: Filter.and(eq("status", "open"), gt("age", 18), eq("title", "Hello, world")),
        include: ["author"],
        fields: { articles: ["title"] }
      })
    ).toBe(
      "include=author&fields[articles]=title&filter[age][gt]=18&filter[status]=open&filter[title]=Hello%5C%2C%20world&sort=-age&page[offset]=0&page[limit]=10"
    )
    // the group form keeps its pre-order: ids are meaningful
    expect(canonical({ filter: Filter.or(eq("status", "open"), Filter.isNull("deletedAt")), page: { limit: 1 } })).toBe(
      "filter[g0][group][conjunction]=OR" +
        "&filter[c0][condition][path]=deletedAt&filter[c0][condition][operator]=isnull&filter[c0][condition][value]=true&filter[c0][condition][memberOf]=g0" +
        "&filter[c1][condition][path]=status&filter[c1][condition][operator]=eq&filter[c1][condition][value]=open&filter[c1][condition][memberOf]=g0" +
        "&page[limit]=1"
    )
  })

  it("is byte-identical for the two-condition filter written three ways, in any key order", () => {
    const spellings: ReadonlyArray<Record<string, unknown>> = [
      { "filter[status]": "open", "filter[age][gt]": "18", sort: "title", include: "author" },
      { include: ["author"], "filter[age][gt]": "18", sort: "title", "filter[status][eq]": "open" },
      {
        sort: "title",
        "filter[c1][condition][path]": "status",
        "filter[c1][condition][operator]": "eq",
        "filter[c1][condition][value]": "open",
        include: "author",
        "filter[x][condition][path]": "age",
        "filter[x][condition][operator]": "gt",
        "filter[x][condition][value]": "18"
      }
    ]
    const strings = spellings.map((spelling) => canonical(decodeQuery(spelling)))
    expect(new Set(strings).size).toBe(1)
    expect(strings[0]).toBe("include=author&filter[age][gt]=18&filter[status]=open&sort=title")
  })

  describe(`generated round trips (seed ${CANONICAL_SEED}, ${CANONICAL_CASES} cases)`, () => {
    const { random, int, pick, node } = filterGenerator(CANONICAL_SEED)
    const subset = <A>(items: ReadonlyArray<A>): Array<A> => items.filter(() => random() < 0.5)
    const attributes = [
      "status",
      "age",
      "priority",
      "title",
      "deletedAt",
      "createdAt",
      "flag",
      "limit",
      "body"
    ] as const

    // A decoded query with any combination of the families; `fields` and
    // `page` are never empty objects (an empty group has no wire form and
    // decodes as absent).
    const decodedQuery = (): Decoded => {
      const q: Record<string, unknown> = {}
      if (random() < 0.7) q.include = subset(["author", "editor", "comments"] as const)
      if (random() < 0.7) {
        const fields: Record<string, unknown> = {}
        if (random() < 0.7) fields.articles = subset(attributes)
        if (random() < 0.5 || Object.keys(fields).length === 0) fields.people = subset(["name"] as const)
        q.fields = fields
      }
      if (random() < 0.7) {
        q.sort = subset(attributes).map((field) => ({ field, direction: pick(["asc", "desc"] as const) }))
      }
      if (random() < 0.7) {
        const page: Record<string, number> = {}
        if (random() < 0.7) page.offset = int(1000)
        if (random() < 0.7 || Object.keys(page).length === 0) page.limit = int(100)
        q.page = page
      }
      if (random() < 0.8) q.filter = Filter.normalise(node(0) as Ast, fields)
      return q as Decoded
    }

    const cases = Array.from({ length: CANONICAL_CASES }, (_, i) => [i, decodedQuery()] as const)

    it.each(cases)("case %i: decode ∘ parse ∘ canonical is identity, and canonical is idempotent", (_, q) => {
      const s = canonical(q)
      const params = new URLSearchParams(s)
      // canonical output never repeats a key, so a record parse is lossless
      expect([...params.keys()].length).toBe(new Set(params.keys()).size)
      const back = decodeQuery(parse(s))
      expect(back).toEqual(q)
      expect(canonical(back)).toBe(s)
    })

    it("covers every family, both filter forms, and a value that needs escaping", () => {
      const queries = cases.map(([, q]) => q)
      const strings = cases.map(([, q]) => canonical(q))
      expect(queries.some((q) => q.include !== undefined && q.include.length > 0)).toBe(true)
      expect(queries.some((q) => q.fields?.articles !== undefined && q.fields.people !== undefined)).toBe(true)
      expect(queries.some((q) => q.sort !== undefined && q.sort.length > 1)).toBe(true)
      expect(queries.some((q) => q.page?.offset !== undefined && q.page.limit !== undefined)).toBe(true)
      expect(queries.some((q) => q.filter !== undefined)).toBe(true)
      expect(strings.some((s) => s.includes("[group][conjunction]"))).toBe(true)
      expect(strings.some((s) => /&filter\[[a-zA-Z]+\]=/.test(s) && !s.includes("[condition]"))).toBe(true)
      expect(strings.some((s) => s.includes("%5C%2C"))).toBe(true)
      expect(queries.some((q) => Object.keys(q).length === 5 && q.include!.length > 0 && q.sort!.length > 0)).toBe(true)
    })
  })
})

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

describe("Query.Filter: types", () => {
  it("narrows `field` to the declared names and each literal to its field's type", () => {
    type Keys = FilterableKeys<typeof Article>
    expectTypeOf<Keys>().toEqualTypeOf<
      "status" | "age" | "priority" | "title" | "deletedAt" | "createdAt" | "flag" | "limit" | "author"
    >()
    type Condition = Extract<Ast, { readonly _tag: "Compare" }>
    expectTypeOf<Condition["field"]>().toEqualTypeOf<Keys>()
    expectTypeOf<Extract<Condition, { readonly field: "age" }>["value"]>().toEqualTypeOf<number>()
    expectTypeOf<Extract<Condition, { readonly field: "status" }>["value"]>().toEqualTypeOf<
      "open" | "done" | "archived"
    >()
    expectTypeOf<Extract<Condition, { readonly field: "deletedAt" }>["value"]>().toEqualTypeOf<Date>()
    expectTypeOf<Extract<Condition, { readonly field: "author" }>["value"]>().toEqualTypeOf<typeof Person.Id.Type>()
    expectTypeOf<Extract<Ast, { readonly _tag: "In" }>["values"]>().toEqualTypeOf<
      Extract<Ast, { readonly _tag: "In"; readonly field: Keys }>["values"]
    >()
    expectTypeOf<Extract<Ast, { readonly _tag: "And" }>["members"]>().toEqualTypeOf<ReadonlyArray<Ast>>()
    expectTypeOf<typeof codec.Encoded>().toEqualTypeOf<{ readonly [key: string]: string }>()
    expectTypeOf<Ast>().toEqualTypeOf<Query.FilterAst<typeof Article>>()
    // a resource declaring nothing has no condition nodes
    const Plain = Resource("plains", { attributes: { n: Schema.Number } })
    expectTypeOf<Extract<Query.FilterAst<typeof Plain>, { readonly _tag: "Compare" }>>().toEqualTypeOf<never>()
  })

  it("types `filter: true` as the AST in Query.schema and leaves the escape hatch unchanged", () => {
    const grammar = Query.schema(Article, { filter: true, page: Query.Page.Offset })
    expectTypeOf<typeof grammar.Type>().toEqualTypeOf<{
      readonly page?: { readonly offset?: number; readonly limit?: number }
      readonly filter?: Query.FilterAst<typeof Article>
    }>()
    expectTypeOf<typeof grammar.Encoded>().toMatchTypeOf<{
      readonly [key: `filter[${string}]`]: string | ReadonlyArray<string>
    }>()
    const hatch = Query.schema(Article, { filter: { q: Schema.String } })
    expectTypeOf<typeof hatch.Type>().toEqualTypeOf<{ readonly filter?: { readonly q: string } }>()
    expectTypeOf<typeof hatch.Encoded>().toEqualTypeOf<{ readonly "filter[q]"?: string }>()
    const off = Query.schema(Article, { filter: false, sort: true })
    expectTypeOf<keyof typeof off.Type>().toEqualTypeOf<"sort">()
  })
})

// ---------------------------------------------------------------------------
// Query.schema wiring and the end-to-end 400 documents
// ---------------------------------------------------------------------------

describe("Query.schema with filter: true", () => {
  const query = Query.schema(Article, { filter: true, page: Query.Page.Offset, sort: true, fields: true })
  const decodeQuery = Schema.decodeUnknownSync(query)

  it("routes filter keys to the grammar and leaves page / fields / sort to the reshaper", () => {
    expect(
      decodeQuery({
        "filter[status]": "open",
        "filter[age][gt]": "18",
        "page[limit]": "10",
        "fields[articles]": "title",
        sort: "-title"
      })
    ).toEqual({
      filter: Filter.and(gt("age", 18), eq("status", "open")),
      page: { limit: 10 },
      fields: { articles: ["title"] },
      sort: [{ field: "title", direction: "desc" }]
    })
  })

  it("decodes an absent filter as absent", () => {
    expect(decodeQuery({})).toEqual({})
    expect(decodeQuery({ "page[limit]": "5" })).toEqual({ page: { limit: 5 } })
  })

  it("encodes the nested shape back to canonical flat keys", () => {
    const encoded = Schema.encodeSync(query)({
      filter: Filter.or(eq("status", "open"), Filter.isNull("deletedAt")),
      page: { offset: 0, limit: 10 }
    })
    expect(Object.entries(encoded)).toEqual([
      ["page[offset]", "0"],
      ["page[limit]", "10"],
      ["filter[g0][group][conjunction]", "OR"],
      ["filter[c0][condition][path]", "deletedAt"],
      ["filter[c0][condition][operator]", "isnull"],
      ["filter[c0][condition][value]", "true"],
      ["filter[c0][condition][memberOf]", "g0"],
      ["filter[c1][condition][path]", "status"],
      ["filter[c1][condition][operator]", "eq"],
      ["filter[c1][condition][value]", "open"],
      ["filter[c1][condition][memberOf]", "g0"]
    ])
    expect(Schema.encodeSync(query)({ page: { limit: 1 } })).toEqual({ "page[limit]": "1" })
  })

  it("fails closed on a resource declaring nothing filterable", () => {
    const Plain = Resource("plains", { attributes: { n: Schema.Number } })
    const plain = Query.schema(Plain, { filter: true })
    expect(Schema.decodeUnknownSync(plain)({})).toEqual({})
    const result = Schema.decodeUnknownResult(plain)({ "filter[n]": "1" })
    expect(result._tag).toBe("Failure")
  })

  it("keeps the issue path at the flat key through the combined schema", () => {
    const result = Schema.decodeUnknownResult(query)({ "filter[age][gt]": "abc", "page[limit]": "1" })
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.map((i) => i.path)).toEqual([
        ["filter[age][gt]"]
      ])
    }
  })

  it("rejects a malformed or bare filter key instead of dropping it", () => {
    for (const key of ["filter[status]x", "filter[", "filter"]) {
      const result = Schema.decodeUnknownResult(query)({ [key]: "open", "page[limit]": "1" })
      expect(result._tag).toBe("Failure")
      if (result._tag === "Failure") {
        const [issue] = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues
        expect(issue?.path).toEqual([key])
        expect(issue?.message).toMatch(/^Malformed filter key/)
      }
    }
    // a parameter that merely starts with "filter" is not the family
    expect(decodeQuery({ filters: "x", filtering: "y" })).toEqual({})
  })

  it("throws for a heterogeneous endpoint", () => {
    expect(() => Query.schema([Article, Person], { filter: true })).toThrow(/heterogeneous/)
    // the escape hatch stays available there
    expect(() => Query.schema([Article, Person], { filter: { q: Schema.String } })).not.toThrow()
  })

  it("re-exports the profile URI", () => {
    expect(Query.FILTER_PROFILE_URI).toBe(Filter.PROFILE_URI)
    expect(Filter.PROFILE_URI).toBe("https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1")
  })
})

describe("Endpoint.list with filter: true, end to end", () => {
  const received: Array<unknown> = []
  const list = Endpoint.list(Article, { filter: true, page: Query.Page.Offset })
  const Api = HttpApi.make("filtered").add(Group.make(Article, list))
  const ArticlesLive = HttpApiBuilder.group(Api, "articles", (handlers) =>
    handlers.handle("list", ({ query }) => {
      received.push(query.filter)
      expectTypeOf(query.filter).toEqualTypeOf<Query.FilterAst<typeof Article> | undefined>()
      return Effect.succeed({ data: [] })
    })
  )

  const request = async (url: string) => {
    const appLayer = HttpApiBuilder.layer(Api).pipe(
      Layer.provide(ArticlesLive),
      Layer.provide(Middleware.layer)
    ) as unknown as Layer.Layer<never, never, HttpRouter.HttpRouter>
    const { dispose, handler } = HttpRouter.toWebHandler(appLayer)
    try {
      const response = await handler(new Request(url))
      return {
        status: response.status,
        contentType: response.headers.get("content-type"),
        body: (await response.json()) as any
      }
    } finally {
      await dispose()
    }
  }

  const error = (detail: string, parameter: string) => ({
    status: "400",
    code: "bad_request",
    title: "Bad Request",
    detail,
    source: { parameter }
  })

  it("answers 200 and hands the handler the decoded tree", async () => {
    received.length = 0
    const response = await request("http://localhost/articles?filter[status]=open&filter[age][gt]=18&page[limit]=5")
    expect(response.status).toBe(200)
    expect(received).toEqual([Filter.and(gt("age", 18), eq("status", "open"))])
  })

  it("answers 200 with no filter when none is sent", async () => {
    received.length = 0
    expect((await request("http://localhost/articles?page[limit]=5")).status).toBe(200)
    expect(received).toEqual([undefined])
  })

  it("answers 400 with source.parameter for an unknown field", async () => {
    const response = await request("http://localhost/articles?filter[body]=x")
    expect(response.status).toBe(400)
    expect(response.contentType).toBe("application/vnd.api+json")
    expect(response.body).toEqual({ errors: [error('Unknown filter field "body"', "filter[body]")] })
  })

  it("answers 400 with source.parameter for an undeclared operator", async () => {
    const response = await request("http://localhost/articles?filter[title][gt]=x")
    expect(response.body).toEqual({
      errors: [
        error(
          'Operator "gt" is not declared on field "title"; declared operators are eq, ne, in, nin',
          "filter[title][gt]"
        )
      ]
    })
  })

  it("answers 400 with source.parameter for a bad literal", async () => {
    const response = await request("http://localhost/articles?filter[age][gt]=abc")
    expect(response.body).toEqual({
      errors: [
        error('Invalid literal "abc" for field "age": Expected a number filter literal, got "abc"', "filter[age][gt]")
      ]
    })
  })

  it("answers 400 with source.parameter for a malformed group form", async () => {
    const response = await request(
      "http://localhost/articles?filter[c][condition][path]=age&filter[c][condition][operator]=gt&filter[c][condition][value]=1&filter[c][condition][memberOf]=g"
    )
    expect(response.body).toEqual({
      errors: [error('memberOf names an unknown group "g"', "filter[c][condition][memberOf]")]
    })
  })

  it("answers 400 with source.parameter for a repeated key", async () => {
    const response = await request("http://localhost/articles?filter[status]=open&filter[status]=done")
    expect(response.body).toEqual({
      errors: [error('Repeated filter key "filter[status]"; a filter key may appear once', "filter[status]")]
    })
  })

  it("answers 400 with source.parameter for a malformed or bare filter key", async () => {
    for (const key of ["filter[status]x", "filter"]) {
      const response = await request(`http://localhost/articles?${key}=open`)
      expect(response.status).toBe(400)
      expect(response.body.errors).toHaveLength(1)
      expect(response.body.errors[0].source).toEqual({ parameter: key })
      expect(response.body.errors[0].detail).toMatch(/^Malformed filter key/)
    }
  })

  it("decodes through BadRequest.wire with the detail (client side)", async () => {
    const response = await request("http://localhost/articles?filter[body]=x")
    const decoded = Schema.decodeUnknownSync(ApiError.BadRequest.wire)(response.body)
    expect(decoded).toBeInstanceOf(ApiError.BadRequest)
    expect(decoded.detail).toBe('Unknown filter field "body"')
  })

  it("answers one error object per offending key", async () => {
    const response = await request("http://localhost/articles?filter[body]=x&filter[age][gt]=abc")
    expect(response.body.errors.map((e: any) => e.source.parameter)).toEqual(["filter[body]", "filter[age][gt]"])
  })

  it("still documents the endpoint in OpenAPI", () => {
    const spec = OpenApi.fromApi(Api)
    expect(spec.paths["/articles"]?.get).toBeDefined()
  })

  it("decodes through the endpoint's query schema directly", () => {
    const listQuery = list.query as Schema.Codec<any, any>
    expect(Schema.decodeUnknownSync(listQuery)({ "filter[priority]": "2,1" })).toEqual({
      filter: Filter.isIn("priority", [1, 2])
    })
    expect(() => Schema.decodeUnknownSync(listQuery)({ "filter[body]": "x" })).toThrow()
  })
})
