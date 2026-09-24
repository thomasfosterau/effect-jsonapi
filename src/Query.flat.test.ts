/**
 * The open `?include=` list and the flat list wire query: both include
 * spellings, the `page[…]` / `filter[…]` re-keying, what stays flat, and the
 * canonical pairs the links are spelled from.
 */
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import * as FlatQuery from "./FlatQuery.js";
import * as Query from "./Query.js";

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"]>);
const encode = <S extends Schema.Top>(schema: S) =>
  Schema.encodeUnknownSync(schema as unknown as Schema.Codec<S["Type"], S["Encoded"]>);

describe("IncludeList (the §7.1 include grammar, both spellings)", () => {
  const include = decode(Query.IncludeList);

  it("decodes a single occurrence to a one-element array", () => {
    expect(include("election")).toEqual(["election"]);
  });

  it("decodes a repeated key unchanged", () => {
    expect(include(["election", "candidates"])).toEqual(["election", "candidates"]);
  });

  it("splits the comma form, trimming whitespace and dropping empty segments", () => {
    expect(include("election, candidates,,")).toEqual(["election", "candidates"]);
  });

  it("mixes the two spellings into one path list", () => {
    expect(include(["election", "candidates,latestResult"])).toEqual([
      "election",
      "candidates",
      "latestResult",
    ]);
  });

  it("encodes a path list as the identity (the client always sends an array)", () => {
    expect(encode(Query.IncludeList)(["a", "b"])).toEqual(["a", "b"]);
  });
});

describe("flatList", () => {
  const ListWidgets = Schema.Struct({
    ...FlatQuery.pagination({ maxLimit: 100 }),
    owner: Schema.optionalKey(Schema.String),
  });

  it("re-keys the page cursor to `page[offset]` / `page[limit]`, defaulting absent keys", () => {
    const wire = Query.flatList(ListWidgets);
    expect(decode(wire)({})).toEqual({ limit: 50, offset: 0 });
    expect(decode(wire)({ "page[limit]": 5, "page[offset]": 20 })).toEqual({
      limit: 5,
      offset: 20,
    });
    expect(encode(wire)({ limit: 5, offset: 20 })).toEqual({
      "page[limit]": 5,
      "page[offset]": 20,
    });
  });

  it("re-keys a declared filter to `filter[<field>]`, decoding it back flat, and no longer reads the flat spelling", () => {
    const wire = Query.flatList(ListWidgets, { filters: ["owner"] });
    expect(decode(wire)({ "page[limit]": 5, "page[offset]": 0, "filter[owner]": "alice" })).toEqual(
      {
        limit: 5,
        offset: 0,
        owner: "alice",
      },
    );
    expect(encode(wire)({ limit: 5, offset: 0, owner: "alice" })).toEqual({
      "page[limit]": 5,
      "page[offset]": 0,
      "filter[owner]": "alice",
    });
    expect(
      decode(wire)({ "page[limit]": 5, "page[offset]": 0, owner: "alice" }),
    ).not.toHaveProperty("owner");
  });

  it("leaves an undeclared field flat", () => {
    expect(
      decode(Query.flatList(ListWidgets))({ "page[limit]": 5, "page[offset]": 0, owner: "alice" }),
    ).toEqual({
      limit: 5,
      offset: 0,
      owner: "alice",
    });
  });

  it("adds a flat `include` key alongside the bracketed families, unless told not to", () => {
    expect(
      decode(Query.flatList(ListWidgets, { filters: ["owner"] }))({
        "page[limit]": 5,
        "page[offset]": 0,
        "filter[owner]": "alice",
        include: "maker",
      }),
    ).toEqual({ limit: 5, offset: 0, owner: "alice", include: ["maker"] });
    expect(
      decode(Query.flatList(ListWidgets, { include: false }))({
        "page[limit]": 1,
        include: "maker",
      }),
    ).toEqual({ limit: 1, offset: 0 });
  });

  it("emits the same page-cursor keys as `bracketPageKeys`", () => {
    const packageKeys = Object.keys(
      encode(Query.bracketPageKeys(ListWidgets))({ limit: 5, offset: 0 }),
    );
    const flatKeys = Object.keys(
      encode(Query.flatList(ListWidgets, { filters: ["owner"] }))({ limit: 5, offset: 0 }),
    );
    expect(flatKeys.toSorted()).toEqual(packageKeys.toSorted());
  });

  it("spells canonical pairs in the wire keys, in canonical order, omitting what was never sent", () => {
    const wire = Query.flatList(ListWidgets, { filters: ["owner"] });
    const pairs = Query.canonicalPairs(wire);
    expect(pairs({ limit: 10, offset: 20, owner: "ada", include: ["maker"] })).toEqual([
      ["include", "maker"],
      ["filter[owner]", "ada"],
      ["page[offset]", "20"],
      ["page[limit]", "10"],
    ]);
    expect(pairs({ limit: 10, offset: 0 })).toEqual([
      ["page[offset]", "0"],
      ["page[limit]", "10"],
    ]);
  });
});
