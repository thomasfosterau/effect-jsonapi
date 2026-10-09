import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
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

// A struct with no property, whose encoded type a string satisfies.
const Empty = Schema.Struct({});

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

// `wireProperties` reads a rename by running the encoding's decode on a
// probe: an `effect` upgrade that moves the rename elsewhere fails here
// first, not as a misread query.
describe("what `wireProperties` relies on in effect", () => {
  it("`Schema.encodeKeys` renames in its one encoding link, a `Transformation` from a plain struct", () => {
    const schema = Schema.Struct({ paths: Schema.optionalKey(Query.Include(Post)) }).pipe(
      Schema.encodeKeys({ paths: "include" }),
    );
    const [link, ...rest] = schema.ast.encoding ?? [];
    expect(rest).toEqual([]);
    expect(SchemaTransformation.isTransformation(link?.transformation)).toBe(true);
    expect(link !== undefined && SchemaAST.isObjects(link.to) && link.to.encoding).toBeUndefined();
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
  // order is not the decoded one's; the rename is read all the same.
  it("pairs a rename that reorders the struct", () => {
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
    expect(settled(shared)).toEqual([
      ["b", "0"],
      ["a", "a"],
    ]);
  });

  // The review's case: a passthrough between two structs that list the
  // same names in another order, every wire property carrying the AST a
  // decoded one encodes to. Read by place, `sort` was paired with `include`.
  it("pairs each name with itself across a passthrough that reorders the struct", () => {
    const schema = Schema.Struct({
      sort: Schema.toEncoded(Query.Include(Post)),
      include: Schema.toEncoded(Query.Include(Post)),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ include: Query.Include(Post), sort: Query.Sort(["title"]) }),
        SchemaTransformation.passthrough(),
      ),
    );
    expect(settled(schema)).toEqual([
      ["sort", "sort"],
      ["include", "include"],
    ]);
  });

  // The wire struct has fewer properties than the decoded one, and its one
  // property encodes alike with the decoded property at the same place: it
  // is still paired with the property its value lands in.
  it("pairs a wire property with the property its value lands in when the sides differ in size", () => {
    const schema = Schema.Struct({ x: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ y: Schema.String, x: Schema.String }),
        SchemaTransformation.transform({
          decode: ({ x }) => ({ y: "", x }),
          encode: ({ x }) => ({ x }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([["x", "x"]]);
  });

  it("pairs nothing a wire value lands in twice", () => {
    const schema = Schema.Struct({ a: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ x: Schema.String, y: Schema.String }),
        SchemaTransformation.transform({
          decode: ({ a }) => ({ x: a, y: a }),
          encode: ({ x }) => ({ a: x }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // Each falls back to the caller's reading by name.
  it.each([
    [
      "a decode that throws",
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ a: Schema.String }),
          // `BigInt` throws a `SyntaxError` on the probe's non-numeric value.
          SchemaTransformation.transform({
            decode: ({ a }) => ({ a: String(BigInt(a)) }),
            encode: ({ a }) => ({ a }),
          }),
        ),
      ),
    ],
    [
      "a decode that fails",
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ a: Schema.String }),
          SchemaTransformation.transformEffect<{ readonly a: string }, { readonly a: string }>({
            decode: (input) =>
              Effect.fail(new SchemaIssue.InvalidValue({ message: "not on a probe" }, input)),
            encode: Effect.succeed,
          }),
        ),
      ),
    ],
    [
      "a decode that runs asynchronously",
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ a: Schema.String }),
          SchemaTransformation.transformEffect<{ readonly a: string }, { readonly a: string }>({
            decode: () => Effect.never,
            encode: Effect.succeed,
          }),
        ),
      ),
    ],
    [
      "a middleware",
      Schema.Struct({ a: Schema.String }).pipe(Schema.middlewareDecoding((effect) => effect)),
    ],
    [
      "a chain of two transformations",
      Schema.Struct({ x: Schema.String }).pipe(
        Schema.decodeTo(
          Schema.Struct({ a: Schema.String }).pipe(Schema.encodeKeys({ a: "y" })),
          SchemaTransformation.transform({
            decode: ({ x }) => ({ y: x }),
            encode: ({ y }) => ({ x: y }),
          }),
        ),
      ),
    ],
    // The wire is `x`: read as a plain struct, `a` would be paired with `a`.
    [
      "a transformation from a struct with an encoding of its own",
      Schema.Struct({ a: Schema.String })
        .pipe(Schema.encodeKeys({ a: "x" }))
        .pipe(
          Schema.decodeTo(Schema.Struct({ a: Schema.String }), SchemaTransformation.passthrough()),
        ),
    ],
    [
      "a transformation from a value that is no struct",
      Schema.String.pipe(
        Schema.decodeTo(
          Schema.Struct({ a: Schema.String }),
          SchemaTransformation.transform({ decode: (a) => ({ a }), encode: ({ a }) => a }),
        ),
      ),
    ],
    [
      "a decode to a value that is no object",
      Schema.Struct({ a: Schema.String }).pipe(
        Schema.decodeTo(
          Empty,
          SchemaTransformation.transform<typeof Empty.Encoded, { readonly a: string }>({
            decode: () => "",
            encode: () => ({ a: "" }),
          }),
        ),
      ),
    ],
  ] as const)("pairs nothing through %s", (_, schema) => {
    expect(settled(schema)).toEqual([]);
  });

  // A struct-to-struct transformation that is not a rename: neither wire
  // value lands in a decoded property as it was sent, so neither is paired.
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
  // a transformation of its own, not by renaming properties: it pairs its
  // bare `include` and `sort` with themselves, and nothing with another name.
  it("pairs a `Query.schema`'s `include` and `sort` with themselves", () => {
    expect(
      settled(
        Query.schema(Post, { include: true, fields: true, sort: true, page: Query.Page.Offset }),
      ),
    ).toEqual([
      ["include", "include"],
      ["sort", "sort"],
    ]);
  });

  // `filter: true`'s grammar rejects the probe's bare `filter`, so the probe
  // pairs nothing and callers read each property by its name.
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

  // The review's case: `include` alone and `inc` alone both land in `paths`,
  // so a value rejected there may have been sent as either. Read off the
  // full probe alone, `include` was paired with `paths`, and `?inc=nope` was
  // reported as `include`, a parameter the request never sent.
  it("pairs nothing with a decoded property two wire properties can each fill", () => {
    const schema = Schema.Struct({
      include: Schema.optionalKey(Schema.String),
      inc: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ paths: Schema.optionalKey(Schema.String) }),
        SchemaTransformation.transform({
          decode: ({ include, inc }) => {
            const paths = include ?? inc;
            return paths === undefined ? {} : { paths };
          },
          encode: ({ paths }) => (paths === undefined ? {} : { include: paths }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // `inc` alone fills `paths` with a value of its own making, never its
  // sentinel: it still reaches `paths`, so `include` is not paired with it.
  it("pairs nothing with a decoded property another wire property computes", () => {
    const schema = Schema.Struct({
      include: Schema.optionalKey(Schema.String),
      inc: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ paths: Schema.optionalKey(Schema.String) }),
        SchemaTransformation.transform({
          decode: ({ include, inc }) => {
            const paths = include ?? (inc === undefined ? undefined : `${inc}!`);
            return paths === undefined ? {} : { paths };
          },
          encode: ({ paths }) => (paths === undefined ? {} : { include: paths }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // `a` lands in `x` only beside `b`, and no wire property alone fills `x`;
  // but `b` and `c` without `a` put `c` there, so a value rejected in `x`
  // need not have been sent as `a`.
  it("pairs nothing a wire property lands in only beside another", () => {
    const schema = Schema.Struct({
      a: Schema.optionalKey(Schema.String),
      b: Schema.optionalKey(Schema.String),
      c: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ x: Schema.optionalKey(Schema.String) }),
        SchemaTransformation.transform({
          decode: ({ a, b, c }) => {
            const x = b === undefined ? undefined : (a ?? c);
            return x === undefined ? {} : { x };
          },
          encode: ({ x }) => (x === undefined ? {} : { a: x, b: "" }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // `b` alone fails, so its solo probe shows nothing about where it lands:
  // `a` is not paired with `x`, which `b` may fill.
  it("pairs nothing another wire property's failed solo probe may fill", () => {
    const schema = Schema.Struct({
      a: Schema.optionalKey(Schema.String),
      b: Schema.optionalKey(Schema.String),
    }).pipe(
      Schema.decodeTo(
        Schema.Struct({ x: Schema.String }),
        SchemaTransformation.transform({
          // `BigInt` throws a `SyntaxError` on the probe's non-numeric value.
          decode: ({ a, b }) => ({ x: a ?? String(BigInt(b ?? "")) }),
          encode: ({ x }) => ({ a: x }),
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
  });

  // In effect 4.0.0 a synchronous run that goes asynchronous answers
  // `AsyncFiberError` and leaves the fiber running: the rest of the decode
  // would run later on the probe's sentinel values.
  it("interrupts a decode that goes asynchronous, so it never resumes on the probe", async () => {
    const resumed: Array<unknown> = [];
    const schema = Schema.Struct({ a: Schema.String, b: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ a: Schema.String, b: Schema.String }),
        SchemaTransformation.transformEffect<
          { readonly a: string; readonly b: string },
          { readonly a: string; readonly b: string }
        >({
          decode: (input) =>
            Effect.sleep("20 millis").pipe(
              Effect.andThen(
                Effect.sync(() => {
                  resumed.push(input);
                  return input;
                }),
              ),
            ),
          encode: Effect.succeed,
        }),
      ),
    );
    expect(settled(schema)).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resumed).toEqual([]);
  });

  // HttpApi builds an endpoint's codec once, so the struct's AST is the same
  // on every request it rejects: the schema's own decode runs on one set of
  // probes (the full one and one per wire name), never once per request.
  it("runs the probes once per struct", () => {
    const probes: Array<unknown> = [];
    const schema = Schema.Struct({ x: Schema.String, y: Schema.String }).pipe(
      Schema.decodeTo(
        Schema.Struct({ a: Schema.String, b: Schema.String }),
        SchemaTransformation.transform({
          decode: (wire) => {
            probes.push(wire);
            return { a: wire.x, b: wire.y };
          },
          encode: ({ a, b }) => ({ x: a, y: b }),
        }),
      ),
    );
    const pairs = [
      ["a", "x"],
      ["b", "y"],
    ];
    expect(settled(schema)).toEqual(pairs);
    expect(probes).toHaveLength(3);
    expect(settled(schema)).toEqual(pairs);
    expect(probes).toHaveLength(3);
  });
});
