import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema, SchemaGetter } from "effect"
import * as Filter from "./Filter.js"
import * as Relationship from "./Relationship.js"

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
