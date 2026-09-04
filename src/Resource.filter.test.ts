import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema, SchemaGetter } from "effect"
import * as Endpoint from "./Endpoint.js"
import * as Filter from "./Filter.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import {
  attribute,
  attributes,
  extend,
  family,
  filterable,
  make as Resource,
  readOnlyAttribute,
  sortable
} from "./Resource.js"
import type { Filterable, FilterableKeys, FilterOperators, SortableKeys } from "./Resource.js"
import * as Sort from "./Sort.js"

// ---------------------------------------------------------------------------
// Filterable and sortable declarations (#84)
// ---------------------------------------------------------------------------

const Supplier = Resource("suppliers", { attributes: { name: Schema.NonEmptyString } })

const Product = Resource("products", {
  attributes: {
    name: Schema.NonEmptyString, // plain: neither filterable nor sortable
    // the full operator core, sortable — the pipeable form
    priceCents: Schema.Int.pipe(Filter.able(), Sort.able()),
    // a subset, in the order given (duplicates dropped) — the options sugar
    stock: attribute(Schema.Number, { filter: ["gte", "eq", "lte", "eq"] }),
    // declared, but neither filterable nor sortable
    sku: attribute(Schema.String, { create: "required", update: false }),
    // sortable only
    createdAt: readOnlyAttribute(Schema.DateFromString),
    updatedAt: attribute(Schema.DateFromString.pipe(Sort.able()), { create: false, update: false })
  },
  relationships: {
    // a filterable to-one relationship (a subset) and an unfilterable one
    supplier: Relationship.one(() => Supplier, { filter: ["eq", "in"] }),
    maker: Relationship.optional(() => Supplier)
  }
})

