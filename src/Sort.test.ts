import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Filter from "./Filter.js"
import * as Sort from "./Sort.js"

describe("Sort.able", () => {
  const declared = Schema.DateFromString.pipe(Sort.able())

  it("stamps the declaration under Sort.AnnotationId and leaves the schema unchanged", () => {
    expect(Sort.AnnotationId).toBe("@thomasfosterau/effect-jsonapi/sort")
    expect(Schema.resolveAnnotations(declared)?.[Sort.AnnotationId]).toBe(true)
    expect(Schema.resolveAnnotations(Schema.String)?.[Sort.AnnotationId]).toBeUndefined()
    expect(Schema.decodeUnknownSync(declared)("2026-01-01T00:00:00.000Z")).toBeInstanceOf(Date)
    expectTypeOf(declared.Type).toEqualTypeOf<Date>()
    expectTypeOf(declared).toMatchTypeOf<typeof Schema.DateFromString>()
  })

  it("carries the declaration at the type level", () => {
    expectTypeOf<(typeof declared)[Sort.MarkerKey]>().toEqualTypeOf<true>()
    expectTypeOf<typeof declared>().toEqualTypeOf<Sort.Declared<typeof Schema.DateFromString>>()
  })

  it("composes with Filter.able in either order", () => {
    const filterFirst = Schema.Int.pipe(Filter.able(["eq"]), Sort.able())
    const sortFirst = Schema.Int.pipe(Sort.able(), Filter.able(["eq"]))
    for (const schema of [filterFirst, sortFirst]) {
      const annotations = Schema.resolveAnnotations(schema)
      const filter = annotations?.[Filter.AnnotationId] as Filter.Annotation | undefined
      expect(annotations?.[Sort.AnnotationId]).toBe(true)
      expect(filter?.operators).toEqual(["eq"])
    }
    expectTypeOf<(typeof filterFirst)[Sort.MarkerKey]>().toEqualTypeOf<true>()
    expectTypeOf<(typeof sortFirst)[Sort.MarkerKey]>().toEqualTypeOf<true>()
    expectTypeOf<(typeof sortFirst)[Filter.MarkerKey]["operators"]>().toEqualTypeOf<"eq">()
  })
})
