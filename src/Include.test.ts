import { describe, expect, it } from "vite-plus/test"
import { Effect, Schema } from "effect"
import * as Endpoint from "./Endpoint.js"
import * as Handlers from "./Handlers.js"
import * as Include from "./Include.js"
import * as Query from "./Query.js"
import * as Relationship from "./Relationship.js"
import * as Resource from "./Resource.js"

const Company = Resource.make("companies", {
  attributes: { name: Schema.NonEmptyString }
})

const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString },
  relationships: { company: Relationship.one(() => Company) }
})

const Tag = Resource.make("tags", {
  attributes: { label: Schema.NonEmptyString }
})

const Revision = Resource.make("revisions", {
  attributes: { editedAt: Schema.String }
})

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) }
})

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
    tags: Relationship.many(() => Tag),
    revisions: Relationship.paginated(() => Revision)
  }
})

// ---------------------------------------------------------------------------
// paths — the whitelist
// ---------------------------------------------------------------------------

describe("paths", () => {
  it("spells every depth as its own entry, in walk order", () => {
    expect(
      Include.paths({
        author: Person,
        comments: Include.nested(Comment, { author: Person })
      })
    ).toEqual(["author", "comments", "comments.author"])
  })

  it("nesting only ever adds paths — the bare key keeps meaning what it did", () => {
    const flat = Include.paths({ comments: Comment })
    const deep = Include.paths({ comments: Include.nested(Comment, { author: Person }) })
    expect(flat).toEqual(["comments"])
    // Every path the flat declaration legalised is still legal.
    expect(deep.slice(0, flat.length)).toEqual(flat)
    expect(deep).toEqual(["comments", "comments.author"])
  })

  it("emits a parent before everything below it, so every prefix precedes its paths", () => {
    const declared = Include.paths({
      comments: Include.nested(Comment, {
        author: Include.nested(Person, { company: Company })
      })
    })
    expect(declared).toEqual(["comments", "comments.author", "comments.author.company"])
    const order: ReadonlyArray<string> = declared
    for (const path of order) {
      const segments = path.split(".")
      for (let n = 1; n < segments.length; n++) {
        expect(order.indexOf(segments.slice(0, n).join("."))).toBeLessThan(order.indexOf(path))
      }
    }
  })
})

// ---------------------------------------------------------------------------
// included — the union
// ---------------------------------------------------------------------------

describe("included", () => {
  it("carries every depth, not just the leaves", () => {
    const union = Include.included({ comments: Include.nested(Comment, { author: Person }) })
    // A walk that hoists a Comment *and* the Person behind it needs both arms,
    // or the deeper one is stripped on encode.
    expect(union.members).toEqual([Comment, Person])
  })

  it("dedupes by schema identity: two keys at one resource are one member", () => {
    const union = Include.included({
      author: Person,
      comments: Include.nested(Comment, { author: Person })
    })
    expect(union.members).toEqual([Person, Comment])
  })

  it("keeps two distinct resources that happen to share a shape apart", () => {
    const Left = Resource.make("lefts", { attributes: { name: Schema.NonEmptyString } })
    const Right = Resource.make("rights", { attributes: { name: Schema.NonEmptyString } })
    const Owner = Resource.make("owners", {
      attributes: { name: Schema.NonEmptyString },
      relationships: {
        left: Relationship.one(() => Left),
        right: Relationship.one(() => Right)
      }
    })
    const surface = Include.make(Owner, { left: Left, right: Right })
    expect(surface.included.members).toEqual([Left, Right])
  })

  it("produces one flat union, never a union of unions", () => {
    const union = Include.included({
      comments: Include.nested(Comment, {
        author: Include.nested(Person, { company: Company })
      })
    })
    expect(union.members).toEqual([Comment, Person, Company])
    for (const member of union.members) {
      expect(typeof (member as { readonly type?: unknown }).type).toBe("string")
    }
  })
})

// ---------------------------------------------------------------------------
// make — the surface
// ---------------------------------------------------------------------------