describe("Resource.filterable / Resource.sortable", () => {
  it("declares nothing by default", () => {
    const Plain = Resource("plains", {
      attributes: { name: Schema.String, n: attribute(Schema.Number) },
      relationships: { supplier: Relationship.one(() => Supplier), other: Relationship.optional(() => Supplier) }
    })
    expect(filterable(Plain)).toEqual({})
    expect(sortable(Plain)).toEqual([])
    expectTypeOf<FilterableKeys<typeof Plain>>().toEqualTypeOf<never>()
    expectTypeOf<SortableKeys<typeof Plain>>().toEqualTypeOf<never>()
    expectTypeOf(filterable(Plain)).toEqualTypeOf<{}>()
    expectTypeOf(sortable(Plain)).toEqualTypeOf<ReadonlyArray<never>>()
  })

  it("returns the declared sets, undeclared keys absent", () => {
    const declared = filterable(Product)
    expect(Object.keys(declared)).toEqual(["priceCents", "stock", "supplier"])
    expect("name" in declared).toBe(false)
    expect("sku" in declared).toBe(false)
    expect("maker" in declared).toBe(false)
    // sortable is attributes only
    expect(sortable(Product)).toEqual(["priceCents", "updatedAt"])
  })

  it("expands `filter: true` to the full operator core and keeps a subset in order", () => {
    const declared = filterable(Product)
    expect(declared.priceCents.operators).toEqual(Filter.operators)
    expect(declared.stock.operators).toEqual(["gte", "eq", "lte"])
  })

  it("types the keys and operators as literal unions", () => {
    expectTypeOf<FilterableKeys<typeof Product>>().toEqualTypeOf<"priceCents" | "stock" | "supplier">()
    expectTypeOf<SortableKeys<typeof Product>>().toEqualTypeOf<"priceCents" | "updatedAt">()
    expectTypeOf<FilterOperators<typeof Product, "priceCents">>().toEqualTypeOf<Filter.Operator>()
    expectTypeOf<FilterOperators<typeof Product, "stock">>().toEqualTypeOf<"gte" | "eq" | "lte">()
    expectTypeOf<FilterOperators<typeof Product, "supplier">>().toEqualTypeOf<"eq" | "in">()
    const declared = filterable(Product)
    expectTypeOf(declared).toEqualTypeOf<Filterable<typeof Product>>()
    expectTypeOf(declared.stock.operators).toEqualTypeOf<ReadonlyArray<"gte" | "eq" | "lte">>()
    expectTypeOf(declared.priceCents.literal.Type).toEqualTypeOf<number>()
    expectTypeOf(declared.priceCents.literal.Encoded).toEqualTypeOf<string>()
    expectTypeOf(declared.supplier.literal.Type).toEqualTypeOf<typeof Supplier.Id.Type>()
    expectTypeOf(sortable(Product)).toEqualTypeOf<ReadonlyArray<"priceCents" | "updatedAt">>()
    // @ts-expect-error an undeclared attribute is not a filterable key
    expectTypeOf<FilterOperators<typeof Product, "name">>()
    // @ts-expect-error an undeclared relationship is not a filterable key
    expectTypeOf<FilterOperators<typeof Product, "maker">>()
  })

  it("rejects an attribute operator outside the closed core at definition time", () => {
    expect(() => attribute(Schema.String, { filter: ["eq", "like" as never] })).toThrow(
      /declares filter operator "like"; expected one of eq, ne/
    )
  })

  it("carries the declaration through Resource.extend (attributes and relationships)", () => {
    const Child = extend(Product, "gadgets", {
      attributes: { colour: attribute(Schema.String, { filter: ["eq", "in"], sort: true }) },
      relationships: { origin: Relationship.optional(() => Supplier, { filter: ["isnull"] }) }
    })
    expect(Object.keys(filterable(Child))).toEqual(["priceCents", "stock", "colour", "supplier", "origin"])
    expect(filterable(Child).colour.operators).toEqual(["eq", "in"])
    expect(filterable(Child).supplier.operators).toEqual(["eq", "in"])
    expect(filterable(Child).origin.operators).toEqual(["isnull"])
    expect(sortable(Child)).toEqual(["priceCents", "updatedAt", "colour"])
    expectTypeOf<FilterableKeys<typeof Child>>().toEqualTypeOf<
      "priceCents" | "stock" | "colour" | "supplier" | "origin"
    >()
    expectTypeOf<SortableKeys<typeof Child>>().toEqualTypeOf<"priceCents" | "updatedAt" | "colour">()
  })

  it('survives the optionalKey wrapping of `resource: "optional"`', () => {
    const R = Resource("optionals", {
      attributes: { nickname: attribute(Schema.String, { resource: "optional", filter: ["eq"], sort: true }) }
    })
    // the descriptor is readable through the optionalKey wrapper
    expect(Schema.resolveAnnotations(R.fields.attributes.fields.nickname)).toHaveProperty(
      "@thomasfosterau/effect-jsonapi/attribute"
    )
    expect(filterable(R).nickname.operators).toEqual(["eq"])
    expect(sortable(R)).toEqual(["nickname"])
    expect(Schema.decodeUnknownSync(filterable(R).nickname.literal)("x")).toBe("x")
    expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<"nickname">()
    expectTypeOf(filterable(R).nickname.literal.Type).toEqualTypeOf<string>()
  })

  it("allows `isnull` on a non-nullable attribute", () => {
    const R = Resource("nn", { attributes: { n: attribute(Schema.Number, { filter: ["isnull"] }) } })
    expect(filterable(R).n.operators).toEqual(["isnull"])
  })

  it("composes with Query.schema and Endpoint.list as the sort allow-list", () => {
    const query = Query.schema(Product, { sort: sortable(Product) })
    expect(Schema.decodeUnknownSync(query)({ sort: "-updatedAt,priceCents" })).toEqual({
      sort: [
        { field: "updatedAt", direction: "desc" },
        { field: "priceCents", direction: "asc" }
      ]
    })
    // undeclared attributes are rejected (→ 400), declared-but-unsortable ones too
    expect(() => Schema.decodeUnknownSync(query)({ sort: "name" })).toThrow()
    expect(() => Schema.decodeUnknownSync(query)({ sort: "stock" })).toThrow()
    type Decoded = typeof query.Type
    expectTypeOf<NonNullable<Decoded["sort"]>[number]["field"]>().toEqualTypeOf<"priceCents" | "updatedAt">()

    const list = Endpoint.list(Product, { sort: sortable(Product) })
    const listQuery = list.query as Schema.Codec<any, any>
    expect(Schema.decodeUnknownSync(listQuery)({ sort: "priceCents" })).toEqual({
      sort: [{ field: "priceCents", direction: "asc" }]
    })
    expect(() => Schema.decodeUnknownSync(listQuery)({ sort: "name" })).toThrow()
  })

  it("reports the base's declaration through a base-anchored family, nothing through a name-only one", () => {
    const Node = Resource("nodes", {
      attributes: { name: attribute(Schema.NonEmptyString, { filter: ["eq", "in"], sort: true }) },
      relationships: { owner: Relationship.one(() => Supplier, { filter: true }) }
    })
    const Person = extend(Node, "people", { inheritId: true })
    const Organisation = extend(Node, "organisations", { inheritId: true })
    const Anchored = family(Node, [Person, Organisation])
    expect(Object.keys(filterable(Anchored))).toEqual(["name", "owner"])
    expect(filterable(Anchored).name.operators).toEqual(["eq", "in"])
    expect(filterable(Anchored).owner.operators).toEqual(Relationship.filterOperators)
    expect(sortable(Anchored)).toEqual(["name"])
    expectTypeOf<FilterableKeys<typeof Anchored>>().toEqualTypeOf<"name" | "owner">()
    expectTypeOf<SortableKeys<typeof Anchored>>().toEqualTypeOf<"name">()

    const NameOnly = family("things", [Person, Organisation])
    expect(filterable(NameOnly)).toEqual({})
    expect(sortable(NameOnly)).toEqual([])
    expectTypeOf<FilterableKeys<typeof NameOnly>>().toEqualTypeOf<never>()
    expectTypeOf<SortableKeys<typeof NameOnly>>().toEqualTypeOf<never>()
  })

  describe("to-one relationships as filter fields", () => {
    const Person = Resource("people", { attributes: { name: Schema.NonEmptyString } })
    const Article = Resource("articles", {
      attributes: { title: Schema.NonEmptyString },
      relationships: {
        author: Relationship.one(() => Person, { filter: true }),
        editor: Relationship.optional(() => Person, { filter: ["eq", "isnull"] }),
        reviewer: Relationship.optional(() => Person),
        tags: Relationship.many(() => Person),
        comments: Relationship.paginated(() => Person)
      }
    })

    it("declares on `one` and `optional`; `true` is the five relationship operators", () => {
      const declared = filterable(Article)
      expect(Object.keys(declared)).toEqual(["author", "editor"])
      expect(declared.author.operators).toEqual(["eq", "ne", "in", "nin", "isnull"])
      expect(declared.author.operators).toEqual(Relationship.filterOperators)
      expect(declared.editor.operators).toEqual(["eq", "isnull"])
      expect(Article.relationships.author.filter).toBe(true)
      expect(Article.relationships.reviewer.filter).toBe(false)
    })

    it("types relationship keys and operators as literal unions", () => {
      expectTypeOf<FilterableKeys<typeof Article>>().toEqualTypeOf<"author" | "editor">()
      expectTypeOf<FilterOperators<typeof Article, "author">>().toEqualTypeOf<Relationship.FilterOperator>()
      expectTypeOf<FilterOperators<typeof Article, "editor">>().toEqualTypeOf<"eq" | "isnull">()
      expectTypeOf(filterable(Article).author.literal.Type).toEqualTypeOf<typeof Person.Id.Type>()
      expectTypeOf(filterable(Article).author.literal.Encoded).toEqualTypeOf<string>()
      // the relationship descriptor carries the declaration at the type level
      expectTypeOf(Article.relationships.author).toEqualTypeOf<Relationship.One<typeof Person, true>>()
      expectTypeOf(Article.relationships.reviewer).toEqualTypeOf<Relationship.Optional<typeof Person, false>>()
      // existing descriptor matches still hold with the widened default
      expectTypeOf(Article.relationships.author).toMatchTypeOf<Relationship.One<typeof Person>>()
      expectTypeOf(Article.relationships.editor).toMatchTypeOf<Relationship.ToOne<typeof Person>>()
    })

    it("uses the target's Id schema as the literal codec, resolved lazily", () => {
      const declared = filterable(Article)
      const id = Schema.decodeUnknownSync(declared.author.literal)("9")
      expect(id).toBe("9")
      expectTypeOf(id).toEqualTypeOf<typeof Person.Id.Type>()
      expect(Schema.encodeUnknownSync(declared.author.literal)(Person.Id.make("9"))).toBe("9")
      // a custom id codec on the target applies too
      const Account = Resource("accounts", {
        id: Schema.String.pipe(Schema.brand("AccountId")),
        attributes: { email: Schema.String }
      })
      const Session = Resource("sessions", {
        attributes: { token: Schema.String },
        relationships: { account: Relationship.one(() => Account, { filter: ["eq"] }) }
      })
      expectTypeOf(filterable(Session).account.literal.Type).toEqualTypeOf<typeof Account.Id.Type>()
      expect(Schema.decodeUnknownSync(filterable(Session).account.literal)("a1")).toBe("a1")
    })

    it("resolves a forward-referenced target only when the literal is used", () => {
      // `Late` is defined after `Early`, which references it; nothing is forced at `make`.
      const Early = Resource("earlies", {
        attributes: { n: Schema.Number },
        relationships: { late: Relationship.one((): typeof Late => Late, { filter: ["eq"] }) }
      })
      const Late = Resource("lates", { attributes: { m: Schema.Number } })
      expect(Schema.decodeUnknownSync(filterable(Early).late.literal)("7")).toBe("7")
    })

    it("rejects an ordering operator on a relationship at Resource.make", () => {
      expect(() =>
        Resource("bad", {
          attributes: { title: Schema.String },
          relationships: { author: Relationship.one(() => Person, { filter: ["eq", "lt" as never] }) }
        })
      ).toThrow(/Resource\.make\("bad"\): relationship "author" declares filter operator "lt"/)
    })
  })

  describe("literal codec", () => {
    const Cents = Schema.Number.pipe(Schema.brand("Cents"))
    const R = Resource("literals", {
      attributes: {
        title: attribute(Schema.NonEmptyString, { filter: true }),
        count: attribute(Schema.Number, { filter: true }),
        whole: attribute(Schema.Int, { filter: true }),
        flag: attribute(Schema.Boolean, { filter: true }),
        rating: attribute(Schema.NullOr(Schema.Number), { filter: true }),
        publishedAt: attribute(Schema.DateFromString, { filter: ["gte", "lte"] }),
        status: attribute(Schema.Literals(["draft", "published"]), { filter: ["eq", "in"] }),
        priority: attribute(Schema.NullOr(Schema.Literals([1, 2, 3])), { filter: ["eq"] }),
        price: attribute(Cents, { filter: ["gt"] })
      }
    })
    const declared = filterable(R)
    type Declared = typeof declared
    const decode = <K extends keyof Declared>(key: K) =>
      Schema.decodeUnknownSync(declared[key].literal) as (input: string) => Declared[K]["literal"]["Type"]
    const encode = <K extends keyof Declared>(key: K) =>
      Schema.encodeUnknownSync(declared[key].literal) as (value: Declared[K]["literal"]["Type"]) => string

    it("decodes strings through the attribute schema", () => {
      expect(decode("title")("Hello, world")).toBe("Hello, world")
      // the attribute's own refinement applies: NonEmptyString rejects ""
      expect(() => decode("title")("")).toThrow()
      expectTypeOf(declared.title.literal.Type).toEqualTypeOf<string>()
    })

    it("decodes numbers strictly", () => {
      expect(decode("count")("42")).toBe(42)
      expect(decode("count")("-1.5")).toBe(-1.5)
      expect(decode("count")("1e3")).toBe(1000)
      expect(decode("count")(".5")).toBe(0.5)
      expect(decode("count")("+7")).toBe(7)
      // everything `Number()` would coerce loosely is rejected
      expect(() => decode("count")("abc")).toThrow(/number filter literal/)
      expect(() => decode("count")("")).toThrow(/number filter literal/)
      expect(() => decode("count")("   ")).toThrow()
      expect(() => decode("count")(" 1")).toThrow()
      expect(() => decode("count")("0x10")).toThrow()
      expect(() => decode("count")("1_000")).toThrow()
      expect(() => decode("count")("NaN")).toThrow()
      expect(() => decode("count")("Infinity")).toThrow()
      expect(() => decode("count")("1e999")).toThrow()
      // the attribute's own refinement applies: Int rejects a fraction
      expect(decode("whole")("3")).toBe(3)
      expect(() => decode("whole")("3.5")).toThrow()
    })

    it("decodes booleans as exactly true / false", () => {
      expect(decode("flag")("true")).toBe(true)
      expect(decode("flag")("false")).toBe(false)
      expect(() => decode("flag")("tru")).toThrow(/boolean filter literal/)
      expect(() => decode("flag")("TRUE")).toThrow()
      expect(() => decode("flag")("1")).toThrow()
      expect(() => decode("flag")("")).toThrow()
    })

    it("strips NullOr: the literal is the non-null member and is never null", () => {
      expect(decode("rating")("4.5")).toBe(4.5)
      expect(() => decode("rating")("null")).toThrow()
      expect(() => decode("rating")("")).toThrow()
      expect(() => encode("rating")(null as never)).toThrow()
      expectTypeOf(declared.rating.literal.Type).toEqualTypeOf<number>()
      expect(decode("priority")("2")).toBe(2)
      expect(() => decode("priority")("4")).toThrow()
      expectTypeOf(declared.priority.literal.Type).toEqualTypeOf<1 | 2 | 3>()
    })

    it("decodes DateFromString to a Date and re-encodes via the attribute encoder", () => {
      const decoded = decode("publishedAt")("2026-01-01T00:00:00.000Z")
      expect(decoded).toBeInstanceOf(Date)
      expect(decoded.toISOString()).toBe("2026-01-01T00:00:00.000Z")
      expect(() => decode("publishedAt")("not a date")).toThrow()
      expect(encode("publishedAt")(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01T00:00:00.000Z")
      expectTypeOf(declared.publishedAt.literal.Type).toEqualTypeOf<Date>()
    })

    it("decodes a literal union against its members", () => {
      expect(decode("status")("draft")).toBe("draft")
      expect(() => decode("status")("bogus")).toThrow()
      expectTypeOf(declared.status.literal.Type).toEqualTypeOf<"draft" | "published">()
    })

    it("decodes a branded number, keeping the brand", () => {
      const value = decode("price")("1250")
      expect(value).toBe(1250)
      expectTypeOf(value).toEqualTypeOf<typeof Cents.Type>()
      expect(() => decode("price")("abc")).toThrow()
    })

    it("round-trips: encode ∘ decode is identity on canonical strings, decode ∘ encode on values", () => {
      for (const [key, input] of [
        ["title", "Hello"],
        ["count", "42"],
        ["count", "-1.5"],
        ["flag", "true"],
        ["flag", "false"],
        ["rating", "4.5"],
        ["publishedAt", "2026-01-01T00:00:00.000Z"],
        ["status", "published"],
        ["priority", "3"],
        ["price", "1250"]
      ] as const) {
        expect(encode(key)(decode(key)(input) as never)).toBe(input)
      }
      expect(decode("count")(encode("count")(1e21))).toBe(1e21)
      expect(decode("count")(encode("count")(0.1))).toBe(0.1)
      expect(decode("flag")(encode("flag")(false))).toBe(false)
      const when = new Date("2025-12-31T23:59:59.999Z")
      expect(decode("publishedAt")(encode("publishedAt")(when)).getTime()).toBe(when.getTime())
    })

    it("uses an explicit `filterLiteral` in place of the derived codec", () => {
      // an attribute whose encoded form is a struct — no derivation possible
      const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Point, {
          decode: SchemaGetter.transform((s: string) => {
            const [x, y] = s.split(":").map(Number)
            return { x: x!, y: y! }
          }),
          encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`)
        })
      )
      const WithOverride = Resource("points", {
        attributes: { origin: attribute(Point, { filter: ["eq"], filterLiteral: PointFromString }) }
      })
      const literal = filterable(WithOverride).origin.literal
      expect(literal).toBe(PointFromString)
      expect(Schema.decodeUnknownSync(literal)("1:2")).toEqual({ x: 1, y: 2 })
      expect(Schema.encodeUnknownSync(literal)({ x: 3, y: 4 })).toBe("3:4")
      expectTypeOf(literal.Type).toEqualTypeOf<{ readonly x: number; readonly y: number }>()
    })

    it("throws at Resource.make for a filterable attribute whose encoded form is not a scalar", () => {
      expect(() => Resource("bad-date", { attributes: { when: attribute(Schema.Date, { filter: true }) } })).toThrow(
        /Resource\.make\("bad-date"\): attribute "when" is declared filterable/
      )
      expect(() =>
        Resource("bad-array", { attributes: { tags: attribute(Schema.Array(Schema.String), { filter: ["eq"] }) } })
      ).toThrow(/attribute "tags"/)
      expect(() =>
        Resource("bad-struct", {
          attributes: { point: attribute(Schema.Struct({ x: Schema.Number }), { filter: ["eq"] }) }
        })
      ).toThrow(/filterLiteral/)
      expect(() =>
        Resource("bad-mixed", { attributes: { v: attribute(Schema.Literals(["a", 1]), { filter: ["eq"] }) } })
      ).toThrow(/attribute "v"/)
      // the same schemas are fine when not declared filterable
      expect(() =>
        Resource("fine", {
          attributes: { when: attribute(Schema.Date, { sort: true }), tags: Schema.Array(Schema.String) }
        })
      ).not.toThrow()
    })
  })

  describe("definition-time guards", () => {
    it("rejects an empty operator list on an attribute and on a relationship", () => {
      expect(() => attribute(Schema.String, { filter: [] })).toThrow(/declares filter: \[\]/)
      expect(() =>
        Resource("empty-rel", {
          attributes: {},
          relationships: { supplier: Relationship.one(() => Supplier, { filter: [] }) }
        })
      ).toThrow(/relationship "supplier" declares filter: \[\]/)
    })

    it("rejects `filterLiteral` without `filter`", () => {
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Schema.Number, {
          decode: SchemaGetter.transform((s: string) => Number(s)),
          encode: SchemaGetter.transform((n: number) => String(n))
        })
      )
      expect(() => attribute(Schema.Number, { filterLiteral: PointFromString })).toThrow(
        /`filterLiteral` given without `filter`/
      )
    })

    it("ignores a descriptor whose inner schema carries no declaration (older or hand-made annotations)", () => {
      const legacy = Schema.Date.annotate({
        "@thomasfosterau/effect-jsonapi/attribute": {
          schema: Schema.Date,
          create: false,
          update: false,
          clearable: false,
          // fields an older copy of the package stamped; no longer read
          filter: ["eq"],
          sort: true
        }
      })
      const Legacy = Resource("legacy", { attributes: { when: legacy } })
      expect(filterable(Legacy)).toEqual({})
      expect(sortable(Legacy)).toEqual([])
    })

    it("rejects a malformed hand-stamped filter annotation at Resource.make", () => {
      const bad = Schema.Number.annotate({ [Filter.AnnotationId]: { operators: ["like"] } })
      expect(() => Resource("bad-annotation", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-annotation"\): attribute "n" carries a malformed filter declaration/
      )
      const empty = Schema.Number.annotate({ [Filter.AnnotationId]: { operators: [] } })
      expect(() => Resource("empty-annotation", { attributes: { n: empty } })).toThrow(/malformed filter declaration/)
    })

    it("admits a template-literal attribute as a string literal", () => {
      const Coded = Resource("coded", {
        attributes: { code: attribute(Schema.TemplateLiteral(["X-", Schema.Number]), { filter: ["eq"] }) }
      })
      const literal = filterable(Coded).code.literal
      expect(Schema.decodeUnknownSync(literal)("X-12")).toBe("X-12")
      expect(() => Schema.decodeUnknownSync(literal)("Y-12")).toThrow()
    })

    it("refuses to encode a non-finite number, so decode ∘ encode stays total", () => {
      const literal = filterable(Product).stock.literal
      expect(() => Schema.encodeUnknownSync(literal)(Number.NaN)).toThrow()
      expect(() => Schema.encodeUnknownSync(literal)(Number.POSITIVE_INFINITY)).toThrow()
      expect(Schema.encodeUnknownSync(literal)(1.5)).toBe("1.5")
    })

    it("lets readOnlyAttribute carry filter and sort declarations, piped or as sugar", () => {
      const Stamped = Resource("stamped", {
        attributes: {
          title: Schema.String,
          createdAt: readOnlyAttribute(Schema.DateFromString.pipe(Filter.able(["gte", "lt"]), Sort.able())),
          updatedAt: readOnlyAttribute(Schema.DateFromString, { filter: ["gte", "lt"], sort: true })
        }
      })
      expect(filterable(Stamped).createdAt.operators).toEqual(["gte", "lt"])
      expect(filterable(Stamped).updatedAt.operators).toEqual(["gte", "lt"])
      expect(sortable(Stamped)).toEqual(["createdAt", "updatedAt"])
      expectTypeOf<FilterOperators<typeof Stamped, "createdAt">>().toEqualTypeOf<"gte" | "lt">()
      expectTypeOf<FilterOperators<typeof Stamped, "updatedAt">>().toEqualTypeOf<"gte" | "lt">()
      expectTypeOf<SortableKeys<typeof Stamped>>().toEqualTypeOf<"createdAt" | "updatedAt">()
      expectTypeOf(Stamped.fields.attributes.fields.createdAt).toEqualTypeOf(Stamped.fields.attributes.fields.updatedAt)
      // still excluded from the write projections
      expectTypeOf<keyof typeof Stamped.createInput.Type>().toEqualTypeOf<"title">()
    })
  })

  // -------------------------------------------------------------------------
  // The annotation is the single source of truth
  // -------------------------------------------------------------------------

  describe("annotation-driven declaration", () => {
    const AttributeDescriptorAnnotationId = "@thomasfosterau/effect-jsonapi/attribute"
    const annotationsOf = (schema: Schema.Top) => {
      const bag = Schema.resolveAnnotations(schema)
      return { filter: bag?.[Filter.AnnotationId], sort: bag?.[Sort.AnnotationId] }
    }

    it("makes the pipeable form, the sugar on a descriptor and the bare sugar indistinguishable", () => {
      const Piped = Resource("piped", { attributes: { n: Schema.Number.pipe(Filter.able(["eq"]), Sort.able()) } })
      const Wrapped = Resource("wrapped", {
        attributes: { n: attribute(Schema.Number.pipe(Filter.able(["eq"]), Sort.able())) }
      })
      const Sugar = Resource("sugar", { attributes: { n: attribute(Schema.Number, { filter: ["eq"], sort: true }) } })
      for (const R of [Piped, Wrapped, Sugar]) {
        expect(Object.keys(filterable(R))).toEqual(["n"])
        expect(filterable(R).n.operators).toEqual(["eq"])
        expect(Schema.decodeUnknownSync(filterable(R).n.literal)("2")).toBe(2)
        expect(sortable(R)).toEqual(["n"])
      }
      // the same annotations, byte for byte
      const expected = { filter: { operators: ["eq"], literal: undefined }, sort: true }
      expect(annotationsOf(Piped.fields.attributes.fields.n)).toEqual(expected)
      expect(annotationsOf(Wrapped.fields.attributes.fields.n)).toEqual(expected)
      expect(annotationsOf(Sugar.fields.attributes.fields.n)).toEqual(expected)
      // and the same types
      expectTypeOf<FilterableKeys<typeof Piped>>().toEqualTypeOf<"n">()
      expectTypeOf<FilterableKeys<typeof Wrapped>>().toEqualTypeOf<"n">()
      expectTypeOf<FilterableKeys<typeof Sugar>>().toEqualTypeOf<"n">()
      expectTypeOf<FilterOperators<typeof Piped, "n">>().toEqualTypeOf<"eq">()
      expectTypeOf<FilterOperators<typeof Wrapped, "n">>().toEqualTypeOf<"eq">()
      expectTypeOf<FilterOperators<typeof Sugar, "n">>().toEqualTypeOf<"eq">()
      expectTypeOf<SortableKeys<typeof Piped>>().toEqualTypeOf<"n">()
      expectTypeOf<SortableKeys<typeof Wrapped>>().toEqualTypeOf<"n">()
      expectTypeOf<SortableKeys<typeof Sugar>>().toEqualTypeOf<"n">()
      expectTypeOf(filterable(Piped)).toEqualTypeOf(filterable(Sugar))
      expectTypeOf(filterable(Wrapped)).toEqualTypeOf(filterable(Sugar))
      expectTypeOf(attribute(Schema.Number, { filter: ["eq"], sort: true })).toEqualTypeOf(
        attribute(Schema.Number.pipe(Filter.able(["eq"]), Sort.able()))
      )
      expectTypeOf(attribute(Schema.Number, { filter: true })).toEqualTypeOf(
        attribute(Schema.Number.pipe(Filter.able()))
      )
    })

    it("stamps only the projection config on the descriptor; the inner schema carries the declaration", () => {
      const field = attribute(Schema.Number, { filter: ["eq"], sort: true })
      const descriptor = Schema.resolveAnnotations(field)?.[AttributeDescriptorAnnotationId] as {
        readonly schema: Schema.Top
      }
      expect(Object.keys(descriptor)).toEqual(["schema", "resource", "create", "update", "clearable"])
      expect(annotationsOf(descriptor.schema)).toEqual({
        filter: { operators: ["eq"], literal: undefined },
        sort: true
      })
      // a descriptor without declarations stamps the schema untouched
      const plain = Schema.resolveAnnotations(attribute(Schema.Number))?.[AttributeDescriptorAnnotationId] as {
        readonly schema: Schema.Top
      }
      expect(plain.schema).toBe(Schema.Number)
    })

    it("uses an explicit literal codec in the pipeable form, as `filterLiteral` does in the sugar", () => {
      const Point = Schema.Struct({ x: Schema.Number, y: Schema.Number })
      const PointFromString = Schema.String.pipe(
        Schema.decodeTo(Point, {
          decode: SchemaGetter.transform((s: string) => {
            const [x, y] = s.split(":").map(Number)
            return { x: x!, y: y! }
          }),
          encode: SchemaGetter.transform((p: typeof Point.Type) => `${p.x}:${p.y}`)
        })
      )
      const Points = Resource("points", {
        attributes: {
          origin: Point.pipe(Filter.able(["eq"], { literal: PointFromString })),
          corner: attribute(Point, { filter: ["eq"], filterLiteral: PointFromString })
        }
      })
      expect(filterable(Points).origin.literal).toBe(PointFromString)
      expect(filterable(Points).corner.literal).toBe(PointFromString)
      expect(Schema.decodeUnknownSync(filterable(Points).origin.literal)("1:2")).toEqual({ x: 1, y: 2 })
      expectTypeOf(filterable(Points).origin.literal.Type).toEqualTypeOf<{ readonly x: number; readonly y: number }>()
      expectTypeOf(filterable(Points).origin).toEqualTypeOf(filterable(Points).corner)
    })

    describe("reads the annotation through the wrappers an attribute field may carry", () => {
      const declared = Schema.Number.pipe(Filter.able(["eq", "gte"]), Sort.able())

      it('an optionalKey wrapper — `resource: "optional"`, or a bare Schema.optionalKey', () => {
        const R = Resource("optionals", {
          attributes: { a: attribute(declared, { resource: "optional" }), b: Schema.optionalKey(declared) }
        })
        expect(Object.keys(filterable(R))).toEqual(["a", "b"])
        expect(filterable(R).a.operators).toEqual(["eq", "gte"])
        expect(filterable(R).b.operators).toEqual(["eq", "gte"])
        expect(Schema.decodeUnknownSync(filterable(R).b.literal)("2")).toBe(2)
        expect(sortable(R)).toEqual(["a", "b"])
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<"a" | "b">()
        expectTypeOf<FilterOperators<typeof R, "b">>().toEqualTypeOf<"eq" | "gte">()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<"a" | "b">()
        expectTypeOf(filterable(R).b.literal.Type).toEqualTypeOf<number>()
      })

      it("a Schema.NullOr union whose non-null member carries it", () => {
        const R = Resource("nullables", {
          attributes: {
            rating: Schema.NullOr(declared),
            score: attribute(Schema.NullOr(declared), { create: "optional" })
          }
        })
        expect(Object.keys(filterable(R))).toEqual(["rating", "score"])
        expect(filterable(R).rating.operators).toEqual(["eq", "gte"])
        expect(Schema.decodeUnknownSync(filterable(R).rating.literal)("4.5")).toBe(4.5)
        expect(() => Schema.decodeUnknownSync(filterable(R).rating.literal)("null")).toThrow()
        expect(sortable(R)).toEqual(["rating", "score"])
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<"rating" | "score">()
        expectTypeOf<FilterOperators<typeof R, "rating">>().toEqualTypeOf<"eq" | "gte">()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<"rating" | "score">()
        expectTypeOf(filterable(R).rating.literal.Type).toEqualTypeOf<number>()
        expectTypeOf<(typeof R.Type)["attributes"]["rating"]>().toEqualTypeOf<number | null>()
      })

      it("the descriptor's inner schema, for a descriptor stamped by hand", () => {
        const byHand = Schema.Number.annotate({
          [AttributeDescriptorAnnotationId]: {
            schema: declared,
            create: "required",
            update: "optional",
            clearable: false
          }
        })
        const R = Resource("by-hand", { attributes: { n: byHand } })
        expect(Object.keys(filterable(R))).toEqual(["n"])
        expect(sortable(R)).toEqual(["n"])
      })

      it("a Schema.suspend — at runtime; the suspension is opaque to the type level", () => {
        const R = Resource("suspended", { attributes: { n: Schema.suspend(() => declared) } })
        expect(Object.keys(filterable(R))).toEqual(["n"])
        const entries = filterable(R) as Record<string, { readonly operators: ReadonlyArray<string> }>
        expect(entries.n?.operators).toEqual(["eq", "gte"])
        expect(sortable(R)).toEqual(["n"])
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<never>()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<never>()
      })
    })

    describe("survival of the declaration when the schema is rebuilt after declaring", () => {
      const declared = Schema.Int.pipe(Filter.able(["eq", "gt"]), Sort.able())
      const keysOf = <R extends { readonly type: string }>(R: R & Parameters<typeof filterable>[0]) => ({
        filterable: Object.keys(filterable(R)),
        sortable: [...sortable(R)]
      })

      it("`.annotate({ other })` keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        const s = declared.annotate({ title: "price" })
        expect(Schema.resolveAnnotations(s)?.title).toBe("price")
        expect(annotationsOf(s)).toEqual({ filter: { operators: ["eq", "gt"], literal: undefined }, sort: true })
        const R = Resource("re-annotated", { attributes: { price: s } })
        expect(keysOf(R)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<never>()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<never>()
        // the other way round keeps both
        const Ok = Resource("annotated-first", {
          attributes: { price: Schema.Int.annotate({ title: "price" }).pipe(Filter.able(["eq", "gt"]), Sort.able()) }
        })
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expect(Schema.resolveAnnotations(Ok.fields.attributes.fields.price)?.title).toBe("price")
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">()
        expectTypeOf<SortableKeys<typeof Ok>>().toEqualTypeOf<"price">()
      })

      it("`Schema.brand` keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        const s = declared.pipe(Schema.brand("Cents"))
        expect(annotationsOf(s)).toEqual({ filter: { operators: ["eq", "gt"], literal: undefined }, sort: true })
        const R = Resource("branded-after", { attributes: { price: s } })
        expect(keysOf(R)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<never>()
        // the other way round keeps both, and the literal keeps the brand
        const Cents = Schema.Int.pipe(Schema.brand("Cents"))
        const Ok = Resource("branded-first", {
          attributes: { price: Cents.pipe(Filter.able(["eq", "gt"]), Sort.able()) }
        })
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">()
        expectTypeOf(filterable(Ok).price.literal.Type).toEqualTypeOf<typeof Cents.Type>()
      })

      it("`Schema.NullOr` keeps it, at runtime and at the type level", () => {
        const R = Resource("null-after", { attributes: { price: Schema.NullOr(declared) } })
        expect(keysOf(R)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expectTypeOf<FilterOperators<typeof R, "price">>().toEqualTypeOf<"eq" | "gt">()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<"price">()
      })

      it("`.check(...)` after declaring keeps it at runtime (the type-level marker is dropped: annotate last)", () => {
        // Effect's `annotate` stamps the last check and a later `.check` appends
        // a new one, so `Schema.resolveAnnotations` no longer sees the
        // declaration — the accessors scan every check and still do.
        const s = declared.check(Schema.isGreaterThan(0))
        expect(annotationsOf(s)).toEqual({ filter: undefined, sort: undefined })
        const R = Resource("checked-after", { attributes: { price: s } })
        expect(keysOf(R)).toEqual({ filterable: ["price"], sortable: ["price"] })
        const entries = filterable(R) as Record<
          string,
          { readonly operators: ReadonlyArray<string>; readonly literal: Schema.Codec<unknown, string> }
        >
        expect(entries.price?.operators).toEqual(["eq", "gt"])
        // the new check applies to the literal too
        expect(() => Schema.decodeUnknownSync(entries.price!.literal)("-1")).toThrow()
        expectTypeOf<FilterableKeys<typeof R>>().toEqualTypeOf<never>()
        expectTypeOf<SortableKeys<typeof R>>().toEqualTypeOf<never>()
        // a second check after that still finds it, as does one before and one after
        const twice = Resource("checked-twice", {
          attributes: { price: s.check(Schema.isLessThan(1_000_000)) }
        })
        expect(keysOf(twice)).toEqual({ filterable: ["price"], sortable: ["price"] })
        // the other way round keeps both levels, and the check still applies to the literal
        const Ok = Resource("checked-first", {
          attributes: { price: Schema.Int.check(Schema.isGreaterThan(0)).pipe(Filter.able(["eq", "gt"]), Sort.able()) }
        })
        expect(keysOf(Ok)).toEqual({ filterable: ["price"], sortable: ["price"] })
        expect(() => Schema.decodeUnknownSync(filterable(Ok).price.literal)("-1")).toThrow()
        expectTypeOf<FilterOperators<typeof Ok, "price">>().toEqualTypeOf<"eq" | "gt">()
      })
    })

    it("carries the declaration through Resource.attributes spreads and Resource.extend", () => {
      const Base = Resource("bases", {
        attributes: {
          n: Schema.Number.pipe(Filter.able(["eq"]), Sort.able()),
          s: attribute(Schema.String, { filter: true }),
          plain: Schema.String
        }
      })
      const Spread = Resource("spreads", { attributes: { ...attributes(Base), extra: Schema.String } })
      expect(Object.keys(filterable(Spread))).toEqual(["n", "s"])
      expect(filterable(Spread).n.operators).toEqual(["eq"])
      expect(sortable(Spread)).toEqual(["n"])
      expectTypeOf<FilterableKeys<typeof Spread>>().toEqualTypeOf<"n" | "s">()
      expectTypeOf<FilterOperators<typeof Spread, "s">>().toEqualTypeOf<Filter.Operator>()
      expectTypeOf<SortableKeys<typeof Spread>>().toEqualTypeOf<"n">()
      const Extended = extend(Base, "extendeds", { attributes: { t: Schema.String.pipe(Sort.able()) } })
      expect(Object.keys(filterable(Extended))).toEqual(["n", "s"])
      expect(sortable(Extended)).toEqual(["n", "t"])
      expectTypeOf<SortableKeys<typeof Extended>>().toEqualTypeOf<"n" | "t">()
    })

    it("constrains an explicit literal codec the same way in both spellings: the schema's Type must fit it", () => {
      const Status = Schema.Literals(["a", "b"])
      // wider than the attribute: accepted by both, and the literal Type is the codec's
      const Wide: Schema.Codec<string, string> = Schema.String
      // narrower than the attribute: a valid value `"b"` could not be filtered on — rejected by both
      const Narrow = Schema.String.pipe(
        Schema.decodeTo(Schema.Literals(["a"]), {
          decode: SchemaGetter.transform((s: string) => s as "a"),
          encode: SchemaGetter.transform((a: "a") => a)
        })
      )
      const R = Resource("literal-direction", {
        attributes: {
          piped: Status.pipe(Filter.able(["eq"], { literal: Wide })),
          sugared: attribute(Status, { filter: ["eq"], filterLiteral: Wide }),
          readOnly: readOnlyAttribute(Status, { filter: ["eq"], filterLiteral: Wide })
        }
      })
      expect(filterable(R).piped.literal).toBe(Wide)
      expect(filterable(R).sugared.literal).toBe(Wide)
      expectTypeOf(filterable(R).piped.literal.Type).toEqualTypeOf<string>()
      expectTypeOf(filterable(R).sugared.literal.Type).toEqualTypeOf<string>()
      expectTypeOf(filterable(R).readOnly.literal.Type).toEqualTypeOf<string>()
      expectTypeOf(filterable(R).piped).toEqualTypeOf(filterable(R).sugared)
      // @ts-expect-error a codec narrower than the attribute does not fit (pipeable form)
      void Status.pipe(Filter.able(["eq"], { literal: Narrow }))
      // @ts-expect-error a codec narrower than the attribute does not fit (sugar)
      void attribute(Status, { filter: ["eq"], filterLiteral: Narrow })
      // @ts-expect-error a codec narrower than the attribute does not fit (read-only sugar)
      void readOnlyAttribute(Status, { filter: ["eq"], filterLiteral: Narrow })
      // @ts-expect-error a codec for another type does not fit (sugar)
      void attribute(Schema.Number, { filter: ["eq"], filterLiteral: Wide })
      // without an override the literal type is still the attribute's own
      expectTypeOf(
        filterable(Resource("own", { attributes: { s: attribute(Status, { filter: true }) } })).s.literal.Type
      ).toEqualTypeOf<"a" | "b">()
    })

    it("rejects a hand-stamped filter annotation whose literal is not a schema", () => {
      const bad = Schema.Number.annotate({ [Filter.AnnotationId]: { operators: ["eq"], literal: "nope" } })
      expect(() => Resource("bad-literal", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-literal"\): attribute "n" carries a malformed filter declaration/
      )
      // a schema literal is fine
      const ok = Schema.Number.annotate({ [Filter.AnnotationId]: { operators: ["eq"], literal: Schema.String } })
      expect(filterable(Resource("ok-literal", { attributes: { n: ok } }))).toHaveProperty("n")
    })

    it("recognises the nullable union once, so a re-annotated NullOr still reads through", () => {
      // rebuilt after wrapping: the union node is new, its non-null member still carries the declaration
      const s = Schema.NullOr(Schema.Number.pipe(Filter.able(["eq"]), Sort.able())).annotate({ title: "rating" })
      const R = Resource("nullable-annotated", { attributes: { rating: attribute(s, { clearable: undefined }) } })
      expect(Object.keys(filterable(R))).toEqual(["rating"])
      expect(sortable(R)).toEqual(["rating"])
      // the literal is the non-null member's: never null
      expect(Schema.decodeUnknownSync(filterable(R).rating.literal)("1")).toBe(1)
      expect(() => Schema.decodeUnknownSync(filterable(R).rating.literal)("null")).toThrow()
      // and the same recognition drives the `clearable` default of the descriptor
      expect(Schema.decodeUnknownSync(R.updateInput)({ id: "1", rating: null })).toEqual({ id: "1", rating: null })
    })

    it("rejects a malformed hand-stamped sort annotation at Resource.make", () => {
      const bad = Schema.Number.annotate({ [Sort.AnnotationId]: "yes" })
      expect(() => Resource("bad-sort", { attributes: { n: bad } })).toThrow(
        /Resource\.make\("bad-sort"\): attribute "n" carries a malformed sort declaration/
      )
      const falsy = Schema.Number.annotate({ [Sort.AnnotationId]: false })
      expect(() => Resource("false-sort", { attributes: { n: falsy } })).toThrow(/malformed sort declaration/)
    })

    it("refuses the sugar on a schema already declared, rather than overriding it", () => {
      const filterDeclared = Schema.Number.pipe(Filter.able(["eq"]))
      const sortDeclared = Schema.Number.pipe(Sort.able())
      // a compile error at the `schema` argument, and a definition-time throw
      // @ts-expect-error a schema already Filter.able cannot take the `filter` sugar
      expect(() => attribute(filterDeclared, { filter: ["gt"] })).toThrow(
        /Resource\.attribute: the schema is already Filter\.able/
      )
      // @ts-expect-error a schema already Sort.able cannot take the `sort` sugar
      expect(() => attribute(sortDeclared, { sort: true })).toThrow(
        /Resource\.attribute: the schema is already Sort\.able/
      )
      // @ts-expect-error nor can readOnlyAttribute
      expect(() => readOnlyAttribute(filterDeclared, { filter: true })).toThrow(/already Filter\.able/)
      // through a NullOr wrapper too
      expect(() => attribute(Schema.NullOr(filterDeclared) as Schema.Top, { filter: true })).toThrow(
        /already Filter\.able/
      )
      // the other option is still fine on a declared schema, and so is a descriptor without either
      expect(sortable(Resource("mixed", { attributes: { n: attribute(filterDeclared, { sort: true }) } }))).toEqual([
        "n"
      ])
      expect(
        Object.keys(filterable(Resource("kept", { attributes: { n: attribute(sortDeclared, { filter: true }) } })))
      ).toEqual(["n"])
      expect(Object.keys(filterable(Resource("plain", { attributes: { n: attribute(filterDeclared) } })))).toEqual([
        "n"
      ])
    })
  })
})
