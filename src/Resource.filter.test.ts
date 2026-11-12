import * as Arr from "effect/Array";
import * as DateTime from "effect/DateTime";
import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Endpoint from "./Endpoint.js";
import * as Filter from "./Filter.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import {
  attribute,
  attributes,
  extend,
  family,
  filterable,
  make as Resource,
  readOnlyAttribute,
  sortable,
} from "./Resource.js";
import type { Filterable, FilterableKeys, FilterOperators, SortableKeys } from "./Resource.js";
import * as Sort from "./Sort.js";

const at = (input: string | number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(input));

// ---------------------------------------------------------------------------
// Filterable and sortable declarations (#84)
// ---------------------------------------------------------------------------

const Supplier = Resource("suppliers", { attributes: { name: Schema.NonEmptyString } });

const Product = Resource("products", {
  attributes: {
    name: Schema.NonEmptyString, // plain: neither filterable nor sortable
    // the full operator core, sortable — the pipeable form
    priceCents: Schema.Int.pipe(Filter.able(), Sort.able()),
    // a subset, in the order given (duplicates dropped) — the options sugar
    stock: attribute(Schema.Finite, { filter: ["gte", "eq", "lte", "eq"] }),
    // declared, but neither filterable nor sortable
    sku: attribute(Schema.String, { create: "required", update: false }),
    // sortable only
    createdAt: readOnlyAttribute(Schema.DateFromString),
    updatedAt: attribute(Schema.DateFromString.pipe(Sort.able()), { create: false, update: false }),
  },
  relationships: {
    // a filterable to-one relationship (a subset) and an unfilterable one
    supplier: Relationship.one(() => Supplier, { filter: ["eq", "in"] }),
    maker: Relationship.optional(() => Supplier),
  },
});

