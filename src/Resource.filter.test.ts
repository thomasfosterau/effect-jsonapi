import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema, SchemaGetter } from "effect"
import * as Endpoint from "./Endpoint.js"
import * as Filter from "./Filter.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import { attribute, extend, family, filterable, make as Resource, readOnlyAttribute, sortable } from "./Resource.js"
import type { Filterable, FilterableKeys, FilterOperators, SortableKeys } from "./Resource.js"

// ---------------------------------------------------------------------------
// Filterable and sortable declarations (#84)
// ---------------------------------------------------------------------------

const Supplier = Resource("suppliers", { attributes: { name: Schema.NonEmptyString } })

const Product = Resource("products", {
  attributes: {
    name: Schema.NonEmptyString, // plain: neither filterable nor sortable
    // the full operator core, sortable
    priceCents: attribute(Schema.Int, { filter: true, sort: true }),
    // a subset, in the order given (duplicates dropped)
    stock: attribute(Schema.Number, { filter: ["gte", "eq", "lte", "eq"] }),
    // declared, but neither filterable nor sortable
    sku: attribute(Schema.String, { create: "required", update: false }),
    // sortable only
    createdAt: readOnlyAttribute(Schema.DateFromString),
    updatedAt: attribute(Schema.DateFromString, { create: false, update: false, sort: true })
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

    it("ignores a descriptor stamped without the filter/sort fields (older or hand-made annotations)", () => {
      const legacy = Schema.Date.annotate({
        "@thomasfosterau/effect-jsonapi/attribute": {
          schema: Schema.Date,
          create: false,
          update: false,
          clearable: false
        }
      })
      const Legacy = Resource("legacy", { attributes: { when: legacy } })
      expect(filterable(Legacy)).toEqual({})
      expect(sortable(Legacy)).toEqual([])
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

    it("lets readOnlyAttribute carry filter and sort declarations", () => {
      const Stamped = Resource("stamped", {
        attributes: {
          title: Schema.String,
          createdAt: readOnlyAttribute(Schema.DateFromString, { filter: ["gte", "lt"], sort: true })
        }
      })
      expect(filterable(Stamped).createdAt.operators).toEqual(["gte", "lt"])
      expect(sortable(Stamped)).toEqual(["createdAt"])
      expectTypeOf<FilterOperators<typeof Stamped, "createdAt">>().toEqualTypeOf<"gte" | "lt">()
      expectTypeOf<SortableKeys<typeof Stamped>>().toEqualTypeOf<"createdAt">()
      // still excluded from the write projections
      expectTypeOf<keyof typeof Stamped.createInput.Type>().toEqualTypeOf<"title">()
    })
  })
})
