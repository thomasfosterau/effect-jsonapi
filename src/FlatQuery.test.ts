/**
 * The flat list-input grammar: the bounded page cursor and its defaults, the
 * `?sort=` string in both wire spellings and its bounds, the `filter[ids]`
 * list, the slug, the list-input factory, and the tri-state reader.
 */
import { describe, expect, it } from "vite-plus/test";
import { Option, Schema } from "effect";
import * as FlatQuery from "./FlatQuery.js";
import * as Resource from "./Resource.js";

const decode = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Codec<S["Type"]>);
const encode = <S extends Schema.Top>(schema: S) =>
  Schema.encodeUnknownSync(schema as unknown as Schema.Codec<S["Type"], S["Encoded"]>);

describe("pagination", () => {
  const Defaulted = Schema.Struct(FlatQuery.pagination({ maxLimit: 100 }));
  const Required = Schema.Struct(FlatQuery.pagination({ maxLimit: 100, defaultLimit: false }));

  it("defaults an absent cursor to offset 0 / limit 50, or the given default", () => {
    expect(decode(Defaulted)({})).toEqual({ offset: 0, limit: 50 });
    expect(
      decode(Schema.Struct(FlatQuery.pagination({ maxLimit: 100, defaultLimit: 25 })))({}),
    ).toEqual({
      offset: 0,
      limit: 25,
    });
    expect(decode(Defaulted)({ offset: 10, limit: 5 })).toEqual({ offset: 10, limit: 5 });
  });

  it("bounds the window: a positive limit no greater than the cap, a non-negative integer offset", () => {
    expect(() => decode(Defaulted)({ limit: 0 })).toThrow();
    expect(() => decode(Defaulted)({ limit: 101 })).toThrow();
    expect(() => decode(Defaulted)({ limit: 1.5 })).toThrow();
    expect(() => decode(Defaulted)({ offset: -1 })).toThrow();
  });

  it("requires both keys when defaults are off", () => {
    expect(() => decode(Required)({})).toThrow();
    expect(decode(Required)({ offset: 0, limit: 10 })).toEqual({ offset: 0, limit: 10 });
  });
});

describe("SortParam", () => {
  const sort = decode(FlatQuery.SortParam);

  it("decodes the comma form into ordered keys with directions", () => {
    expect(sort("-createdAt,title")).toEqual([
      { field: "createdAt", direction: "desc" },
      { field: "title", direction: "asc" },
    ]);
  });

  it("decodes the repeated-key spelling identically", () => {
    expect(sort(["-createdAt", "title"])).toEqual(sort("-createdAt,title"));
  });

  it("drops a repeated field, first occurrence winning", () => {
    expect(sort("title,-title")).toEqual([{ field: "title", direction: "asc" }]);
  });

  it("rejects an empty value, a trailing comma, a dotted name, whitespace and a fourth key", () => {
    for (const bad of ["", "a,", "a.b", "a, b", "a,b,c,d", "-", "1a"]) {
      expect(() => sort(bad), bad).toThrow();
    }
    expect(FlatQuery.MAX_SORT_FIELDS).toBe(3);
    expect(sort("a,b,c")).toHaveLength(3);
  });

  it("encodes back to the single comma-joined string", () => {
    expect(
      encode(FlatQuery.SortParam)([
        { field: "createdAt", direction: "desc" },
        { field: "title", direction: "asc" },
      ]),
    ).toBe("-createdAt,title");
  });
});

describe("idList", () => {
  const A = "5f0c3f9a-8a18-4f6e-9b2e-7a8a1b2c3d4e";
  const B = "7d1e4c2b-3a5f-4b8c-9d0e-1f2a3b4c5d6e";

  it("decodes the comma form and the repeated-key spelling to a UUID array", () => {
    expect(decode(FlatQuery.IdList)(`${A},${B}`)).toEqual([A, B]);
    expect(decode(FlatQuery.IdList)([A, B])).toEqual([A, B]);
  });

  it("rejects a non-UUID, an empty list and one past the bound", () => {
    expect(() => decode(FlatQuery.IdList)("nope")).toThrow();
    expect(() => decode(FlatQuery.IdList)("")).toThrow();
    expect(() => decode(FlatQuery.idList({ maxLength: 1 }))(`${A},${B}`)).toThrow();
    expect(decode(FlatQuery.idList({ maxLength: 2 }))(`${A},${B}`)).toHaveLength(2);
  });

  it("encodes back to the comma form", () => {
    expect(encode(FlatQuery.IdList)([A, B])).toBe(`${A},${B}`);
  });
});

describe("slug", () => {
  const Slug = FlatQuery.slug({ reserved: ["create", "edit"] });

  it("accepts lowercase kebab-case and rejects everything else", () => {
    expect(decode(Slug)("my-post-title")).toBe("my-post-title");
    expect(decode(Slug)("a1")).toBe("a1");
    for (const bad of ["My-Post", "my_post", "-lead", "trail-", "a--b", "", "a b"]) {
      expect(() => decode(Slug)(bad), bad).toThrow();
    }
  });

  it("rejects a reserved segment and a slug past the length bound", () => {
    expect(() => decode(Slug)("edit")).toThrow(/reserved/);
    expect(decode(FlatQuery.Slug)("edit")).toBe("edit");
    expect(() => decode(FlatQuery.slug({ maxLength: 3 }))("abcd")).toThrow();
  });

  it("projects the resource, create and update shapes", () => {
    const Post = Resource.make("posts", {
      attributes: { title: Schema.NonEmptyString, ...FlatQuery.slugResourceFields(Slug) },
    });
    expect(Resource.attributeKeys(Post)).toEqual(["title", "slug"]);
    // Optional on the resource: a post with no slug never emits `slug: null`.
    expect(
      decode(Post)({ type: "posts", id: "1", attributes: { title: "Hi" } }).attributes,
    ).toEqual({ title: "Hi" });
    const Create = Schema.Struct({ title: Schema.String, ...FlatQuery.slugCreateFields(Slug) });
    expect(decode(Create)({ title: "Hi" })).toEqual({ title: "Hi" });
    expect(decode(Create)({ title: "Hi", slug: "hi" })).toEqual({ title: "Hi", slug: "hi" });
  });
});

describe("listInput", () => {
  const ListArticles = FlatQuery.listInput(
    { maxLimit: 100 },
    { status: Schema.optionalKey(Schema.String) },
  );

  it("merges the defaulted cursor, the optional sort and the extra fields", () => {
    expect(decode(ListArticles)({})).toEqual({ offset: 0, limit: 50 });
    expect(decode(ListArticles)({ sort: "-title", status: "open", limit: 5 })).toEqual({
      offset: 0,
      limit: 5,
      sort: [{ field: "title", direction: "desc" }],
      status: "open",
    });
  });
});

describe("suppliedValue", () => {
  it("collapses an absent key and an explicit none, and keeps a some", () => {
    expect(FlatQuery.suppliedValue(undefined)).toEqual(Option.none());
    expect(FlatQuery.suppliedValue(Option.none())).toEqual(Option.none());
    expect(FlatQuery.suppliedValue(Option.some("x"))).toEqual(Option.some("x"));
  });
});
