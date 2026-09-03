import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema, SchemaGetter } from "effect"
import * as Filter from "./Filter.js"
import * as Relationship from "./Relationship.js"
import { attribute, filterable, make as Resource } from "./Resource.js"

describe("Filter", () => {
  it("names the closed operator core in the grammar's order, as a schema", () => {
    expect(Filter.operators).toEqual(["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"])
    // `operators` is derived from the schema, not a second list
    expect(Filter.Operator.literals).toBe(Filter.operators)
    expect(Schema.decodeUnknownSync(Filter.Operator)("gt")).toBe("gt")
    expect(() => Schema.decodeUnknownSync(Filter.Operator)("like")).toThrow()
    expectTypeOf<Filter.Operator>().toEqualTypeOf<"eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "nin" | "isnull">()
    expectTypeOf<typeof Filter.Operator.Type>().toEqualTypeOf<Filter.Operator>()
    expectTypeOf<(typeof Filter.operators)[number]>().toEqualTypeOf<Filter.Operator>()
  })

  it("guards operator names", () => {
    for (const operator of Filter.operators) expect(Filter.isOperator(operator)).toBe(true)
    expect(Filter.isOperator("like")).toBe(false)
    expect(Filter.isOperator("between")).toBe(false)
    expect(Filter.isOperator("")).toBe(false)
    expect(Filter.isOperator(1)).toBe(false)
    expect(Filter.isOperator(undefined)).toBe(false)
    const value: unknown = "gt"
    if (Filter.isOperator(value)) expectTypeOf(value).toEqualTypeOf<Filter.Operator>()
  })

  it("spells the operators as typed constants", () => {
    expect(Object.keys(Filter.Op)).toEqual([...Filter.operators])
    for (const operator of Filter.operators) expect(Filter.Op[operator]).toBe(operator)
    expect(Object.isFrozen(Filter.Op)).toBe(true)
    expectTypeOf(Filter.Op.eq).toEqualTypeOf<"eq">()
    expectTypeOf(Filter.Op.in).toEqualTypeOf<"in">()
    expectTypeOf<(typeof Filter.Op)[keyof typeof Filter.Op]>().toEqualTypeOf<Filter.Operator>()
    // @ts-expect-error a typo is a compile error
    void Filter.Op.eqq
  })

  it("narrows to the relationship subset, itself a schema", () => {
    expect(Relationship.filterOperators).toEqual(["eq", "ne", "in", "nin", "isnull"])
    expect(Relationship.FilterOperator.literals).toBe(Relationship.filterOperators)
    for (const operator of Relationship.filterOperators) expect(Filter.isOperator(operator)).toBe(true)
    expect(Schema.is(Relationship.FilterOperator)("lt")).toBe(false)
    expectTypeOf<Relationship.FilterOperator>().toEqualTypeOf<"eq" | "ne" | "in" | "nin" | "isnull">()
    expectTypeOf<Relationship.FilterOperator>().toMatchTypeOf<Filter.Operator>()
  })

  describe("able", () => {
    const declared = Schema.Int.pipe(Filter.able(["eq", Filter.Op.gt, "eq"]))
    const annotationOf = (schema: Schema.Top) =>
      Schema.resolveAnnotations(schema)?.[Filter.AnnotationId] as Filter.Annotation | undefined

    it("stamps the declaration as an annotation under Filter.AnnotationId, duplicates dropped", () => {
      expect(Filter.AnnotationId).toBe("@thomasfosterau/effect-jsonapi/filter")
      expect(annotationOf(declared)).toEqual({ operators: ["eq", "gt"], literal: undefined })
      // the schema is otherwise unchanged
      expect(Schema.decodeUnknownSync(declared)(3)).toBe(3)
      expect(() => Schema.decodeUnknownSync(declared)(3.5)).toThrow()
      expectTypeOf(declared.Type).toEqualTypeOf<number>()
      expectTypeOf(declared).toMatchTypeOf<typeof Schema.Int>()
    })

    it("declares the whole core with no argument or `true`", () => {
      expect(annotationOf(Schema.String.pipe(Filter.able()))?.operators).toEqual(Filter.operators)
      expect(annotationOf(Schema.String.pipe(Filter.able(true)))?.operators).toEqual(Filter.operators)
    })

    it("carries the declaration at the type level", () => {
      expectTypeOf<(typeof declared)[Filter.MarkerKey]>().toEqualTypeOf<Filter.Marker<"eq" | "gt", number>>()
      const whole = Schema.String.pipe(Filter.able())
      expectTypeOf<(typeof whole)[Filter.MarkerKey]["operators"]>().toEqualTypeOf<Filter.Operator>()
      // the literal type is the schema's own, minus null
      const nullable = Schema.NullOr(Schema.Number).pipe(Filter.able(["isnull"]))
      expectTypeOf<(typeof nullable)[Filter.MarkerKey]["literal"]>().toEqualTypeOf<number>()
      expectTypeOf<Filter.OperatorsIn<true>>().toEqualTypeOf<Filter.Operator>()
      expectTypeOf<Filter.OperatorsIn<readonly ["lt", "lte"]>>().toEqualTypeOf<"lt" | "lte">()
    })

    it("throws at definition time on an empty list or an operator outside the core", () => {
      expect(() => Filter.able([])).toThrow(/Filter\.able declares filter: \[\]/)
      expect(() => Filter.able(["eq", "like" as never])).toThrow(
        /declares filter operator "like"; expected one of eq, ne, lt, lte, gt, gte, in, nin, isnull/
      )
      // @ts-expect-error an operator outside the core is a compile error
      expect(() => Filter.able(["between"])).toThrow()
    })

    it("records an explicit literal codec, checked against the schema", () => {
      const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Point, {
          decode: SchemaGetter.transform((s: string) => {
            const [x, y] = s.split(":").map(Number)
            return { x: x!, y: y! }
          }),
          encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`)
        })
      )
      const point = Point.pipe(Filter.able(["eq"], { literal: PointFromString }))
      expect(annotationOf(point)?.literal).toBe(PointFromString)
      expectTypeOf<(typeof point)[Filter.MarkerKey]>().toEqualTypeOf<
        Filter.Marker<"eq", { readonly x: number; readonly y: number }>
      >()
      // @ts-expect-error a literal codec for another type does not fit the schema
      void Schema.String.pipe(Filter.able(["eq"], { literal: PointFromString }))
    })
  })
})

describe("Filter AST", () => {
  it("builds plain data with the constructors", () => {
    expect(Filter.eq("status", "open")).toEqual({ _tag: "Compare", op: "eq", field: "status", value: "open" })
    expect(Filter.ne("a", 1)).toEqual({ _tag: "Compare", op: "ne", field: "a", value: 1 })
    expect(Filter.lt("a", 1).op).toBe("lt")
    expect(Filter.lte("a", 1).op).toBe("lte")
    expect(Filter.gt("a", 1).op).toBe("gt")
    expect(Filter.gte("a", 1).op).toBe("gte")
    expect(Filter.isIn("priority", [1, 2])).toEqual({ _tag: "In", field: "priority", values: [1, 2] })
    expect(Filter.notIn("priority", [1])).toEqual({ _tag: "NotIn", field: "priority", values: [1] })
    expect(Filter.isNull("deletedAt")).toEqual({ _tag: "IsNull", field: "deletedAt", negated: false })
    expect(Filter.isNull("deletedAt", true).negated).toBe(true)
    expect(Filter.and(Filter.eq("a", 1), Filter.gt("b", 2))).toEqual({
      _tag: "And",
      members: [Filter.eq("a", 1), Filter.gt("b", 2)]
    })
    expect(Filter.or()).toEqual({ _tag: "Or", members: [] })
    expect(Filter.not(Filter.eq("a", 1))).toEqual({ _tag: "Not", member: Filter.eq("a", 1) })
  })

  it("types the constructors over the field names and literals", () => {
    expectTypeOf(Filter.eq("age", 18)).toEqualTypeOf<Filter.Compare<"age", 18>>()
    expectTypeOf(Filter.eq("age", 18)).toMatchTypeOf<Filter.Compare<"age", number>>()
    expectTypeOf(Filter.isIn("status", ["a", "b"])).toEqualTypeOf<Filter.In<"status", "a" | "b">>()
    expectTypeOf(Filter.isNull("deletedAt")).toEqualTypeOf<Filter.IsNull<"deletedAt">>()
    // a typed tree over a field vocabulary
    type Fields = { readonly age: number; readonly status: "open" | "done" }
    const tree: Filter.Ast<Fields> = Filter.and(Filter.gt("age", 18), Filter.eq("status", "open"))
    expectTypeOf(tree).toMatchTypeOf<Filter.Ast<Fields>>()
    expectTypeOf(Filter.not(Filter.or())).toMatchTypeOf<Filter.Not<Fields>>()
    // @ts-expect-error an undeclared field is not a node of the tree
    const bad: Filter.Ast<Fields> = Filter.eq("title", "x")
    void bad
    // @ts-expect-error a literal of the wrong type is not a node of the tree
    const badLiteral: Filter.Ast<Fields> = Filter.eq("age", "18")
    void badLiteral
    // the untyped Node admits anything
    expectTypeOf(Filter.eq("anything", new Date())).toMatchTypeOf<Filter.Node>()
    expectTypeOf<Filter.Node>().toEqualTypeOf<Filter.Ast>()
  })

  it("validates a tree's shape with the runtime Ast schema", () => {
    const is = Schema.is(Filter.Ast)
    expect(is({ _tag: "Compare", op: "gt", field: "age", value: 18 })).toBe(true)
    expect(is({ _tag: "In", field: "status", values: ["a"] })).toBe(true)
    expect(is({ _tag: "And", members: [{ _tag: "Not", member: { _tag: "IsNull", field: "x", negated: true } }] })).toBe(
      true
    )
    expect(is({ _tag: "Or", members: [] })).toBe(true)
    // literals are open: their types come from the resource declaration
    expect(is({ _tag: "Compare", op: "eq", field: "when", value: new Date() })).toBe(true)
    // …but the shape is closed
    expect(is({ _tag: "Compare", op: "like", field: "age", value: 18 })).toBe(false)
    expect(is({ _tag: "In", field: "status", values: [] })).toBe(false)
    expect(is({ _tag: "Not", member: undefined })).toBe(false)
    expect(is({ _tag: "Between", field: "age" })).toBe(false)
    expect(is({ _tag: "And", members: [{ _tag: "Compare", op: "eq", field: 1, value: 1 }] })).toBe(false)
    expect(Schema.decodeUnknownSync(Filter.Ast)({ _tag: "Compare", op: "gt", field: "age", value: 18 })).toEqual(
      Filter.gt("age", 18)
    )
    expectTypeOf<typeof Filter.Ast.Type>().toEqualTypeOf<Filter.Node>()
  })

  describe("normalise", () => {
    const Article = Resource("articles", {
      attributes: {
        status: attribute(Schema.String, { filter: true }),
        age: attribute(Schema.Number, { filter: true }),
        when: attribute(Schema.DateFromString, { filter: ["eq", "in"] })
      }
    })
    const fields = filterable(Article)

    it("sorts and deduplicates In values by encoded string, members by the node order", () => {
      expect(Filter.normalise(Filter.isIn("age", [3, 1, 3, 10]), fields)).toEqual(Filter.isIn("age", [1, 10, 3]))
      expect(
        Filter.normalise(
          Filter.and(Filter.eq("status", "open"), Filter.isIn("age", [3, 1, 3]), Filter.eq("status", "open")),
          fields
        )
      ).toEqual(Filter.and(Filter.isIn("age", [1, 3]), Filter.eq("status", "open")))
      // dates sort by their ISO encoding
      const a = new Date("2026-01-01T00:00:00.000Z")
      const b = new Date("2025-01-01T00:00:00.000Z")
      expect(Filter.normalise(Filter.isIn("when", [a, b, a]), fields)).toEqual(Filter.isIn("when", [b, a]))
    })

    it("keeps the type of the tree", () => {
      const tree = Filter.and(Filter.eq("status", "open"))
      expectTypeOf(Filter.normalise(tree, fields)).toEqualTypeOf<typeof tree>()
    })

    it("throws for an unknown field, a refused literal or an empty list", () => {
      expect(() => Filter.normalise(Filter.eq("nope", 1), fields)).toThrow(/Unknown filter field "nope"/)
      expect(() => Filter.normalise(Filter.eq("age", "abc" as never), fields)).toThrow()
      expect(() => Filter.normalise({ _tag: "In", field: "age", values: [] as never }, fields)).toThrow(
        /at least one value/
      )
    })
  })

  it("fixes the profile URI", () => {
    expect(Filter.PROFILE_URI).toBe("https://thomasfosterau.github.io/effect-jsonapi/profiles/filter-grammar/v1")
  })
})
