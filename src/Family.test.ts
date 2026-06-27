import { describe, expect, expectTypeOf, it } from "vitest"
import { Schema } from "effect"
import * as Endpoint from "./Endpoint.js"
import * as Group from "./Group.js"
import * as Relationship from "./Relationship.js"
import {
  type Any,
  attributeKeys,
  directTargets,
  extend,
  family,
  includePaths,
  isFamily,
  make as Resource
} from "./Resource.js"

// ---------------------------------------------------------------------------
// Fixtures: a base "Node" with a shared relationship, and two subtypes whose
// ids are subtypes of the base id (inheritId).
// ---------------------------------------------------------------------------

const Tag = Resource("tags", { attributes: { label: Schema.NonEmptyString } })

const Node = Resource("nodes", {
  attributes: { name: Schema.NonEmptyString },
  relationships: { tags: Relationship.many(() => Tag) }
})

const Person = extend(Node, "people", { inheritId: true, attributes: { firstName: Schema.String } })
const Organisation = extend(Node, "organisations", { inheritId: true, attributes: { legalName: Schema.String } })

// The base-anchored family — the supertype over the two subtypes.
const AnyNode = family(Node, [Person, Organisation])

const personWire = { type: "people", id: "1", attributes: { name: "n", firstName: "Dan" } }
const orgWire = { type: "organisations", id: "2", attributes: { name: "o", legalName: "ACME" } }

describe("Resource.family (base form)", () => {
  it("is the discriminated member union as primary data", () => {
    expect(Schema.decodeUnknownSync(AnyNode)(personWire).type).toBe("people")
    expect(Schema.decodeUnknownSync(AnyNode)(orgWire).type).toBe("organisations")
    // the family name is not a member type
    expect(() => Schema.decodeUnknownSync(AnyNode)({ type: "nodes", id: "3", attributes: { name: "x" } })).toThrow()
    expectTypeOf<typeof AnyNode.Type>().toEqualTypeOf<typeof Person.Type | typeof Organisation.Type>()
  })

  it("structurally satisfies Resource.Any (the cornerstone — no cast)", () => {
    const asAny: Any = AnyNode
    expect(asAny.type).toBe("nodes")
  })

  it("exposes the member array and the family name", () => {
    expect(AnyNode.type).toBe("nodes")
    expect(AnyNode.members).toEqual([Person, Organisation])
    expectTypeOf(AnyNode.members).toEqualTypeOf<readonly [typeof Person, typeof Organisation]>()
  })

  it("document() decodes any member as primary data", () => {
    const doc = AnyNode.document()
    expect(Schema.decodeUnknownSync(doc)({ data: personWire }).data.type).toBe("people")
    expect(Schema.decodeUnknownSync(doc)({ data: orgWire }).data.type).toBe("organisations")
  })

  it("collection() accepts a mix of members", () => {
    const decoded = Schema.decodeUnknownSync(AnyNode.collection())({ data: [personWire, orgWire] })
    expect(decoded.data.map((d) => d.type)).toEqual(["people", "organisations"])
  })

  it("the shared Id anchors any member id (base form)", () => {
    expectTypeOf<typeof AnyNode.Id>().toEqualTypeOf<typeof Node.Id>()
    const personId = Person.Id.make("1")
    const asNodeId: typeof Node.Id.Type = personId // person id ⊂ node id (inheritId)
    expect(asNodeId).toBe("1")
  })
})

