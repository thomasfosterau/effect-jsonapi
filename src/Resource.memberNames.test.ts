/**
 * `memberNames`: members carry their wire names everywhere on the wire, and
 * their keys everywhere decoded.
 */
import * as Arr from "effect/Array";
import * as R from "effect/Record";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import { assert, describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as Atomic from "./Atomic.js";
import * as Filter from "./Filter.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import { attribute, extend, make as Resource, memberNames } from "./Resource.js";
import { annotate } from "./Resource.js";

const Person = Resource("people", {
  attributes: { fullName: Schema.String },
  memberNames: "kebab",
});

const Article = Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    createdAt: attribute(Schema.String, { sort: true, filter: true }),
    wordCount: Schema.optionalKey(Schema.Finite),
  },
  relationships: {
    blogAuthor: Relationship.one(() => Person),
    relatedPeople: Relationship.many(() => Person),
  },
  memberNames: "kebab",
});

const wireArticle = {
  type: "articles",
  id: "1",
  attributes: { title: "Hi", "created-at": "2026-11-27" },
  relationships: {
    "blog-author": { data: { type: "people", id: "9" } },
    "related-people": { data: [] },
  },
} as const;

const issues = (result: Result.Result<unknown, Schema.SchemaError>) => {
  assert(Result.isFailure(result), "expected the decode to fail");
  return SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues.map((issue) => ({
    path: issue.path,
    message: issue.message,
  }));
};