describe("make", () => {
  const surface = Include.make(Article, {
    author: Person,
    comments: Include.nested(Comment, { author: Person })
  })

  it("projects the whitelist, the union and the path→target map from one declaration", () => {
    expect(surface.paths).toEqual(["author", "comments", "comments.author"])
    expect(surface.included.members).toEqual([Person, Comment])
    expect(surface.resource).toBe(Article)
    expect(surface.spec).toBeTypeOf("object")
  })

  it("maps each accepted path to the resource it resolves to (what a resolver loads)", () => {
    expect(surface.targets.get("author")).toBe(Person)
    expect(surface.targets.get("comments")).toBe(Comment)
    expect(surface.targets.get("comments.author")).toBe(Person)
    // Every prefix of an accepted path is itself accepted, so a level-by-level
    // walk can always look up the hop it is about to load.
    for (const path of surface.paths) {
      const segments = path.split(".")
      for (let n = 1; n <= segments.length; n++) {
        expect(surface.targets.has(segments.slice(0, n).join("."))).toBe(true)
      }
    }
  })

  it("matches the whole dotted path, never the head segment", () => {
    expect(surface.has("comments")).toBe(true)
    expect(surface.has("comments.author")).toBe(true)
    // `comments` being includable must not admit any deep path below it.
    expect(surface.has("comments.editor")).toBe(false)
    expect(surface.has("author.company")).toBe(false)
  })

  it("is a surface, and `Query.IncludeOptions` is not", () => {
    expect(Include.isSurface(surface)).toBe(true)
    expect(Include.isSurface({ paths: ["author"] })).toBe(false)
    expect(Include.isSurface(Article)).toBe(false)
    expect(Include.isBranch(Include.nested(Comment, { author: Person }))).toBe(true)
    expect(Include.isBranch(Person)).toBe(false)
  })

  it("rejects a key the resource has no relationship for", () => {
    expect(() => Include.make(Article, { editor: Person } as never)).toThrow(
      /resource "articles" declares no relationship "editor"/
    )
  })

  it("rejects a paginated relationship: it carries no inline linkage", () => {
    expect(() => Include.make(Article, { revisions: Revision } as never)).toThrow(/is paginated/)
  })

  it("rejects a key declared against the wrong target", () => {
    expect(() => Include.make(Article, { author: Tag } as never)).toThrow(
      /targets "people", but the surface declares "tags"/
    )
  })

  it("checks nested hops against their own target, not the root", () => {
    expect(() => Include.make(Article, { comments: Include.nested(Comment, { company: Company } as never) })).toThrow(
      /"comments.company" — resource "comments" declares no relationship "company"/
    )
  })

  it("rejects an empty declaration rather than advertising an empty whitelist", () => {
    expect(() => Include.make(Article, {})).toThrow(/declares no paths/)
  })
})

// ---------------------------------------------------------------------------
// Depth
// ---------------------------------------------------------------------------

describe("depth", () => {
  // A chain `l0 → l1 → … → l7`, declared leaf-first so each hop can reference
  // the next. Seven hops is one past `MAX_DEPTH`.
  const l7 = Resource.make("l7", { attributes: { name: Schema.String } })
  const l6 = Resource.make("l6", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l7) }
  })
  const l5 = Resource.make("l5", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l6) }
  })
  const l4 = Resource.make("l4", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l5) }
  })
  const l3 = Resource.make("l3", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l4) }
  })
  const l2 = Resource.make("l2", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l3) }
  })
  const l1 = Resource.make("l1", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l2) }
  })
  const l0 = Resource.make("l0", {
    attributes: { name: Schema.String },
    relationships: { next: Relationship.one(() => l1) }
  })

  it("accepts a declaration exactly `MAX_DEPTH` hops deep", () => {
    const surface = Include.make(l0, {
      next: Include.nested(l1, {
        next: Include.nested(l2, {
          next: Include.nested(l3, {
            next: Include.nested(l4, {
              next: Include.nested(l5, { next: l6 })
            })
          })
        })
      })
    })
    expect(surface.paths).toHaveLength(Include.MAX_DEPTH)
    expect(surface.paths[Include.MAX_DEPTH - 1]).toBe("next.next.next.next.next.next")
  })

  it("throws on the hop past it, rather than quietly advertising fewer paths than declared", () => {
    // The type-level derivation truncates past `MAX_DEPTH`; if the runtime
    // truncated too, the whitelist would silently disagree with the
    // declaration. It fails loudly at construction instead.
    expect(() =>
      Include.make(l0, {
        next: Include.nested(l1, {
          next: Include.nested(l2, {
            next: Include.nested(l3, {
              next: Include.nested(l4, {
                next: Include.nested(l5, {
                  next: Include.nested(l6, { next: l7 })
                })
              })
            })
          })
        })
      })
    ).toThrow(/is 7 hops deep, past the 6-hop maximum/)
  })
})

