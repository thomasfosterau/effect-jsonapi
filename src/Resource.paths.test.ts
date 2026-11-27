import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { assert, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Filter from "./Filter.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import type { FilterableKeys, FilterOperators, SortableKeys } from "./Resource.js";
import { attribute, filterable, make as Resource, sortable } from "./Resource.js";
import * as Sort from "./Sort.js";

const Article = Resource("articles", {
  attributes: {
    title: attribute(Schema.String, { filter: ["eq"], sort: true }),
  },
  relationships: {
    // declared before its target: paths resolve on first read
    author: Relationship.one(() => Person, { traverse: true }),
    editor: Relationship.optional(() => Person),
  },
});

const Company = Resource("companies", {
  attributes: { name: attribute(Schema.String, { filter: ["eq"], sort: true }) },
});

const Person = Resource("people", {
  attributes: {
    name: Schema.String.pipe(Filter.able(["eq", "contains"]), Sort.able()),
    age: attribute(Schema.Finite, { filter: ["gt", "lt"] }),
    bio: Schema.String,
  },
  relationships: {
    employer: Relationship.one(() => Company, { filter: ["eq"], traverse: true }),
  },
});

describe("relationship paths", () => {
  it("add the target's own filterable keys, one hop, through a `traverse` relationship only", () => {
    const fields = filterable(Article);
    expect(R.keys(fields)).toEqual(["title", "author.name", "author.age", "author.employer"]);
    expect(fields["author.name"].operators).toEqual(["eq", "contains"]);
    expect(fields["author.age"]).toBe(filterable(Person).age);
    expectTypeOf<FilterableKeys<typeof Article>>().toEqualTypeOf<
      "title" | "author.name" | "author.age" | "author.employer"
    >();
    expectTypeOf<FilterOperators<typeof Article, "author.age">>().toEqualTypeOf<"gt" | "lt">();
    // the target's own paths are its own
    expect(R.keys(filterable(Person))).toContain("employer.name");
  });

  it("add the target's own sortable attributes", () => {
    expect(sortable(Article)).toEqual(["title", "author.name"]);
    expectTypeOf<SortableKeys<typeof Article>>().toEqualTypeOf<"title" | "author.name">();
  });

  it("decode as dotted fields of the filter grammar, typed through the target's literal", () => {
    const codec = Query.Filter(Article);
    const decode = Schema.decodeUnknownSync(codec);
    expect(decode({ "filter[author.age][gt]": "30" })).toEqual(Filter.gt("author.age", 30));
    expect(
      decode({
        "filter[c][condition][path]": "author.name",
        "filter[c][condition][operator]": "contains",
        "filter[c][condition][value]": "Ada",
      }),
    ).toEqual(Filter.contains("author.name", "Ada"));
    expect(Schema.encodeSync(codec)(Filter.eq("author.name", "Ada"))).toEqual({
      "filter[author.name]": "Ada",
    });
    expectTypeOf<Query.FilterTextFields<typeof Article>>().toEqualTypeOf<"author.name">();
    // a path through a relationship not declared `traverse`, or two hops, is unknown
    expect(Result.isFailure(Schema.decodeResult(codec)({ "filter[editor.name]": "x" }))).toBe(true);
    expect(
      Result.isFailure(Schema.decodeResult(codec)({ "filter[author.employer.name]": "x" })),
    ).toBe(true);
    // the literal is the target's: `age` is a number
    const bad = Schema.decodeResult(codec)({ "filter[author.age][gt]": "old" });
    assert(Result.isFailure(bad));
  });

  it("serve as a sort allow-list", () => {
    const query = Query.schema(Article, { sort: sortable(Article) });
    expect(Schema.decodeSync(query)({ sort: "-author.name,title" })).toEqual({
      sort: [
        { field: "author.name", direction: "desc" },
        { field: "title", direction: "asc" },
      ],
    });
    expect(Result.isFailure(Schema.decodeResult(query)({ sort: "author.age" }))).toBe(true);
  });
});
