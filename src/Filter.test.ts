import { describe, expect, expectTypeOf, it } from "vitest"
import * as Filter from "./Filter.js"

describe("Filter", () => {
  it("names the closed operator core in the grammar's order", () => {
    expect(Filter.operators).toEqual(["eq", "ne", "lt", "lte", "gt", "gte", "in", "nin", "isnull"])
    expectTypeOf<Filter.Operator>().toEqualTypeOf<"eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "in" | "nin" | "isnull">()
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
})
