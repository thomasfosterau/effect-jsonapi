import { describe, expect, it } from "vite-plus/test";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Query from "../Query.js";
import * as Relationship from "../Relationship.js";
import * as Resource from "../Resource.js";
import { wireProperties } from "./declaredQuery.js";

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
const Post = Resource.make("posts", {
  attributes: { title: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) },
});
const Tag = Resource.make("tags", { attributes: {} });

// The struct a schema's AST is; a struct with no property otherwise, which
// every assertion below then fails on.
const objects = (schema: Schema.Top): SchemaAST.Objects =>
  Option.getOrElse(
    Option.liftPredicate(schema.ast, SchemaAST.isObjects),
    () => Schema.Struct({}).ast,
  );

// `[decoded name, wire name]` for every property `wireProperties` settles.
const settled = (schema: Schema.Top) =>
  wireProperties(objects(schema)).map(({ property, wire }) => [String(property.name), wire]);

// `wireProperties` relies on two facts about the pinned `effect`: an
// upgrade that breaks either fails here first, not as a misread query.
describe("what `wireProperties` relies on in effect", () => {
  it("`SchemaAST.toEncoded` is memoised by identity", () => {
    const include = Query.Include(Post);
    expect(SchemaAST.toEncoded(include.ast)).toBe(SchemaAST.toEncoded(include.ast));
    const optional = Schema.optionalKey(include);
    expect(SchemaAST.toEncoded(optional.ast)).toBe(SchemaAST.toEncoded(optional.ast));
  });

  it("`Schema.encodeKeys` builds the encoded struct from `toEncoded` of each field, in field order", () => {
    const fields = {
      paths: Schema.optionalKey(Query.Include(Post)),
      count: Schema.FiniteFromString,
      order: Schema.optionalKey(Query.Sort(["title"])),
    };
    const encoded = objects(
      Schema.toEncoded(
        Schema.Struct(fields).pipe(Schema.encodeKeys({ paths: "include", order: "sort" })),
      ),
    );
    expect(encoded.propertySignatures.map(({ name }) => name)).toEqual([
      "include",
      "count",
      "sort",
    ]);
    const types = encoded.propertySignatures.map(({ type }) => type);
    expect(types[0]).toBe(SchemaAST.toEncoded(fields.paths.ast));
    expect(types[1]).toBe(SchemaAST.toEncoded(fields.count.ast));
    expect(types[2]).toBe(SchemaAST.toEncoded(fields.order.ast));
  });
});

describe("wireProperties", () => {
  it("pairs each property of a struct no encoding renames with its own name", () => {
    expect(
      settled(
        Schema.Struct({ include: Query.Include(Post), q: Schema.optionalKey(Schema.String) }),
      ),
    ).toEqual([
      ["include", "include"],
      ["q", "q"],
    ]);
  });

  it("pairs a renamed property with its wire name, whatever its decoded name", () => {
    const schema = Schema.Struct({
      sort: Schema.optionalKey(Query.Include(Post)),
      x: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ sort: "include", x: "sort" }));
    expect(settled(schema)).toEqual([
      ["sort", "include"],
      ["x", "sort"],
    ]);
  });

  it("pairs the two sides of a swap", () => {
    const schema = Schema.Struct({
      include: Schema.optionalKey(Query.Include(Post)),
      inc: Schema.optionalKey(Query.Include(Tag)),
    }).pipe(Schema.encodeKeys({ include: "inc", inc: "include" }));
    expect(settled(schema)).toEqual([
      ["include", "inc"],
      ["inc", "include"],
    ]);
  });

  it("pairs properties whose codecs encode to one shared AST by their place", () => {
    const paths = Query.Include(Tag);
    const order = Query.Sort([]);
    // Both are strings on the wire, so identity alone cannot tell them apart.
    expect(SchemaAST.toEncoded(paths.ast)).toBe(SchemaAST.toEncoded(order.ast));
    const schema = Schema.Struct({ paths, order }).pipe(
      Schema.encodeKeys({ paths: "include", order: "sort" }),
    );
    expect(settled(schema)).toEqual([
      ["paths", "include"],
      ["order", "sort"],
    ]);
    expect(
      settled(Query.bracketPageKeys(Schema.Struct({ ...Query.Page.offset({ maxLimit: 100 }) }))),
    ).toEqual([
      ["offset", "page[offset]"],
      ["limit", "page[limit]"],
    ]);
  });

  // An array-index name sorts first in an object, so the encoded struct's
  // order is not the decoded one's: only identity can pair it.
  it("pairs by identity alone when a rename can reorder the struct", () => {
    const distinct = Schema.Struct({ a: Schema.Number, b: Schema.FiniteFromString }).pipe(
      Schema.encodeKeys({ b: "0" }),
    );
    expect(settled(distinct)).toEqual([
      ["b", "0"],
      ["a", "a"],
    ]);
    const shared = Schema.Struct({ a: Schema.String, b: Schema.String }).pipe(
      Schema.encodeKeys({ b: "0" }),
    );
    expect(settled(shared)).toEqual([]);
  });

  // A struct-to-struct transformation that is not a rename: both wire
  // strings carry the AST of the one decoded string, so neither is paired.
  it("pairs nothing two wire properties could both be", () => {
    const schema = Schema.Struct({ a: Schema.String, b: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ x: Schema.String, y: Schema.Number }),
        SchemaTransformation.transform({
          decode: ({ a, b }) => ({ x: a + b, y: a.length }),
          encode: ({ x }) => ({ a: x, b: "" }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // `Query.schema` relates its flat wire struct to its nested decoded one by
  // a transformation of its own, not by renaming properties: nothing in it
  // may be paired with another name.
  it("never pairs a `Query.schema` property with another name", () => {
    const query = Query.schema(Post, {
      include: true,
      fields: true,
      sort: true,
      page: Query.Page.Offset,
      filter: true,
    });
    expect(
      wireProperties(objects(query)).filter(({ property, wire }) => wire !== property.name),
    ).toEqual([]);
  });
});