describe("memberNames", () => {
  it("renames the resource object's members on the wire, and decodes them to their keys", () => {
    const decoded = Schema.decodeSync(Article)(wireArticle);
    expect(decoded.attributes).toEqual({ title: "Hi", createdAt: "2026-11-27" });
    expect(decoded.relationships?.blogAuthor).toEqual({ data: { type: "people", id: "9" } });
    expect(Schema.encodeSync(Article)(decoded)).toEqual(wireArticle);
    expect(R.keys(Article.fields.attributes.fields)).toEqual(["title", "createdAt", "wordCount"]);
  });

  it("types the encoded side with the wire names and the decoded side with the keys", () => {
    type Encoded = (typeof Article)["Encoded"];
    expectTypeOf<keyof Encoded["attributes"]>().toEqualTypeOf<
      "title" | "created-at" | "word-count"
    >();
    expectTypeOf<keyof NonNullable<Encoded["relationships"]>>().toEqualTypeOf<
      "blog-author" | "related-people"
    >();
    expectTypeOf<keyof (typeof Article)["Type"]["attributes"]>().toEqualTypeOf<
      "title" | "createdAt" | "wordCount"
    >();
    expectTypeOf<
      keyof (typeof Article.createPayload)["Encoded"]["data"]["attributes"]
    >().toEqualTypeOf<"title" | "created-at" | "word-count">();
    expectTypeOf<keyof (typeof Article.createInput)["Encoded"]>().toEqualTypeOf<
      "title" | "created-at" | "word-count"
    >();
  });

  it("reports a failing member at its wire name", () => {
    expect(
      issues(
        Schema.decodeUnknownResult(Article)({
          ...wireArticle,
          attributes: { title: "Hi", "created-at": 1 },
        }),
      ).map((issue) => issue.path),
    ).toContainEqual(["attributes", "created-at"]);
  });

  it("closes write bodies on the wire names: a key sent under its code name is undeclared", () => {
    const decode = Schema.decodeUnknownResult(Article.createPayload);
    const ok = decode({
      data: {
        type: "articles",
        attributes: { title: "Hi", "created-at": "x" },
        relationships: { "blog-author": { data: { type: "people", id: "9" } } },
      },
    });
    assert(Result.isSuccess(ok));
    expect(ok.success.data.attributes).toEqual({ title: "Hi", createdAt: "x" });
    expect(ok.success.data.relationships.blogAuthor.data.id).toBe("9");
    expect(
      issues(
        decode({
          data: {
            type: "articles",
            attributes: { title: "Hi", "created-at": "x", createdAt: "y" },
            relationships: { "blog-author": { data: { type: "people", id: "9" } } },
          },
        }),
      ),
    ).toEqual([
      { path: ["data", "attributes", "createdAt"], message: "Expected no excess property" },
    ]);
  });

  it("renames the update payload and the flat inputs", () => {
    const update = Schema.decodeSync(Article.updatePayload)({
      data: { type: "articles", id: "1", attributes: { "word-count": 3 } },
    });
    expect(update.data.attributes).toEqual({ wordCount: 3 });
    expect(Schema.decodeSync(Article.createInput)({ title: "a", "created-at": "b" })).toEqual({
      title: "a",
      createdAt: "b",
    });
    expect(Schema.decodeSync(Article.updateInput)({ id: "1", "word-count": 2 })).toMatchObject({
      wordCount: 2,
    });
  });

  it("records the resolved names, and keeps them through extend and annotate", () => {
    expect(memberNames(Article)).toEqual({
      createdAt: "created-at",
      wordCount: "word-count",
      blogAuthor: "blog-author",
      relatedPeople: "related-people",
    });
    const Feature = extend(Article, "features", {
      attributes: { heroImage: Schema.String, pullQuote: Schema.String },
      memberNames: { heroImage: "hero" },
    });
    expect(memberNames(Feature)).toEqual({ ...memberNames(Article), heroImage: "hero" });
    expectTypeOf<keyof (typeof Feature)["Encoded"]["attributes"]>().toEqualTypeOf<
      "title" | "created-at" | "word-count" | "hero" | "pullQuote"
    >();
    expect(memberNames(annotate(Article, { title: "Article" }))).toEqual(memberNames(Article));
  });

  it("leaves a resource without memberNames exactly as it was", () => {
    const Plain = Resource("plain", { attributes: { createdAt: Schema.String } });
    expect(memberNames(Plain)).toEqual({});
    expectTypeOf<keyof (typeof Plain)["Encoded"]["attributes"]>().toEqualTypeOf<"createdAt">();
    expectTypeOf(Plain.fields.attributes).toEqualTypeOf<
      Schema.Struct<{ readonly createdAt: Schema.String }>
    >();
  });

  it("types the function form's wire names as string", () => {
    const Upper = Resource("upper", {
      attributes: { name: Schema.String },
      memberNames: (key) => key.toUpperCase(),
    });
    const wire = { type: "upper", id: "1", attributes: { NAME: "x" } };
    const decoded = Schema.decodeUnknownSync(Upper)(wire);
    expect(decoded.attributes).toEqual({ name: "x" });
    expect(Schema.encodeSync(Upper)(decoded)).toEqual(wire);
    expectTypeOf<(typeof Upper)["Encoded"]["attributes"]>().toEqualTypeOf<{
      readonly [x: string]: string;
    }>();
  });

  it("refuses a name that is illegal, reserved, shared, or names an undeclared key", () => {
    expect(() =>
      Resource("bad", { attributes: { a: Schema.String }, memberNames: { a: "a!" } }),
    ).toThrow(/member "a" is formatted as "a!", which is not a legal JSON:API member name/);
    expect(() =>
      Resource("bad", { attributes: { a: Schema.String }, memberNames: { a: "id" } }),
    ).toThrow(/a name JSON:API reserves/);
    expect(() =>
      Resource("bad", {
        attributes: { a_b: Schema.String, aB: Schema.String },
        memberNames: "kebab",
      }),
    ).toThrow(/members "a_b" and "aB" are both formatted as "a-b"/);
    expect(() =>
      Resource("bad", {
        attributes: { a: Schema.String },
        relationships: { b: Relationship.one(() => Person) },
        memberNames: { b: "a" },
      }),
    ).toThrow(/members "a" and "b" are both formatted as "a"/);
    expect(() =>
      Resource("bad", { attributes: { a: Schema.String }, memberNames: { c: "d" } as never }),
    ).toThrow(/memberNames names "c", which the resource does not declare/);
  });

  describe("query vocabularies", () => {
    const query = Query.schema(Article, { include: true, fields: true, sort: true, filter: true });
    const decode = Schema.decodeUnknownResult(query);

    it("decode wire names to keys, and encode them back", () => {
      const wire = {
        include: "blog-author",
        "fields[articles]": "title,created-at,blog-author",
        "fields[people]": "full-name",
        sort: "-created-at,title",
        "filter[created-at]": "2026",
      };
      const decoded = Schema.decodeSync(query)(wire);
      expect(decoded.include).toEqual(["blogAuthor"]);
      expect(decoded.fields?.articles).toEqual(["title", "createdAt", "blogAuthor"]);
      expect(decoded.fields?.people).toEqual(["fullName"]);
      expect(decoded.sort).toEqual([
        { field: "createdAt", direction: "desc" },
        { field: "title", direction: "asc" },
      ]);
      expect(decoded.filter).toEqual(Filter.eq("createdAt", "2026"));
      expect(Schema.encodeSync(query)(decoded)).toEqual(wire);
    });

    it("reject a member sent under its key", () => {
      Arr.forEach(
        [
          { include: "blogAuthor" },
          { "fields[articles]": "createdAt" },
          { sort: "createdAt" },
          { "filter[createdAt]": "x" },
        ],
        (input, i) => assert(Result.isFailure(decode(input)), `input ${i}`),
      );
    });

    it("decode the standalone codecs the same way", () => {
      expect(Schema.decodeSync(Query.Include(Article))("blog-author")).toEqual(["blogAuthor"]);
      expect(Schema.decodeSync(Query.Fieldset(Article))("created-at")).toEqual(["createdAt"]);
      expect(Schema.decodeSync(Query.Filter(Article))({ "filter[created-at][ne]": "x" })).toEqual(
        Filter.ne("createdAt", "x"),
      );
      expect(Schema.encodeSync(Query.Filter(Article))(Filter.eq("createdAt", "y"))).toEqual({
        "filter[created-at]": "y",
      });
    });
  });

  it("renames the atomic operations' members and relationship refs", () => {
    const add = Schema.decodeSync(Atomic.AddOperation(Article))({
      op: "add",
      data: {
        type: "articles",
        attributes: { title: "Hi", "created-at": "x" },
        relationships: { "blog-author": { data: { type: "people", id: "9" } } },
      },
    });
    expect(add.data.attributes).toEqual({ title: "Hi", createdAt: "x" });
    const ref = Atomic.RelationshipRef(Article, "blogAuthor");
    const wire = { type: "articles", id: "1", relationship: "blog-author" };
    const decoded = Schema.decodeUnknownSync(ref)(wire);
    expect(decoded.relationship).toBe("blogAuthor");
    expect(Schema.encodeSync(ref)(decoded)).toEqual(wire);
    expectTypeOf<(typeof ref)["Encoded"]["relationship"]>().toEqualTypeOf<"blog-author">();
  });

  it("types and spells the snake and camel presets alike", () => {
    const Snake = Resource("snakes", {
      attributes: { createdAt: Schema.String, "word-count": Schema.Finite },
      memberNames: "snake",
    });
    const Camel = Resource("camels", {
      attributes: { created_at: Schema.String, "word-count": Schema.Finite },
      memberNames: "camel",
    });
    expect(memberNames(Snake)).toEqual({ createdAt: "created_at", "word-count": "word_count" });
    expect(memberNames(Camel)).toEqual({ created_at: "createdAt", "word-count": "wordCount" });
    expectTypeOf<keyof (typeof Snake)["Encoded"]["attributes"]>().toEqualTypeOf<
      "created_at" | "word_count"
    >();
    expectTypeOf<keyof (typeof Camel)["Encoded"]["attributes"]>().toEqualTypeOf<
      "createdAt" | "wordCount"
    >();
  });
});