describe("family as a relationship target", () => {
  const Edge = Resource("edges", {
    attributes: { weight: Schema.Number },
    relationships: { to: Relationship.one(() => AnyNode) }
  })

  it("linkage decodes for any member, and rejects the family name", () => {
    const toPerson = Schema.decodeUnknownSync(Edge)({
      type: "edges",
      id: "1",
      attributes: { weight: 1 },
      relationships: { to: { data: { type: "people", id: "9" } } }
    })
    expect(toPerson.relationships?.to.data.type).toBe("people")

    const toOrg = Schema.decodeUnknownSync(Edge)({
      type: "edges",
      id: "1",
      attributes: { weight: 1 },
      relationships: { to: { data: { type: "organisations", id: "7" } } }
    })
    expect(toOrg.relationships?.to.data.type).toBe("organisations")

    // the family NAME ("nodes") is not a member linkage type
    expect(() =>
      Schema.decodeUnknownSync(Edge)({
        type: "edges",
        id: "1",
        attributes: { weight: 1 },
        relationships: { to: { data: { type: "nodes", id: "9" } } }
      })
    ).toThrow()
  })

  it("types the linkage as the union of member identifier types", () => {
    type ToData = NonNullable<NonNullable<(typeof Edge.Type)["relationships"]>["to"]["data"]>
    expectTypeOf<ToData["type"]>().toEqualTypeOf<"people" | "organisations">()
    // @ts-expect-error the family name is not a member linkage type
    const bad: ToData = { type: "nodes", id: "1" }
    expect(bad).toBeDefined()
  })

  it("works as optional / many / paginated targets", () => {
    const Graph = Resource("graphs", {
      attributes: { label: Schema.String },
      relationships: {
        root: Relationship.optional(() => AnyNode),
        nodes: Relationship.many(() => AnyNode),
        archive: Relationship.paginated(() => AnyNode)
      }
    })
    const decoded = Schema.decodeUnknownSync(Graph)({
      type: "graphs",
      id: "1",
      attributes: { label: "g" },
      relationships: {
        root: { data: null },
        nodes: {
          data: [
            { type: "people", id: "1" },
            { type: "organisations", id: "2" }
          ]
        },
        archive: { links: { related: "/graphs/1/archive" } }
      }
    })
    expect(decoded.relationships?.root.data).toBeNull()
    expect(decoded.relationships?.nodes.data.map((d) => d.type)).toEqual(["people", "organisations"])
    expect(decoded.relationships?.archive.links.related).toBe("/graphs/1/archive")
  })

  it("include paths traverse through the family's shared relationships", () => {
    expect(includePaths(Edge)).toContain("to")
    expect(includePaths(Edge)).toContain("to.tags") // tags is shared via the base Node
    expect(directTargets(Edge).map((t) => t.type)).toContain("nodes") // the family is a direct target
  })

  it("compound included admits a concrete member (nested-union flattening)", () => {
    const doc = Edge.document()
    const decoded = Schema.decodeUnknownSync(doc)({
      data: {
        type: "edges",
        id: "1",
        attributes: { weight: 1 },
        relationships: { to: { data: { type: "people", id: "9" } } }
      },
      included: [{ type: "people", id: "9", attributes: { name: "n", firstName: "Dan" } }]
    })
    expect(decoded.included).toHaveLength(1)
    // a resource outside the family is rejected
    expect(() =>
      Schema.decodeUnknownSync(doc)({
        data: { type: "edges", id: "1", attributes: { weight: 1 } },
        included: [{ type: "tags", id: "1", attributes: { label: "x" } }]
      })
    ).toThrow()
  })
})

describe("Resource.family (no-base form)", () => {
  const Article = Resource("articles", { attributes: { title: Schema.NonEmptyString } })
  const Photo = Resource("photos", { attributes: { url: Schema.NonEmptyString } })
  const Media = family("media", [Article, Photo])

  it("decodes members and carries the caller-provided family name", () => {
    expect(Media.type).toBe("media")
    expect(Schema.decodeUnknownSync(Media)({ type: "articles", id: "1", attributes: { title: "t" } }).type).toBe(
      "articles"
    )
    expectTypeOf<typeof Media.Type>().toEqualTypeOf<typeof Article.Type | typeof Photo.Type>()
  })

  it("is usable as a relationship target without a base", () => {
    const Ref = Resource("refs", {
      attributes: { slot: Schema.String },
      relationships: { item: Relationship.one(() => Media) }
    })
    const decoded = Schema.decodeUnknownSync(Ref)({
      type: "refs",
      id: "1",
      attributes: { slot: "a" },
      relationships: { item: { data: { type: "photos", id: "2" } } }
    })
    expect(decoded.relationships?.item.data.type).toBe("photos")
  })

  it("attributeKeys is the by-key intersection of the members' attributes", () => {
    // Article {title}, Photo {url} share no attribute keys.
    expect(attributeKeys(Media)).toEqual([])
  })
})

describe("isFamily", () => {
  it("distinguishes a family from a resource and a plain union", () => {
    expect(isFamily(AnyNode)).toBe(true)
    expect(isFamily(Person)).toBe(false)
    expect(isFamily(Schema.Union([Person, Organisation]))).toBe(false)
    expect(isFamily({})).toBe(false)
  })
})

describe("family endpoints", () => {
  const fetchNode = Endpoint.polymorphic(AnyNode, { include: true })

  it("polymorphic: GET /<family>/:id with the JSON:API middlewares", () => {
    expect(fetchNode.name).toBe("get")
    expect(fetchNode.method).toBe("GET")
    expect(fetchNode.path).toBe("/nodes/:id")
    const middlewareIds = [...fetchNode.middlewares].map((m) => m.key)
    expect(middlewareIds).toContain("effect-jsonapi/ContentNegotiation")
    expect(middlewareIds).toContain("effect-jsonapi/SchemaErrors")
  })

  it("polymorphic success document data is the member union", () => {
    const successSchema = [...fetchNode.success][0]!
    const decoded = Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
      data: personWire
    }) as { readonly data: { readonly type: string } }
    expect(decoded.data.type).toBe("people")
    expect(() =>
      Schema.decodeUnknownSync(successSchema as Schema.Codec<unknown, unknown>)({
        data: { type: "tags", id: "1", attributes: { label: "x" } }
      })
    ).toThrow()
  })

  it("a family hosts a Group and feeds Endpoint.collection via .members", () => {
    const listNodes = Endpoint.collection(AnyNode.members, { name: "list", path: "/nodes" })
    const group = Group.make(AnyNode, fetchNode, listNodes)
    expect(group.identifier).toBe("nodes") // Group.make read the family name
  })
})
