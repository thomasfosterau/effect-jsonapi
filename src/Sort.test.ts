import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Filter from "./Filter.js";
import * as Sort from "./Sort.js";

describe("Sort.able", () => {
  const declared = Schema.DateFromString.pipe(Sort.able());

  it("stamps the declaration under Sort.AnnotationId and leaves the schema unchanged", () => {
    expect(Sort.AnnotationId).toBe("@thomasfosterau/effect-jsonapi/sort");
    expect(Schema.resolveAnnotations(declared)?.[Sort.AnnotationId]).toBe(true);
    expect(Schema.resolveAnnotations(Schema.String)?.[Sort.AnnotationId]).toBeUndefined();
    expect(Schema.decodeSync(declared)("2026-01-01T00:00:00.000Z")).toBeInstanceOf(Date);
    expectTypeOf(declared.Type).toEqualTypeOf<Date>();
    expectTypeOf(declared).toMatchTypeOf<typeof Schema.DateFromString>();
  });

  it("carries the declaration at the type level", () => {
    expectTypeOf<(typeof declared)[Sort.MarkerKey]>().toEqualTypeOf<true>();
    expectTypeOf<typeof declared>().toEqualTypeOf<Sort.Declared<typeof Schema.DateFromString>>();
  });

  it("composes with Filter.able in either order", () => {
    const filterFirst = Schema.Int.pipe(Filter.able(["eq"]), Sort.able());
    const sortFirst = Schema.Int.pipe(Sort.able(), Filter.able(["eq"]));
    Arr.forEach([filterFirst, sortFirst], (schema) => {
      const annotations = Schema.resolveAnnotations(schema);
      const filter = Option.fromUndefinedOr(annotations?.[Filter.AnnotationId]).pipe(
        // SAFETY: `Filter.able` stamps a `Filter.Annotation` under this id.
        Option.map((annotation) => annotation as Filter.Annotation),
      );
      expect(annotations?.[Sort.AnnotationId]).toBe(true);
      expect(Option.map(filter, (declared) => declared.operators)).toEqual(Option.some(["eq"]));
    });
    expectTypeOf<(typeof filterFirst)[Sort.MarkerKey]>().toEqualTypeOf<true>();
    expectTypeOf<(typeof sortFirst)[Sort.MarkerKey]>().toEqualTypeOf<true>();
    expectTypeOf<(typeof sortFirst)[Filter.MarkerKey]["operators"]>().toEqualTypeOf<"eq">();
  });
});