describe("Resource.filterable / Resource.sortable", () => {
  it("declares nothing by default", () => {
    const Plain = Resource("plains", {
      attributes: { name: Schema.String, n: attribute(Schema.Finite) },
      relationships: {
        supplier: Relationship.one(() => Supplier),
        other: Relationship.optional(() => Supplier),
      },
    });
    expect(filterable(Plain)).toEqual({});
    expect(sortable(Plain)).toEqual([]);
    expectTypeOf<FilterableKeys<typeof Plain>>().toEqualTypeOf<never>();
    expectTypeOf<SortableKeys<typeof Plain>>().toEqualTypeOf<never>();
    expectTypeOf(filterable(Plain)).toEqualTypeOf<Record<never, never>>();
    expectTypeOf(sortable(Plain)).toEqualTypeOf<ReadonlyArray<never>>();
  });

  it("returns the declared sets, undeclared keys absent", () => {
    const declared = filterable(Product);
    expect(Object.keys(declared)).toEqual(["priceCents", "stock", "supplier"]);
    expect("name" in declared).toBe(false);
    expect("sku" in declared).toBe(false);
    expect("maker" in declared).toBe(false);
    // sortable is attributes only
    expect(sortable(Product)).toEqual(["priceCents", "updatedAt"]);
  });

  it("expands `filter: true` to the full operator core and keeps a subset in order", () => {
    const declared = filterable(Product);
    expect(declared.priceCents.operators).toEqual(Filter.operators);
    expect(declared.stock.operators).toEqual(["gte", "eq", "lte"]);
  });

  it("types the keys and operators as literal unions", () => {
    expectTypeOf<FilterableKeys<typeof Product>>().toEqualTypeOf<
      "priceCents" | "stock" | "supplier"
    >();
    expectTypeOf<SortableKeys<typeof Product>>().toEqualTypeOf<"priceCents" | "updatedAt">();
    expectTypeOf<FilterOperators<typeof Product, "priceCents">>().toEqualTypeOf<Filter.Operator>();
    expectTypeOf<FilterOperators<typeof Product, "stock">>().toEqualTypeOf<"gte" | "eq" | "lte">();
    expectTypeOf<FilterOperators<typeof Product, "supplier">>().toEqualTypeOf<"eq" | "in">();
    const declared = filterable(Product);
    expectTypeOf(declared).toEqualTypeOf<Filterable<typeof Product>>();
    expectTypeOf(declared.stock.operators).toEqualTypeOf<ReadonlyArray<"gte" | "eq" | "lte">>();
    expectTypeOf(declared.priceCents.literal.Type).toEqualTypeOf<number>();
    expectTypeOf(declared.priceCents.literal.Encoded).toEqualTypeOf<string>();
    expectTypeOf(declared.supplier.literal.Type).toEqualTypeOf<typeof Supplier.Id.Type>();
    expectTypeOf(sortable(Product)).toEqualTypeOf<ReadonlyArray<"priceCents" | "updatedAt">>();
    // undeclared attributes and relationships are not filterable keys:
    // test/rejected-calls.types.ts
  });

  it("rejects an attribute operator outside the closed core at definition time", () => {
    expect(() => attribute(Schema.String, { filter: ["eq", "like" as never] })).toThrow(
      /declares filter operator "like"; expected one of eq, ne/,
    );
  });

  it("carries the declaration through Resource.extend (attributes and relationships)", () => {
    const Child = extend(Product, "gadgets", {
      attributes: { colour: attribute(Schema.String, { filter: ["eq", "in"], sort: true }) },
      relationships: { origin: Relationship.optional(() => Supplier, { filter: ["isnull"] }) },
    });
    expect(Object.keys(filterable(Child))).toEqual([
      "priceCents",
      "stock",
      "colour",
      "supplier",
      "origin",
    ]);
    expect(filterable(Child).colour.operators).toEqual(["eq", "in"]);
    expect(filterable(Child).supplier.operators).toEqual(["eq", "in"]);
    expect(filterable(Child).origin.operators).toEqual(["isnull"]);
    expect(sortable(Child)).toEqual(["priceCents", "updatedAt", "colour"]);
    expectTypeOf<FilterableKeys<typeof Child>>().toEqualTypeOf<
      "priceCents" | "stock" | "colour" | "supplier" | "origin"
    >();
    expectTypeOf<SortableKeys<typeof Child>>().toEqualTypeOf<
      "priceCents" | "updatedAt" | "colour"
    >();
  });

  it('survives the optionalKey wrapping of `resource: "optional"`', () => {
    const res = Resource("optionals", {
      attributes: {
        nickname: attribute(Schema.String, { resource: "optional", filter: ["eq"], sort: true }),
      },
    });
    // the descriptor is readable through the optionalKey wrapper
    expect(Schema.resolveAnnotations(res.fields.attributes.fields.nickname)).toHaveProperty(
      "@thomasfosterau/effect-jsonapi/attribute",
    );
    expect(filterable(res).nickname.operators).toEqual(["eq"]);
    expect(sortable(res)).toEqual(["nickname"]);
    expect(Schema.decodeSync(filterable(res).nickname.literal)("x")).toBe("x");
    expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<"nickname">();
    expectTypeOf(filterable(res).nickname.literal.Type).toEqualTypeOf<string>();
  });

  it("allows `isnull` on a non-nullable attribute", () => {
    const res = Resource("nn", {
      attributes: { n: attribute(Schema.Finite, { filter: ["isnull"] }) },
    });
    expect(filterable(res).n.operators).toEqual(["isnull"]);
  });

  it("composes with Query.schema and Endpoint.list as the sort allow-list", () => {
    const query = Query.schema(Product, { sort: sortable(Product) });
    expect(Schema.decodeSync(query)({ sort: "-updatedAt,priceCents" })).toEqual({
      sort: [
        { field: "updatedAt", direction: "desc" },
        { field: "priceCents", direction: "asc" },
      ],
    });
    // undeclared attributes are rejected (→ 400), declared-but-unsortable ones too
    expect(() => Schema.decodeSync(query)({ sort: "name" })).toThrow();
    expect(() => Schema.decodeSync(query)({ sort: "stock" })).toThrow();
    type Decoded = typeof query.Type;
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<
      "priceCents" | "updatedAt"
    >();

    const list = Endpoint.list(Product, { sort: sortable(Product) });
    const listQuery = list.query as Schema.Codec<unknown, unknown>;
    expect(Schema.decodeSync(listQuery)({ sort: "priceCents" })).toEqual({
      sort: [{ field: "priceCents", direction: "asc" }],
    });
    expect(() => Schema.decodeSync(listQuery)({ sort: "name" })).toThrow();
  });

  it("reports the base's declaration through a base-anchored family, nothing through a name-only one", () => {
    const Node = Resource("nodes", {
      attributes: { name: attribute(Schema.NonEmptyString, { filter: ["eq", "in"], sort: true }) },
      relationships: { owner: Relationship.one(() => Supplier, { filter: true }) },
    });
    const Person = extend(Node, "people", { inheritId: true });
    const Organisation = extend(Node, "organisations", { inheritId: true });
    const Anchored = family(Node, [Person, Organisation]);
    expect(Object.keys(filterable(Anchored))).toEqual(["name", "owner"]);
    expect(filterable(Anchored).name.operators).toEqual(["eq", "in"]);
    expect(filterable(Anchored).owner.operators).toEqual(Relationship.filterOperators);
    expect(sortable(Anchored)).toEqual(["name"]);
    expectTypeOf<FilterableKeys<typeof Anchored>>().toEqualTypeOf<"name" | "owner">();
    expectTypeOf<SortableKeys<typeof Anchored>>().toEqualTypeOf<"name">();

    const NameOnly = family("things", [Person, Organisation]);
    expect(filterable(NameOnly)).toEqual({});
    expect(sortable(NameOnly)).toEqual([]);
    expectTypeOf<FilterableKeys<typeof NameOnly>>().toEqualTypeOf<never>();
    expectTypeOf<SortableKeys<typeof NameOnly>>().toEqualTypeOf<never>();
  });

  describe("to-one relationships as filter fields", () => {
    const Person = Resource("people", { attributes: { name: Schema.NonEmptyString } });
    const Article = Resource("articles", {
      attributes: { title: Schema.NonEmptyString },
      relationships: {
        author: Relationship.one(() => Person, { filter: true }),
        editor: Relationship.optional(() => Person, { filter: ["eq", "isnull"] }),
        reviewer: Relationship.optional(() => Person),
        tags: Relationship.many(() => Person),
        comments: Relationship.paginated(() => Person),
      },
    });

    it("declares on `one` and `optional`; `true` is the five relationship operators", () => {
      const declared = filterable(Article);
      expect(Object.keys(declared)).toEqual(["author", "editor"]);
      expect(declared.author.operators).toEqual(["eq", "ne", "in", "nin", "isnull"]);
      expect(declared.author.operators).toEqual(Relationship.filterOperators);
      expect(declared.editor.operators).toEqual(["eq", "isnull"]);
      expect(Article.relationships.author.filter).toBe(true);
      expect(Article.relationships.reviewer.filter).toBe(false);
    });

    it("types relationship keys and operators as literal unions", () => {
      expectTypeOf<FilterableKeys<typeof Article>>().toEqualTypeOf<"author" | "editor">();
      expectTypeOf<
        FilterOperators<typeof Article, "author">
      >().toEqualTypeOf<Relationship.FilterOperator>();
      expectTypeOf<FilterOperators<typeof Article, "editor">>().toEqualTypeOf<"eq" | "isnull">();
      expectTypeOf(filterable(Article).author.literal.Type).toEqualTypeOf<typeof Person.Id.Type>();
      expectTypeOf(filterable(Article).author.literal.Encoded).toEqualTypeOf<string>();
      // the relationship descriptor carries the declaration at the type level
      expectTypeOf(Article.relationships.author).toEqualTypeOf<
        Relationship.one<typeof Person, true>
      >();
      expectTypeOf(Article.relationships.reviewer).toEqualTypeOf<
        Relationship.optional<typeof Person>
      >();
      // existing descriptor matches still hold with the widened default
      expectTypeOf(Article.relationships.author).toMatchTypeOf<Relationship.One<typeof Person>>();
      expectTypeOf(Article.relationships.editor).toMatchTypeOf<Relationship.ToOne<typeof Person>>();
    });

    it("uses the target's Id schema as the literal codec, resolved lazily", () => {
      const declared = filterable(Article);
      const id = Schema.decodeSync(declared.author.literal)("9");
      expect(id).toBe("9");
      expectTypeOf(id).toEqualTypeOf<typeof Person.Id.Type>();
      expect(Schema.encodeUnknownSync(declared.author.literal)(Person.Id.make("9"))).toBe("9");
      // a custom id codec on the target applies too
      const Account = Resource("accounts", {
        id: Schema.String.pipe(Schema.brand("AccountId")),
        attributes: { email: Schema.String },
      });
      const Session = Resource("sessions", {
        attributes: { token: Schema.String },
        relationships: { account: Relationship.one(() => Account, { filter: ["eq"] }) },
      });
      expectTypeOf(filterable(Session).account.literal.Type).toEqualTypeOf<
        typeof Account.Id.Type
      >();
      expect(Schema.decodeSync(filterable(Session).account.literal)("a1")).toBe("a1");
    });

    it("resolves a forward-referenced target only when the literal is used", () => {
      // `Late` is defined after `Early`, which references it; nothing is forced at `make`.
      const Early = Resource("earlies", {
        attributes: { n: Schema.Finite },
        relationships: { late: Relationship.one((): typeof Late => Late, { filter: ["eq"] }) },
      });
      const Late = Resource("lates", { attributes: { m: Schema.Finite } });
      expect(Schema.decodeSync(filterable(Early).late.literal)("7")).toBe("7");
    });

    it("rejects an ordering operator on a relationship at Resource.make", () => {
      expect(() =>
        Resource("bad", {
          attributes: { title: Schema.String },
          relationships: {
            author: Relationship.one(() => Person, { filter: ["eq", "lt" as never] }),
          },
        }),
      ).toThrow(/Resource\.make\("bad"\): relationship "author" declares filter operator "lt"/);
    });
  });

  describe("the resource id as a filter field (#556)", () => {
    const Notes = Resource("notes", {
      id: Schema.String.pipe(Filter.able(["eq", "in"])),
      attributes: { title: Schema.String.pipe(Filter.able(["eq"])) },
    });

    it("reports a Filter.able id under `id`, first, with the id schema as its literal", () => {
      const declared = filterable(Notes);
      expect(R.keys(declared)).toEqual(["id", "title"]);
      expect(declared.id.operators).toEqual(["eq", "in"]);
      expect(Schema.decodeSync(declared.id.literal)("n-1")).toBe("n-1");
      expect(Schema.encodeSync(declared.id.literal)("n-1")).toBe("n-1");
    });

    it("types the id key, its operators and its literal", () => {
      expectTypeOf<FilterableKeys<typeof Notes>>().toEqualTypeOf<"id" | "title">();
      expectTypeOf<FilterOperators<typeof Notes, "id">>().toEqualTypeOf<"eq" | "in">();
      expectTypeOf(filterable(Notes).id.literal.Type).toEqualTypeOf<string>();
      expectTypeOf(filterable(Notes).id.literal.Encoded).toEqualTypeOf<string>();
    });

    it("leaves the default id, and an undeclared custom id, unfilterable", () => {
      const Plain = Resource("plains", { attributes: { title: Schema.String } });
      const Custom = Resource("customs", {
        id: Schema.String.pipe(Schema.brand("CustomId")),
        attributes: { title: Schema.String },
      });
      expect(R.keys(filterable(Plain))).toEqual([]);
      expect(R.keys(filterable(Custom))).toEqual([]);
      expectTypeOf<FilterableKeys<typeof Plain>>().toEqualTypeOf<never>();
      expectTypeOf<FilterableKeys<typeof Custom>>().toEqualTypeOf<never>();
    });

    it("decodes filter[id] in the shorthand, operator and group forms", () => {
      const decode = Schema.decodeUnknownSync(Query.Filter(Notes));
      expect(decode({ "filter[id]": "n-1" })).toEqual(Filter.eq("id", "n-1"));
      expect(decode({ "filter[id][in]": "n-1,n-2" })).toEqual(Filter.isIn("id", ["n-1", "n-2"]));
      expect(decode({ "filter[id]": "n-1,n-2" })).toEqual(Filter.isIn("id", ["n-1", "n-2"]));
      expect(
        decode({
          "filter[c][condition][path]": "id",
          "filter[c][condition][operator]": "eq",
          "filter[c][condition][value]": "n-1",
        }),
      ).toEqual(Filter.eq("id", "n-1"));
      // an operator the id does not declare is still refused
      expect(() => decode({ "filter[id][gt]": "n-1" })).toThrow(/gt/);
      // and the id literal encodes back to the wire
      expect(Schema.encodeSync(Query.Filter(Notes))(Filter.eq("id", "n-1"))).toEqual({
        "filter[id]": "n-1",
      });
    });

    it("decodes the literal through the id schema, refinements and brands included", () => {
      const Accounts = Resource("accounts", {
        id: Schema.String.pipe(
          Schema.check(Schema.isPattern(/^a-\d+$/)),
          Schema.brand("AccountId"),
          Filter.able(["eq"]),
        ),
        attributes: { email: Schema.String },
      });
      const literal = filterable(Accounts).id.literal;
      expect(Schema.decodeSync(literal)("a-1")).toBe("a-1");
      expect(() => Schema.decodeSync(literal)("b")).toThrow();
      expectTypeOf(literal.Type).toEqualTypeOf<typeof Accounts.Id.Type>();
    });

    it("is inherited by extend with inheritId, and not by a fresh id", () => {
      const Inherited = extend(Notes, "pinned-notes", { inheritId: true });
      const Fresh = extend(Notes, "fresh-notes");
      expect(R.keys(filterable(Inherited))).toEqual(["id", "title"]);
      expect(R.keys(filterable(Fresh))).toEqual(["title"]);
      expectTypeOf<FilterableKeys<typeof Inherited>>().toEqualTypeOf<"id" | "title">();
      expectTypeOf<FilterOperators<typeof Inherited, "id">>().toEqualTypeOf<"eq" | "in">();
      expectTypeOf(filterable(Inherited).id.literal.Type).toEqualTypeOf<typeof Inherited.Id.Type>();
      expectTypeOf<FilterableKeys<typeof Fresh>>().toEqualTypeOf<"title">();
    });

    it("is reported through a base-anchored family", () => {
      const Pinned = extend(Notes, "pinned", { inheritId: true });
      const AnyNote = family(Notes, [Notes, Pinned]);
      expect(R.keys(filterable(AnyNote))).toEqual(["id", "title"]);
    });
  });

  describe("literal codec", () => {
    const Cents = Schema.Finite.pipe(Schema.brand("Cents"));
    const res = Resource("literals", {
      attributes: {
        title: attribute(Schema.NonEmptyString, { filter: true }),
        count: attribute(Schema.Finite, { filter: true }),
        whole: attribute(Schema.Int, { filter: true }),
        flag: attribute(Schema.Boolean, { filter: true }),
        rating: attribute(Schema.NullOr(Schema.Finite), { filter: true }),
        publishedAt: attribute(Schema.DateFromString, { filter: ["gte", "lte"] }),
        status: attribute(Schema.Literals(["draft", "published"]), { filter: ["eq", "in"] }),
        priority: attribute(Schema.NullOr(Schema.Literals([1, 2, 3])), { filter: ["eq"] }),
        price: attribute(Cents, { filter: ["gt"] }),
      },
    });
    const declared = filterable(res);
    type Declared = typeof declared;
    const decode = <K extends keyof Declared>(key: K) =>
      Schema.decodeUnknownSync(declared[key].literal) as (
        input: string,
      ) => Declared[K]["literal"]["Type"];
    const encode = <K extends keyof Declared>(key: K) =>
      Schema.encodeUnknownSync(declared[key].literal) as (
        value: Declared[K]["literal"]["Type"],
      ) => string;

    it("decodes strings through the attribute schema", () => {
      expect(decode("title")("Hello, world")).toBe("Hello, world");
      // the attribute's own refinement applies: NonEmptyString rejects ""
      expect(() => decode("title")("")).toThrow();
      expectTypeOf(declared.title.literal.Type).toEqualTypeOf<string>();
    });

    it("decodes numbers strictly", () => {
      expect(decode("count")("42")).toBe(42);
      expect(decode("count")("-1.5")).toBe(-1.5);
      expect(decode("count")("1e3")).toBe(1000);
      expect(decode("count")(".5")).toBe(0.5);
      expect(decode("count")("+7")).toBe(7);
      // everything `Number()` would coerce loosely is rejected
      expect(() => decode("count")("abc")).toThrow(/number filter literal/);
      expect(() => decode("count")("")).toThrow(/number filter literal/);
      expect(() => decode("count")("   ")).toThrow();
      expect(() => decode("count")(" 1")).toThrow();
      expect(() => decode("count")("0x10")).toThrow();
      expect(() => decode("count")("1_000")).toThrow();
      expect(() => decode("count")("NaN")).toThrow();
      expect(() => decode("count")("Infinity")).toThrow();
      expect(() => decode("count")("1e999")).toThrow();
      // the attribute's own refinement applies: Int rejects a fraction
      expect(decode("whole")("3")).toBe(3);
      expect(() => decode("whole")("3.5")).toThrow();
    });

    it("decodes booleans as exactly true / false", () => {
      expect(decode("flag")("true")).toBe(true);
      expect(decode("flag")("false")).toBe(false);
      expect(() => decode("flag")("tru")).toThrow(/boolean filter literal/);
      expect(() => decode("flag")("TRUE")).toThrow();
      expect(() => decode("flag")("1")).toThrow();
      expect(() => decode("flag")("")).toThrow();
    });

    it("strips NullOr: the literal is the non-null member and is never null", () => {
      expect(decode("rating")("4.5")).toBe(4.5);
      expect(() => decode("rating")("null")).toThrow();
      expect(() => decode("rating")("")).toThrow();
      expect(() => encode("rating")(null as never)).toThrow();
      expectTypeOf(declared.rating.literal.Type).toEqualTypeOf<number>();
      expect(decode("priority")("2")).toBe(2);
      expect(() => decode("priority")("4")).toThrow();
      expectTypeOf(declared.priority.literal.Type).toEqualTypeOf<1 | 2 | 3>();
    });

    it("decodes DateFromString to a Date and re-encodes via the attribute encoder", () => {
      const decoded = decode("publishedAt")("2026-01-01T00:00:00.000Z");
      expect(decoded).toBeInstanceOf(Date);
      expect(decoded.toISOString()).toBe("2026-01-01T00:00:00.000Z");
      expect(() => decode("publishedAt")("not a date")).toThrow();
      expect(encode("publishedAt")(at("2026-01-01T00:00:00.000Z"))).toBe(
        "2026-01-01T00:00:00.000Z",
      );
      expectTypeOf(declared.publishedAt.literal.Type).toEqualTypeOf<Date>();
    });

    it("decodes a literal union against its members", () => {
      expect(decode("status")("draft")).toBe("draft");
      expect(() => decode("status")("bogus")).toThrow();
      expectTypeOf(declared.status.literal.Type).toEqualTypeOf<"draft" | "published">();
    });

    it("decodes a branded number, keeping the brand", () => {
      const value = decode("price")("1250");
      expect(value).toBe(1250);
      expectTypeOf(value).toEqualTypeOf<typeof Cents.Type>();
      expect(() => decode("price")("abc")).toThrow();
    });

    it("round-trips: encode ∘ decode is identity on canonical strings, decode ∘ encode on values", () => {
      Arr.forEach(
        [
          ["title", "Hello"],
          ["count", "42"],
          ["count", "-1.5"],
          ["flag", "true"],
          ["flag", "false"],
          ["rating", "4.5"],
          ["publishedAt", "2026-01-01T00:00:00.000Z"],
          ["status", "published"],
          ["priority", "3"],
          ["price", "1250"],
        ] as const,
        ([key, input]) => {
          expect(encode(key)(decode(key)(input) as never)).toBe(input);
        },
      );
      expect(decode("count")(encode("count")(1e21))).toBe(1e21);
      expect(decode("count")(encode("count")(0.1))).toBe(0.1);
      expect(decode("flag")(encode("flag")(false))).toBe(false);
      const when = at("2025-12-31T23:59:59.999Z");
      expect(decode("publishedAt")(encode("publishedAt")(when)).getTime()).toBe(when.getTime());
    });

    it("uses an explicit `filterLiteral` in place of the derived codec", () => {
      // an attribute whose encoded form is a struct — no derivation possible
      const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Point, {
          decode: SchemaGetter.transform((s: string) => {
            const [x, y] = s.split(":").map(Number);
            return { x: x, y: y };
          }),
          encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`),
        }),
      );
      const WithOverride = Resource("points", {
        attributes: {
          origin: attribute(Point, { filter: ["eq"], filterLiteral: PointFromString }),
        },
      });
      const literal = filterable(WithOverride).origin.literal;
      expect(literal).toBe(PointFromString);
      expect(Schema.decodeSync(literal)("1:2")).toEqual({ x: 1, y: 2 });
      expect(Schema.encodeUnknownSync(literal)({ x: 3, y: 4 })).toBe("3:4");
      expectTypeOf(literal.Type).toEqualTypeOf<{ readonly x: number; readonly y: number }>();
    });

    it("throws at Resource.make for a filterable attribute whose encoded form is not a scalar", () => {
      expect(() =>
        Resource("bad-date", { attributes: { when: attribute(Schema.Date, { filter: true }) } }),
      ).toThrow(/Resource\.make\("bad-date"\): attribute "when" is declared filterable/);
      expect(() =>
        Resource("bad-array", {
          attributes: { tags: attribute(Schema.Array(Schema.String), { filter: ["eq"] }) },
        }),
      ).toThrow(/attribute "tags"/);
      expect(() =>
        Resource("bad-struct", {
          attributes: { point: attribute(Schema.Struct({ x: Schema.Finite }), { filter: ["eq"] }) },
        }),
      ).toThrow(/filterLiteral/);
      expect(() =>
        Resource("bad-mixed", {
          attributes: { v: attribute(Schema.Literals(["a", 1]), { filter: ["eq"] }) },
        }),
      ).toThrow(/attribute "v"/);
      // the same schemas are fine when not declared filterable
      expect(() =>
        Resource("fine", {
          attributes: {
            when: attribute(Schema.Date, { sort: true }),
            tags: Schema.Array(Schema.String),
          },
        }),
      ).not.toThrow();
    });
  });

  describe("definition-time guards", () => {
    it("rejects an empty operator list on an attribute and on a relationship", () => {
      expect(() => attribute(Schema.String, { filter: [] })).toThrow(/declares filter: \[\]/);
      expect(() =>
        Resource("empty-rel", {
          attributes: {},
          relationships: { supplier: Relationship.one(() => Supplier, { filter: [] }) },
        }),
      ).toThrow(/relationship "supplier" declares filter: \[\]/);
    });

    it("rejects `filterLiteral` without `filter`", () => {
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Schema.Finite, {
          decode: SchemaGetter.transform((s: string) => Number(s)),
          encode: SchemaGetter.transform((n: number) => String(n)),
        }),
      );
      expect(() => attribute(Schema.Finite, { filterLiteral: PointFromString })).toThrow(
        /`filterLiteral` given without `filter`/,
      );
    });

    it("ignores a descriptor whose inner schema carries no declaration (older or hand-made annotations)", () => {
      const legacy = Schema.Date.annotate({
        "@thomasfosterau/effect-jsonapi/attribute": {
          schema: Schema.Date,
          create: false,
          update: false,
          clearable: false,
          // fields an older copy of the package stamped; no longer read
          filter: ["eq"],
          sort: true,
        },
      });
      const Legacy = Resource("legacy", { attributes: { when: legacy } });
      expect(filterable(Legacy)).toEqual({});
      expect(sortable(Legacy)).toEqual([]);
    });

    it("rejects a malformed hand-stamped filter annotation at Resource.make", () => {
      const bad = Schema.Finite.annotate({ [Filter.AnnotationId]: { operators: ["like"] } });
      expect(() => Resource("bad-annotation", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-annotation"\): attribute "n" carries a malformed filter declaration/,
      );
      const empty = Schema.Finite.annotate({ [Filter.AnnotationId]: { operators: [] } });
      expect(() => Resource("empty-annotation", { attributes: { n: empty } })).toThrow(
        /malformed filter declaration/,
      );
    });

    it("admits a template-literal attribute as a string literal", () => {
      const Coded = Resource("coded", {
        attributes: {
          code: attribute(Schema.TemplateLiteral(["X-", Schema.Finite]), { filter: ["eq"] }),
        },
      });
      const literal = filterable(Coded).code.literal;
      expect(Schema.decodeSync(literal)("X-12")).toBe("X-12");
      expect(() => Schema.decodeSync(literal)("Y-12")).toThrow();
    });

    it("refuses to encode a non-finite number, so decode ∘ encode stays total", () => {
      // `Schema.Finite` rejects non-finite numbers before the literal's encoder
      // sees them; the encoder's own guard is for an attribute that admits them,
      // so build the unchecked number schema from its AST. The type says `Finite` only so `attribute` accepts it.
      const AnyNumber = Schema.make<typeof Schema.Finite>(SchemaAST.number);
      const Gauge = Resource("gauges", {
        attributes: { stock: attribute(AnyNumber, { filter: ["eq"] }) },
      });
      const literal = filterable(Gauge).stock.literal;
      // the message names the value as written, not as `JSON.stringify` renders
      // it ("null"), so it cannot be mistaken for a NULL literal
      expect(() => Schema.encodeUnknownSync(literal)(Number.NaN)).toThrow(
        "Expected a finite number to encode as a filter literal, got NaN",
      );
      expect(() => Schema.encodeUnknownSync(literal)(Number.POSITIVE_INFINITY)).toThrow(
        "Expected a finite number to encode as a filter literal, got Infinity",
      );
      expect(() => Schema.encodeUnknownSync(literal)(Number.NEGATIVE_INFINITY)).toThrow(
        "Expected a finite number to encode as a filter literal, got -Infinity",
      );
      // the same message reaches a tree's encoder
      expect(() => Filter.normalise(Filter.eq("stock", Number.NaN), filterable(Gauge))).toThrow(
        "Expected a finite number to encode as a filter literal, got NaN",
      );
      expect(Schema.encodeUnknownSync(literal)(1.5)).toBe("1.5");
      // any other value is refused by the attribute's own schema first, before
      // the literal's encoder sees it
      expect(() => Schema.encodeUnknownSync(literal)("1")).toThrow("Expected number");
    });

    it("refuses a NULL literal in a tree with a hint at isnull, whatever the field's literal codec", () => {
      const Nullables = Resource("nullables", {
        attributes: {
          title: attribute(Schema.String, { filter: ["eq", "in"] }),
          age: attribute(Schema.Finite, { filter: ["eq"] }),
          rating: attribute(Schema.NullOr(Schema.Finite), { filter: ["eq", "isnull"] }),
          deletedAt: attribute(Schema.NullOr(Schema.DateFromString), { filter: ["gte"] }),
          flag: attribute(Schema.Boolean, { filter: ["eq"] }),
          // an explicit codec: the hint does not depend on derivation
          code: attribute(Schema.String, { filter: ["eq"], filterLiteral: Schema.String }),
        },
        relationships: { supplier: Relationship.one(() => Supplier, { filter: ["eq"] }) },
      });
      const fields = filterable(Nullables);
      const hint = (field: string) =>
        `NULL is not a filter literal for field "${field}" (use the isnull operator)`;
      const normalise = (node: Filter.Node) => () => Filter.normalise(node, fields);
      // SAFETY: a deliberately ill-typed literal — the case under test is a tree
      // built around the types, which the runtime must still refuse.
      const NULL = null as never;
      expect(normalise(Filter.eq("title", NULL))).toThrow(hint("title"));
      expect(normalise(Filter.eq("age", NULL))).toThrow(hint("age"));
      expect(normalise(Filter.eq("rating", NULL))).toThrow(hint("rating"));
      expect(normalise(Filter.gte("deletedAt", NULL))).toThrow(hint("deletedAt"));
      expect(normalise(Filter.eq("flag", NULL))).toThrow(hint("flag"));
      expect(normalise(Filter.eq("code", NULL))).toThrow(hint("code"));
      expect(normalise(Filter.eq("supplier", NULL))).toThrow(hint("supplier"));
      // in a list, too
      expect(normalise(Filter.isIn("title", ["a", NULL]))).toThrow(hint("title"));
      // and isnull is the way to say it
      expect(normalise(Filter.isNull("rating"))).not.toThrow();
    });

    it("lets readOnlyAttribute carry filter and sort declarations, piped or as sugar", () => {
      const Stamped = Resource("stamped", {
        attributes: {
          title: Schema.String,
          createdAt: readOnlyAttribute(
            Schema.DateFromString.pipe(Filter.able(["gte", "lt"]), Sort.able()),
          ),
          updatedAt: readOnlyAttribute(Schema.DateFromString, {
            filter: ["gte", "lt"],
            sort: true,
          }),
        },
      });
      expect(filterable(Stamped).createdAt.operators).toEqual(["gte", "lt"]);
      expect(filterable(Stamped).updatedAt.operators).toEqual(["gte", "lt"]);
      expect(sortable(Stamped)).toEqual(["createdAt", "updatedAt"]);
      expectTypeOf<FilterOperators<typeof Stamped, "createdAt">>().toEqualTypeOf<"gte" | "lt">();
      expectTypeOf<FilterOperators<typeof Stamped, "updatedAt">>().toEqualTypeOf<"gte" | "lt">();
      expectTypeOf<SortableKeys<typeof Stamped>>().toEqualTypeOf<"createdAt" | "updatedAt">();
      expectTypeOf(Stamped.fields.attributes.fields.createdAt).toEqualTypeOf(
        Stamped.fields.attributes.fields.updatedAt,
      );
      // still excluded from the write projections
      expectTypeOf<keyof typeof Stamped.createInput.Type>().toEqualTypeOf<"title">();
    });
  });

  // -------------------------------------------------------------------------
  // The annotation is the single source of truth
  // -------------------------------------------------------------------------

  describe("annotation-driven declaration", () => {
    const AttributeDescriptorAnnotationId = "@thomasfosterau/effect-jsonapi/attribute";
    const annotationsOf = (schema: Schema.Top) => {
      const bag = Schema.resolveAnnotations(schema);
      return { filter: bag?.[Filter.AnnotationId], sort: bag?.[Sort.AnnotationId] };
    };

    it("makes the pipeable form, the sugar on a descriptor and the bare sugar indistinguishable", () => {
      const Piped = Resource("piped", {
        attributes: { n: Schema.Finite.pipe(Filter.able(["eq"]), Sort.able()) },
      });
      const Wrapped = Resource("wrapped", {
        attributes: { n: attribute(Schema.Finite.pipe(Filter.able(["eq"]), Sort.able())) },
      });
      const Sugar = Resource("sugar", {
        attributes: { n: attribute(Schema.Finite, { filter: ["eq"], sort: true }) },
      });
      Arr.forEach([Piped, Wrapped, Sugar], (res) => {
        expect(Object.keys(filterable(res))).toEqual(["n"]);
        expect(filterable(res).n.operators).toEqual(["eq"]);
        expect(Schema.decodeSync(filterable(res).n.literal)("2")).toBe(2);
        expect(sortable(res)).toEqual(["n"]);
      });
      // the same annotations, byte for byte
      const expected = { filter: { operators: ["eq"], literal: undefined }, sort: true };
      expect(annotationsOf(Piped.fields.attributes.fields.n)).toEqual(expected);
      expect(annotationsOf(Wrapped.fields.attributes.fields.n)).toEqual(expected);
      expect(annotationsOf(Sugar.fields.attributes.fields.n)).toEqual(expected);
      // and the same types
      expectTypeOf<FilterableKeys<typeof Piped>>().toEqualTypeOf<"n">();
      expectTypeOf<FilterableKeys<typeof Wrapped>>().toEqualTypeOf<"n">();
      expectTypeOf<FilterableKeys<typeof Sugar>>().toEqualTypeOf<"n">();
      expectTypeOf<FilterOperators<typeof Piped, "n">>().toEqualTypeOf<"eq">();
      expectTypeOf<FilterOperators<typeof Wrapped, "n">>().toEqualTypeOf<"eq">();
      expectTypeOf<FilterOperators<typeof Sugar, "n">>().toEqualTypeOf<"eq">();
      expectTypeOf<SortableKeys<typeof Piped>>().toEqualTypeOf<"n">();
      expectTypeOf<SortableKeys<typeof Wrapped>>().toEqualTypeOf<"n">();
      expectTypeOf<SortableKeys<typeof Sugar>>().toEqualTypeOf<"n">();
      expectTypeOf(filterable(Piped)).toEqualTypeOf(filterable(Sugar));
      expectTypeOf(filterable(Wrapped)).toEqualTypeOf(filterable(Sugar));
      expectTypeOf(attribute(Schema.Finite, { filter: ["eq"], sort: true })).toEqualTypeOf(
        attribute(Schema.Finite.pipe(Filter.able(["eq"]), Sort.able())),
      );
      expectTypeOf(attribute(Schema.Finite, { filter: true })).toEqualTypeOf(
        attribute(Schema.Finite.pipe(Filter.able())),
      );
    });

    it("stamps only the projection config on the descriptor; the inner schema carries the declaration", () => {
      const field = attribute(Schema.Finite, { filter: ["eq"], sort: true });
      const descriptor = Schema.resolveAnnotations(field)?.[AttributeDescriptorAnnotationId] as {
        readonly schema: Schema.Top;
      };
      expect(Object.keys(descriptor)).toEqual([
        "schema",
        "resource",
        "create",
        "update",
        "clearable",
      ]);
      expect(annotationsOf(descriptor.schema)).toEqual({
        filter: { operators: ["eq"], literal: undefined },
        sort: true,
      });
      // a descriptor without declarations stamps the schema untouched
      const plain = Schema.resolveAnnotations(attribute(Schema.Finite))?.[
        AttributeDescriptorAnnotationId
      ] as {
        readonly schema: Schema.Top;
      };
      expect(plain.schema).toBe(Schema.Finite);
    });

    it("uses an explicit literal codec in the pipeable form, as `filterLiteral` does in the sugar", () => {
      const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Point, {
          decode: SchemaGetter.transform((s: string) => {
            const [x, y] = s.split(":").map(Number);
            return { x: x, y: y };
          }),
          encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`),
        }),
      );
      const Points = Resource("points", {
        attributes: {
          origin: Point.pipe(Filter.able(["eq"], { literal: PointFromString })),
          corner: attribute(Point, { filter: ["eq"], filterLiteral: PointFromString }),
        },
      });
      expect(filterable(Points).origin.literal).toBe(PointFromString);
      expect(filterable(Points).corner.literal).toBe(PointFromString);
      expect(Schema.decodeSync(filterable(Points).origin.literal)("1:2")).toEqual({
        x: 1,
        y: 2,
      });
      expectTypeOf(filterable(Points).origin.literal.Type).toEqualTypeOf<{
        readonly x: number;
        readonly y: number;
      }>();
      expectTypeOf(filterable(Points).origin).toEqualTypeOf(filterable(Points).corner);
    });

    describe("reads the annotation through the wrappers an attribute field may carry", () => {
      const declared = Schema.Finite.pipe(Filter.able(["eq", "gte"]), Sort.able());

      it('an optionalKey wrapper — `resource: "optional"`, or a bare Schema.optionalKey', () => {
        const res = Resource("optionals", {
          attributes: {
            a: attribute(declared, { resource: "optional" }),
            b: Schema.optionalKey(declared),
          },
        });
        expect(Object.keys(filterable(res))).toEqual(["a", "b"]);
        expect(filterable(res).a.operators).toEqual(["eq", "gte"]);
        expect(filterable(res).b.operators).toEqual(["eq", "gte"]);
        expect(Schema.decodeSync(filterable(res).b.literal)("2")).toBe(2);
        expect(sortable(res)).toEqual(["a", "b"]);
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<"a" | "b">();
        expectTypeOf<FilterOperators<typeof res, "b">>().toEqualTypeOf<"eq" | "gte">();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<"a" | "b">();
        expectTypeOf(filterable(res).b.literal.Type).toEqualTypeOf<number>();
      });

      it("a Schema.NullOr union whose non-null member carries it", () => {
        const res = Resource("nullables", {
          attributes: {
            rating: Schema.NullOr(declared),
            score: attribute(Schema.NullOr(declared), { create: "optional" }),
          },
        });
        expect(Object.keys(filterable(res))).toEqual(["rating", "score"]);
        expect(filterable(res).rating.operators).toEqual(["eq", "gte"]);
        expect(Schema.decodeSync(filterable(res).rating.literal)("4.5")).toBe(4.5);
        expect(() => Schema.decodeSync(filterable(res).rating.literal)("null")).toThrow();
        expect(sortable(res)).toEqual(["rating", "score"]);
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<"rating" | "score">();
        expectTypeOf<FilterOperators<typeof res, "rating">>().toEqualTypeOf<"eq" | "gte">();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<"rating" | "score">();
        expectTypeOf(filterable(res).rating.literal.Type).toEqualTypeOf<number>();
        expectTypeOf<(typeof res.Type)["attributes"]["rating"]>().toEqualTypeOf<number | null>();
      });

      it("the descriptor's inner schema, for a descriptor stamped by hand", () => {
        const byHand = Schema.Finite.annotate({
          [AttributeDescriptorAnnotationId]: {
            schema: declared,
            create: "required",
            update: "optional",
            clearable: false,
          },
        });
        const res = Resource("by-hand", { attributes: { n: byHand } });
        expect(Object.keys(filterable(res))).toEqual(["n"]);
        expect(sortable(res)).toEqual(["n"]);
      });

      it("a Schema.suspend — at runtime; the suspension is opaque to the type level", () => {
        const res = Resource("suspended", { attributes: { n: Schema.suspend(() => declared) } });
        expect(Object.keys(filterable(res))).toEqual(["n"]);
        const entries = filterable(res) as Record<
          string,
          { readonly operators: ReadonlyArray<string> }
        >;
        expect(entries.n?.operators).toEqual(["eq", "gte"]);
        expect(sortable(res)).toEqual(["n"]);
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<never>();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<never>();
      });
    });

    describe("survival of the declaration when the schema is rebuilt after declaring", () => {
      const declared = Schema.Int.pipe(Filter.able(["eq", "gt"]), Sort.able());
      const keysOf = <Res extends { readonly type: string }>(
        res: Res & Parameters<typeof filterable>[0],
      ) => ({
        filterable: Object.keys(filterable(res)),
        sortable: [...sortable(res)],
      });

      it("`.annotate({ other })` keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        const s = declared.annotate({ title: "price" });
        expect(Schema.resolveAnnotations(s)?.title).toBe("price");
        expect(annotationsOf(s)).toEqual({
          filter: { operators: ["eq", "gt"], literal: undefined },
          sort: true,
        });
        const res = Resource("re-annotated", { attributes: { price: s } });
        expect(keysOf(res)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<never>();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<never>();
        // the other way round keeps both
        const Ok = Resource("annotated-first", {
          attributes: {
            price: Schema.Int.annotate({ title: "price" }).pipe(
              Filter.able(["eq", "gt"]),
              Sort.able(),
            ),
          },
        });
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expect(Schema.resolveAnnotations(Ok.fields.attributes.fields.price)?.title).toBe("price");
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">();
        expectTypeOf<SortableKeys<typeof Ok>>().toEqualTypeOf<"price">();
      });

      it("`Schema.brand` keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        const s = declared.pipe(Schema.brand("Cents"));
        expect(annotationsOf(s)).toEqual({
          filter: { operators: ["eq", "gt"], literal: undefined },
          sort: true,
        });
        const res = Resource("branded-after", { attributes: { price: s } });
        expect(keysOf(res)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<never>();
        // the other way round keeps both, and the literal keeps the brand
        const Cents = Schema.Int.pipe(Schema.brand("Cents"));
        const Ok = Resource("branded-first", {
          attributes: { price: Cents.pipe(Filter.able(["eq", "gt"]), Sort.able()) },
        });
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">();
        expectTypeOf(filterable(Ok).price.literal.Type).toEqualTypeOf<typeof Cents.Type>();
      });

      it("`Schema.NullOr` keeps it, at runtime and at the type level", () => {
        const res = Resource("null-after", { attributes: { price: Schema.NullOr(declared) } });
        expect(keysOf(res)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expectTypeOf<FilterOperators<typeof res, "price">>().toEqualTypeOf<"eq" | "gt">();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<"price">();
      });

      it("`.check(...)` after declaring keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        // Effect's `annotate` stamps the last check and a later `.check` appends
        // a new one, so `Schema.resolveAnnotations` no longer sees the
        // declaration — the accessors scan every check and still do.
        const s = declared.check(Schema.isGreaterThan(0));
        expect(annotationsOf(s)).toEqual({ filter: undefined, sort: undefined });
        const res = Resource("checked-after", { attributes: { price: s } });
        expect(keysOf(res)).toEqual({ filterable: ["price"], sortable: ["price"] });
        const entries = filterable(res) as Record<
          string,
          {
            readonly operators: ReadonlyArray<string>;
            readonly literal: Schema.Codec<unknown, string>;
          }
        >;
        expect(entries.price?.operators).toEqual(["eq", "gt"]);
        // the new check applies to the literal too
        expect(() => Schema.decodeSync(entries.price.literal)("-1")).toThrow();
        expectTypeOf<FilterableKeys<typeof res>>().toEqualTypeOf<never>();
        expectTypeOf<SortableKeys<typeof res>>().toEqualTypeOf<never>();
        // a second check after that still finds it, as does one before and one after
        const twice = Resource("checked-twice", {
          attributes: { price: s.check(Schema.isLessThan(1_000_000)) },
        });
        expect(keysOf(twice)).toEqual({ filterable: ["price"], sortable: ["price"] });
        // the other way round keeps both levels, and the check still applies to the literal
        const Ok = Resource("checked-first", {
          attributes: {
            price: Schema.Int.check(Schema.isGreaterThan(0)).pipe(
              Filter.able(["eq", "gt"]),
              Sort.able(),
            ),
          },
        });
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] });
        expect(() => Schema.decodeSync(filterable(Ok).price.literal)("-1")).toThrow();
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">();
      });
    });

    it("carries the declaration through Resource.attributes spreads and Resource.extend", () => {
      const Base = Resource("bases", {
        attributes: {
          n: Schema.Finite.pipe(Filter.able(["eq"]), Sort.able()),
          s: attribute(Schema.String, { filter: true }),
          plain: Schema.String,
        },
      });
      const Spread = Resource("spreads", {
        attributes: { ...attributes(Base), extra: Schema.String },
      });
      expect(Object.keys(filterable(Spread))).toEqual(["n", "s"]);
      expect(filterable(Spread).n.operators).toEqual(["eq"]);
      expect(sortable(Spread)).toEqual(["n"]);
      expectTypeOf<FilterableKeys<typeof Spread>>().toEqualTypeOf<"n" | "s">();
      expectTypeOf<FilterOperators<typeof Spread, "s">>().toEqualTypeOf<Filter.Operator>();
      expectTypeOf<SortableKeys<typeof Spread>>().toEqualTypeOf<"n">();
      const Extended = extend(Base, "extendeds", {
        attributes: { t: Schema.String.pipe(Sort.able()) },
      });
      expect(Object.keys(filterable(Extended))).toEqual(["n", "s"]);
      expect(sortable(Extended)).toEqual(["n", "t"]);
      expectTypeOf<SortableKeys<typeof Extended>>().toEqualTypeOf<"n" | "t">();
    });

    it("constrains an explicit literal codec the same way in both spellings: the schema's Type must fit it", () => {
      const Status = Schema.Literals(["a", "b"]);
      // wider than the attribute: accepted by both, and the literal Type is the codec's
      const Wide: Schema.Codec<string, string> = Schema.String;
      // narrower than the attribute: a valid value `"b"` could not be filtered on — rejected by both
      const Narrow = Schema.String.pipe(
        Schema.decodeTo(Schema.Literals(["a"]), {
          decode: SchemaGetter.transform((s: string) => s as "a"),
          encode: SchemaGetter.transform((a: "a") => a),
        }),
      );
      const res = Resource("literal-direction", {
        attributes: {
          piped: Status.pipe(Filter.able(["eq"], { literal: Wide })),
          sugared: attribute(Status, { filter: ["eq"], filterLiteral: Wide }),
          readOnly: readOnlyAttribute(Status, { filter: ["eq"], filterLiteral: Wide }),
        },
      });
      expect(filterable(res).piped.literal).toBe(Wide);
      expect(filterable(res).sugared.literal).toBe(Wide);
      expectTypeOf(filterable(res).piped.literal.Type).toEqualTypeOf<string>();
      expectTypeOf(filterable(res).sugared.literal.Type).toEqualTypeOf<string>();
      expectTypeOf(filterable(res).readOnly.literal.Type).toEqualTypeOf<string>();
      expectTypeOf(filterable(res).piped).toEqualTypeOf(filterable(res).sugared);
      // a codec narrower than the attribute, or for another type, does not fit
      // in any spelling: test/rejected-calls.types.ts
      expect(Narrow).toBeDefined();
      // without an override the literal type is still the attribute's own
      expectTypeOf(
        filterable(Resource("own", { attributes: { s: attribute(Status, { filter: true }) } })).s
          .literal.Type,
      ).toEqualTypeOf<"a" | "b">();
    });

    it("rejects a hand-stamped filter annotation whose literal is not a schema", () => {
      const bad = Schema.Finite.annotate({
        [Filter.AnnotationId]: { operators: ["eq"], literal: "nope" },
      });
      expect(() => Resource("bad-literal", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-literal"\): attribute "n" carries a malformed filter declaration/,
      );
      // a schema literal is fine
      const ok = Schema.Finite.annotate({
        [Filter.AnnotationId]: { operators: ["eq"], literal: Schema.String },
      });
      expect(filterable(Resource("ok-literal", { attributes: { n: ok } }))).toHaveProperty("n");
    });

    it("recognises the nullable union once, so a re-annotated NullOr still reads through", () => {
      // rebuilt after wrapping: the union node is new, its non-null member still carries the declaration
      const s = Schema.NullOr(Schema.Finite.pipe(Filter.able(["eq"]), Sort.able())).annotate({
        title: "rating",
      });
      const res = Resource("nullable-annotated", {
        attributes: { rating: attribute(s, { clearable: undefined }) },
      });
      expect(Object.keys(filterable(res))).toEqual(["rating"]);
      expect(sortable(res)).toEqual(["rating"]);
      // the literal is the non-null member's: never null
      expect(Schema.decodeSync(filterable(res).rating.literal)("1")).toBe(1);
      expect(() => Schema.decodeSync(filterable(res).rating.literal)("null")).toThrow();
      // and the same recognition drives the `clearable` default of the descriptor
      expect(Schema.decodeSync(res.updateInput)({ id: "1", rating: null })).toEqual({
        id: "1",
        rating: null,
      });
    });

    it("rejects a malformed hand-stamped sort annotation at Resource.make", () => {
      const bad = Schema.Finite.annotate({ [Sort.AnnotationId]: "yes" });
      expect(() => Resource("bad-sort", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-sort"\): attribute "n" carries a malformed sort declaration/,
      );
      const falsy = Schema.Finite.annotate({ [Sort.AnnotationId]: false });
      expect(() => Resource("false-sort", { attributes: { n: falsy } })).toThrow(
        /malformed sort declaration/,
      );
    });

    it("refuses the sugar on a schema already declared, rather than overriding it", () => {
      const filterDeclared = Schema.Finite.pipe(Filter.able(["eq"]));
      const sortDeclared = Schema.Finite.pipe(Sort.able());
      // a compile error at the `schema` argument (test/rejected-calls.types.ts),
      // and a definition-time throw, reached here through a widened schema
      // SAFETY: widened on purpose, to reach the definition-time check.
      expect(() => attribute(filterDeclared as Schema.Top, { filter: ["gt"] })).toThrow(
        /Resource\.attribute: the schema is already Filter\.able/,
      );
      // SAFETY: widened on purpose, to reach the definition-time check.
      expect(() => attribute(sortDeclared as Schema.Top, { sort: true })).toThrow(
        /Resource\.attribute: the schema is already Sort\.able/,
      );
      // SAFETY: widened on purpose, to reach the definition-time check.
      expect(() => readOnlyAttribute(filterDeclared as Schema.Top, { filter: true })).toThrow(
        /already Filter\.able/,
      );
      // through a NullOr wrapper too
      expect(() =>
        attribute(Schema.NullOr(filterDeclared) as Schema.Top, { filter: true }),
      ).toThrow(/already Filter\.able/);
      // the other option is still fine on a declared schema, and so is a descriptor without either
      expect(
        sortable(
          Resource("mixed", { attributes: { n: attribute(filterDeclared, { sort: true }) } }),
        ),
      ).toEqual(["n"]);
      expect(
        Object.keys(
          filterable(
            Resource("kept", { attributes: { n: attribute(sortDeclared, { filter: true }) } }),
          ),
        ),
      ).toEqual(["n"]);
      expect(
        Object.keys(
          filterable(Resource("plain", { attributes: { n: attribute(filterDeclared) } })),
        ),
      ).toEqual(["n"]);
    });
  });
});