// ---------------------------------------------------------------------------
// The advertised parameter
// ---------------------------------------------------------------------------

describe("the advertised parameter", () => {
  const surface = Include.make(Article, {
    author: Person,
    comments: Include.nested(Comment, { author: Person })
  })

  it("legalises exactly the declared paths", () => {
    const decode = Schema.decodeUnknownSync(Query.Include(Article, surface))
    expect(decode("author,comments.author")).toEqual(["author", "comments.author"])
    expect(decode("comments")).toEqual(["comments"])
  })

  it("rejects a deep path whose head segment is legal", () => {
    const decode = Schema.decodeUnknownSync(Query.Include(Article, surface))
    // `comments` is includable; `comments.editor` is not declared, and a
    // whitelist that matched head segments would wrongly admit it.
    expect(() => decode("comments.editor")).toThrow()
    expect(() => decode("author.company")).toThrow()
  })

  it("rejects a path the graph has but the surface doesn't declare", () => {
    const decode = Schema.decodeUnknownSync(Query.Include(Article, surface))
    // `tags` is a perfectly good relationship — it is simply not served here.
    expect(() => decode("tags")).toThrow()
  })

  it("is absent from a query that declares no include surface", () => {
    const query = Query.schema(Article, { include: false })
    expect(Object.keys((query.from as { readonly fields: object }).fields)).not.toContain("include")
  })

  it("decodes through a whole query schema", () => {
    const query = Query.schema(Article, { include: surface, fields: true })
    expect(Schema.decodeUnknownSync(query)({ include: "comments.author" })).toEqual({
      include: ["comments.author"]
    })
    expect(() => Schema.decodeUnknownSync(query)({ include: "comments.editor" })).toThrow()
  })

  it("leaves `include: true` and `Query.IncludeOptions` behaviour untouched", () => {
    const graph = Schema.decodeUnknownSync(Query.Include(Article))
    expect(graph("comments.author")).toEqual(["comments.author"])
    expect(graph("tags")).toEqual(["tags"])
    const constrained = Schema.decodeUnknownSync(Query.Include(Article, { paths: ["author"] }))
    expect(constrained("author")).toEqual(["author"])
    expect(() => constrained("tags")).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The `included` union on the endpoints' documents
// ---------------------------------------------------------------------------

describe("endpoint documents", () => {
  const surface = Include.make(Article, {
    comments: Include.nested(Comment, { author: Person })
  })

  const successOf = (endpoint: { readonly success: Iterable<unknown> }) =>
    Schema.decodeUnknownSync([...endpoint.success][0]! as Schema.Codec<any, any>)

  const article = { type: "articles", id: "1", attributes: { title: "Hello" } }
  const comment = { type: "comments", id: "c1", attributes: { body: "Nice" } }
  const person = { type: "people", id: "p1", attributes: { firstName: "Ada" } }
  const tag = { type: "tags", id: "t1", attributes: { label: "effect" } }

  it("admits exactly the resources the declaration can hoist — every depth", () => {
    const decode = successOf(Endpoint.get(Article, { include: surface }))
    // `comments.author` hoists a Comment *and* the Person behind it: both arms
    // must be present, or the deeper one is stripped on encode.
    const decoded = decode({ data: article, included: [comment, person] }) as {
      readonly included: ReadonlyArray<{ readonly type: string }>
    }
    expect(decoded.included.map((r) => r.type)).toEqual(["comments", "people"])
  })

  it("refuses a resource the declaration cannot hoist, though the graph can", () => {
    const decode = successOf(Endpoint.get(Article, { include: surface }))
    // `tags` is a relationship of Article, and `include: true` would admit it;
    // this surface does not declare it, so the document does not admit it
    // either — the whitelist and the union say the same thing.
    expect(() => decode({ data: article, included: [tag] })).toThrow()
  })

  it("gives `list` the same union, so `get` and `list` cannot disagree", () => {
    const decode = successOf(Endpoint.list(Article, { include: surface }))
    const decoded = decode({ data: [article], included: [comment, person] }) as {
      readonly included: ReadonlyArray<{ readonly type: string }>
    }
    expect(decoded.included.map((r) => r.type)).toEqual(["comments", "people"])
    expect(() => decode({ data: [article], included: [tag] })).toThrow()
  })

  it("falls back to the relationship graph when `include` is a boolean", () => {
    const decode = successOf(Endpoint.get(Article, { include: true }))
    const decoded = decode({ data: article, included: [tag] }) as {
      readonly included: ReadonlyArray<{ readonly type: string }>
    }
    expect(decoded.included.map((r) => r.type)).toEqual(["tags"])
  })

  it("falls back to the relationship graph for `Query.IncludeOptions`", () => {
    // An allow-list constrains the advertised paths but declares no union, so
    // the document keeps the graph's default.
    const decode = successOf(Endpoint.get(Article, { include: { paths: ["author"] } }))
    expect(() => decode({ data: article, included: [tag] })).not.toThrow()
  })

  it("derives a `related` endpoint's union from a surface over its target", () => {
    const commentSurface = Include.make(Comment, {
      author: Include.nested(Person, { company: Company })
    })
    const decode = successOf(Endpoint.related(Article, "comments", { include: commentSurface }))
    const company = { type: "companies", id: "co1", attributes: { name: "Acme" } }
    const decoded = decode({ data: [comment], included: [person, company] }) as {
      readonly included: ReadonlyArray<{ readonly type: string }>
    }
    expect(decoded.included.map((r) => r.type)).toEqual(["people", "companies"])
  })

  it("leaves a `related` endpoint without a surface on its target's graph", () => {
    const decode = successOf(Endpoint.related(Article, "comments", { include: true }))
    // Comment's own graph reaches Person, but not Company.
    expect(() => decode({ data: [comment], included: [person] })).not.toThrow()
    const company = { type: "companies", id: "co1", attributes: { name: "Acme" } }
    expect(() => decode({ data: [comment], included: [company] })).toThrow()
  })
})

// ---------------------------------------------------------------------------
// The declaration drives the runtime walk too (#106 / #107)
// ---------------------------------------------------------------------------

describe("feeding the resolver", () => {
  const surface = Include.make(Article, {
    author: Person,
    comments: Include.nested(Comment, { author: Person })
  })

  // articles:1 ──author────▶ people:9
  //            ──comments──▶ comments:5 ──author──▶ people:7
  const article: Handlers.ResourceValue = {
    type: "articles",
    id: "1",
    relationships: {
      author: { data: { type: "people", id: "9" } },
      comments: { data: [{ type: "comments", id: "5" }] }
    }
  }
  const comment5: Handlers.ResourceValue = {
    type: "comments",
    id: "5",
    relationships: { author: { data: { type: "people", id: "7" } } }
  }
  const person = (id: string): Handlers.ResourceValue => ({ type: "people", id })

  const rows = new Map<string, Handlers.ResourceValue>(
    [article, comment5, person("9"), person("7")].map((row) => [`${row.type}:${row.id}`, row])
  )
  const loader =
    (type: string): Handlers.IncludeTarget =>
    (idList) =>
      Effect.sync(() =>
        idList.flatMap((id) => {
          const row = rows.get(`${type}:${id}`)
          return row === undefined ? [] : [row]
        })
      )
  const targets = { people: loader("people"), comments: loader("comments") }

  // The deepest path the surface declares — the depth cap that matches it.
  const maxDepth = Math.max(...surface.paths.map((path) => path.split(".").length))

  it("supplies the whitelist `Query.validateIncludePaths` checks against", () => {
    const validated = Query.validateIncludePaths(["author", "comments.author"], {
      includable: surface.paths,
      maxDepth
    }).pipe(Effect.runSync)
    expect(validated.map((v) => v.path)).toEqual(["author", "comments.author"])
  })

  it("rejects a deep path under a legal head through that same whitelist", () => {
    const rejected = Query.validateIncludePaths(["comments.editor"], {
      includable: surface.paths,
      maxDepth
    }).pipe(Effect.flip, Effect.runSync)
    expect(rejected._tag).toBe("UnsupportedIncludePath")
  })

  it("resolves to exactly the resources its own `included` union admits", () => {
    const resolved = Handlers.resolveIncluded(article, ["author", "comments.author"], targets).pipe(Effect.runSync)
    expect(resolved?.map((r) => `${r.type}:${r.id}`)).toEqual(["people:9", "comments:5", "people:7"])
    // Every type the walk produced is a member of the union derived from the
    // same declaration — which is the whole point: nothing the resolver hoists
    // can be stripped on encode for want of an arm.
    const admitted = surface.included.members.map((member) => member.type)
    expect([...new Set(resolved?.map((r) => r.type))].sort()).toEqual([...admitted].sort())
    // …and the union is not simply wide enough to admit anything.
    expect(admitted).not.toContain("tags")
  })
})
