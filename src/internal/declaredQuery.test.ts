import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Query from "../Query.js";
import * as Resource from "../Resource.js";
import { declaredNames, declaresName } from "./declaredQuery.js";

// What the support check reads a family's members off (#321): the wire name
// of every member a query declares, and a prefix for an open record of them.
describe("declaredNames", () => {
  const Ticket = Resource.make("tickets", {
    attributes: { title: Resource.attribute(Schema.String, { filter: true }) },
  });
  const names = (schema: Schema.Top) => Option.getOrUndefined(declaredNames(schema.ast));

  it("names each key of an explicit filter map and each declared page key", () => {
    expect(
      names(Query.schema(Ticket, { filter: { status: Schema.String }, page: Query.Page.Cursor })),
    ).toEqual(expect.arrayContaining(["filter[status]", "page[cursor]", "page[size]"]));
  });

  it("names the bare `filter` and the `filter[` prefix of the open grammar", () => {
    expect(names(Query.schema(Ticket, { filter: true }))).toEqual(["filter", "filter["]);
  });

  it("names a renamed member by its wire name", () => {
    const renamed = Schema.Struct({ state: Schema.optionalKey(Schema.String) }).pipe(
      Schema.encodeKeys({ state: "filter[status]" }),
    );
    expect(names(renamed)).toEqual(["filter[status]"]);
    expect(
      names(Query.bracketPageKeys(Schema.Struct(Query.Page.offset({ maxLimit: 10 })))),
    ).toEqual(["page[offset]", "page[limit]"]);
  });

  it("names an open record's family prefix, and none for a record of any name", () => {
    const open = Schema.Record(Schema.TemplateLiteral(["page[", Schema.String]), Schema.String);
    expect(names(open)).toEqual(["page["]);
    expect(names(Schema.Record(Schema.String, Schema.String))).toBeUndefined();
  });
});

describe("declaresName", () => {
  it("declares a name listed exactly", () => {
    expect(declaresName(["filter[status]", "page[size]"], "filter[status]")).toBe(true);
    expect(declaresName(["filter[status]", "page[size]"], "page[size]")).toBe(true);
  });

  it("declares no other member, no deeper member and no bare family name", () => {
    const declared = ["filter[status]", "page[size]"];
    expect(
      ["filter[stauts]", "filter[status][eq]", "filter", "page[sise]", "page"].filter((name) =>
        declaresName(declared, name),
      ),
    ).toEqual([]);
  });

  it("declares every member a prefix opens, but not the bare family name", () => {
    expect(declaresName(["filter["], "filter[anything][deep]")).toBe(true);
    expect(declaresName(["page["], "page[x]")).toBe(true);
    expect(declaresName(["filter["], "filter")).toBe(false);
    expect(declaresName(["filter["], "page[x]")).toBe(false);
  });
});
