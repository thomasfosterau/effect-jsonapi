import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { assert, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Filter from "./Filter.js";
import { evaluate, NULL, type Row } from "./internal/conformance/semantics.js";
import * as Query from "./Query.js";
import { attribute, filterable, make as Resource } from "./Resource.js";

const Article = Resource("articles", {
  attributes: {
    title: attribute(Schema.String, {
      filter: ["eq", Filter.Op.contains, Filter.Op.startsWith, Filter.Op.endsWith],
    }),
    // a fragment of a member of the union need not be a member
    status: Schema.Literals(["draft", "published"]).pipe(Filter.able(["eq", "startsWith"])),
    subtitle: Schema.NullOr(Schema.String.pipe(Filter.able(["contains", "isnull"]))),
    age: attribute(Schema.Finite, { filter: true }),
  },
});

const codec = Query.Filter(Article);
type Ast = typeof codec.Type;
const decode = (record: R.ReadonlyRecord<string, unknown>): Ast =>
  Schema.decodeUnknownSync(codec)(record);
const encode = (ast: Ast): Record<string, string> => Schema.encodeSync(codec)(ast);

const failure = (record: R.ReadonlyRecord<string, unknown>): string => {
  const result = Schema.decodeUnknownResult(codec)(record);
  assert(Result.isFailure(result), "expected the decode to fail");
  return SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue)
    .issues.map((issue) => issue.message)
    .join("; ");
};

describe("Filter text operators", () => {
  it("are opt-in: `filter: true` declares the core alone", () => {
    expect(filterable(Article).age.operators).toEqual(Filter.coreOperators);
    expect(filterable(Article).title.operators).toEqual([
      "eq",
      "contains",
      "startsWith",
      "endsWith",
    ]);
  });

  it("refuse a non-string attribute, at compile time and when the resource is made", () => {
    expect(() =>
      Resource("bad", {
        attributes: {
          // the compile-time refusal: test/rejected-calls.types.ts
          n: Schema.Finite.pipe(Filter.able(["contains"]) as (self: Schema.Top) => never),
        },
      }),
    ).toThrow(
      /attribute "n" declares filter operator contains, but its encoded form is not a string/,
    );
  });

  it("decode to a Text node whose fragment is the unescaped wire string, not a decoded literal", () => {
    expect(decode({ "filter[title][contains]": "effect" })).toEqual(
      Filter.contains("title", "effect"),
    );
    expect(decode({ "filter[status][startsWith]": "dra" })).toEqual(
      Filter.startsWith("status", "dra"),
    );
    expect(decode({ "filter[title][endsWith]": "a\\,b" })).toEqual(Filter.endsWith("title", "a,b"));
    // the group form spells the same condition
    expect(
      decode({
        "filter[c][condition][path]": "subtitle",
        "filter[c][condition][operator]": "contains",
        "filter[c][condition][value]": "",
      }),
    ).toEqual(Filter.contains("subtitle", ""));
  });

  it("reject an undeclared text operator and an unescaped comma", () => {
    expect(failure({ "filter[status][contains]": "a" })).toBe(
      'Operator "contains" is not declared on field "status"; declared operators are eq, startsWith',
    );
    expect(failure({ "filter[title][contains]": "a,b" })).toMatch(/unescaped comma/);
  });

  it("encode canonically and round-trip beside the field's other conditions", () => {
    const tree = Filter.and(Filter.contains("title", "x,y"), Filter.eq("title", "Hi"));
    const wire = encode(tree);
    expect(wire).toEqual({ "filter[title]": "Hi", "filter[title][contains]": "x\\,y" });
    // normal form orders the conditions by operator: "contains" < "eq"
    expect(decode(wire)).toEqual(tree);
  });

  it("refuse to encode a text operator the field does not declare", () => {
    // SAFETY: deliberately ill-typed: `age` declares no text operator
    expect(() => encode(Filter.contains("age", "1") as never)).toThrow(
      /Operator "contains" is not declared on field "age"/,
    );
  });

  it("type a Text node only for the fields that declare a text operator", () => {
    expectTypeOf<Query.FilterTextFields<typeof Article>>().toEqualTypeOf<
      "title" | "status" | "subtitle"
    >();
    expectTypeOf(Filter.contains("title", "x")).toMatchTypeOf<Ast>();
    expectTypeOf<
      Extract<Filter.Ast<{ readonly title: string }>, Filter.Text>
    >().toEqualTypeOf<never>();
  });

  it("validate with the runtime Ast schema", () => {
    expect(Schema.is(Filter.Ast)(Filter.contains("title", "x"))).toBe(true);
    expect(Schema.is(Filter.Ast)({ _tag: "Text", op: "like", field: "title", value: "x" })).toBe(
      false,
    );
    expect(Schema.is(Filter.Ast)({ _tag: "Text", op: "contains", field: "title", value: 1 })).toBe(
      false,
    );
  });

  it("evaluate case-sensitively, with NULL UNKNOWN and the empty fragment matching any value", () => {
    const row: Row = { title: "Effect JSON:API", subtitle: NULL };
    expect(evaluate(Filter.contains("title", "JSON"), row)).toBe("TRUE");
    expect(evaluate(Filter.contains("title", "json"), row)).toBe("FALSE");
    expect(evaluate(Filter.startsWith("title", "Effect"), row)).toBe("TRUE");
    expect(evaluate(Filter.endsWith("title", "Effect"), row)).toBe("FALSE");
    expect(evaluate(Filter.contains("title", ""), row)).toBe("TRUE");
    expect(evaluate(Filter.contains("subtitle", "x"), row)).toBe("UNKNOWN");
    expect(evaluate(Filter.not(Filter.contains("subtitle", "x")), row)).toBe("UNKNOWN");
  });
});
