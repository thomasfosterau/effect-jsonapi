import { describe, expect, expectTypeOf, it } from "vitest"
import { Effect, Schema } from "effect"
import * as Handlers from "./Handlers.js"
import * as Relationship from "./Relationship.js"
import * as Resource from "./Resource.js"

// ---------------------------------------------------------------------------
// A recording store: the loaders under test, plus the log of what was asked of
// them. Every assertion about batching is an assertion about this log —
// a resolver that N+1s produces the same `included` and a very different log.
// ---------------------------------------------------------------------------

interface Call {
  readonly type: string
  readonly ids: ReadonlyArray<string>
}

const store = (rows: ReadonlyArray<Handlers.ResourceValue>, options?: { readonly delay?: Record<string, number> }) => {
  const calls: Array<Call> = []
  const byType = new Map<string, Map<string, Handlers.ResourceValue>>()
  for (const row of rows) {
    const existing = byType.get(row.type) ?? new Map<string, Handlers.ResourceValue>()
    existing.set(row.id, row)
    byType.set(row.type, existing)
  }

  const target =
    (type: string): Handlers.IncludeTarget =>
    (ids) =>
      Effect.suspend(() => {
        calls.push({ type, ids })
        const found = ids.flatMap((id) => {
          const row = byType.get(type)?.get(id)
          return row === undefined ? [] : [row]
        })
        const delay = options?.delay?.[type]
        return delay === undefined ? Effect.succeed(found) : Effect.sleep(delay).pipe(Effect.as(found))
      })

  const targets = (...types: ReadonlyArray<string>): Record<string, Handlers.IncludeTarget> =>
    Object.fromEntries(types.map((type) => [type, target(type)]))

  return {
    calls,
    target,
    targets,
    /** The log as `type:id,id` strings, in call order — ids in the order handed over. */
    log: () => calls.map((call) => `${call.type}:${call.ids.join(",")}`)
  }
}

const ids = (resources: ReadonlyArray<Handlers.ResourceValue> | undefined) =>
  resources?.map((resource) => `${resource.type}:${resource.id}`)

const one = (type: string, id: string) => ({ data: { type, id } })
const many = (type: string, ...values: ReadonlyArray<string>) => ({
  data: values.map((id) => ({ type, id }))
})

// articles:1 ──author──▶ people:9
//            ──tags────▶ tags:1, tags:2
//            ──comments▶ comments:5, comments:12  (each with an author)
const article1: Handlers.ResourceValue = {
  type: "articles",
  id: "1",
  relationships: {
    author: one("people", "9"),
    tags: many("tags", "1", "2"),
    comments: many("comments", "5", "12")
  }
}

const graph: ReadonlyArray<Handlers.ResourceValue> = [
  { type: "people", id: "9", relationships: { employer: one("companies", "acme") } },
  { type: "people", id: "2", relationships: { employer: one("companies", "acme") } },
  { type: "tags", id: "1" },
  { type: "tags", id: "2" },
  { type: "comments", id: "5", relationships: { author: one("people", "9"), article: one("articles", "1") } },
  { type: "comments", id: "12", relationships: { author: one("people", "2"), article: one("articles", "1") } },
  { type: "companies", id: "acme", relationships: { holding: one("holdings", "h1") } },
  { type: "holdings", id: "h1" }
]

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("Handlers.resolveIncluded — nothing requested", () => {
  it("resolves to undefined when no paths were requested, so the member is omitted", async () => {
    const db = store(graph)
    expect(await run(Handlers.resolveIncluded(article1, undefined, db.targets("people")))).toBeUndefined()
    expect(await run(Handlers.resolveIncluded(article1, [], db.targets("people")))).toBeUndefined()
    // and nothing was loaded to find that out
    expect(db.calls).toEqual([])
  })

  it("resolves to [] — not undefined — when the walk ran and came back empty", async () => {
    const db = store(graph)
    const empty: Handlers.ResourceValue = { type: "articles", id: "7" }
    expect(await run(Handlers.resolveIncluded(empty, ["author"], db.targets("people")))).toEqual([])
    // an empty page is the same statement
    expect(await run(Handlers.resolveIncluded([], ["author"], db.targets("people")))).toEqual([])
    expect(await run(Handlers.resolveIncluded(null, ["author"], db.targets("people")))).toEqual([])
  })
})

describe("Handlers.resolveIncluded — single level", () => {
  it("resolves a to-one path", async () => {
    const db = store(graph)
    const included = await run(Handlers.resolveIncluded(article1, ["author"], db.targets("people")))
    expect(ids(included)).toEqual(["people:9"])
    expect(db.log()).toEqual(["people:9"])
  })

  it("resolves a to-many path, in linkage order", async () => {
    const db = store(graph)
    const included = await run(Handlers.resolveIncluded(article1, ["tags"], db.targets("tags")))
    expect(ids(included)).toEqual(["tags:1", "tags:2"])
    // one call for both tags, not one per tag
    expect(db.log()).toEqual(["tags:1,2"])
  })

  it("resolves several paths as one level, one call per type", async () => {
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["author", "tags", "comments"], db.targets("people", "tags", "comments"))
    )
    expect(ids(included)).toEqual(["people:9", "tags:1", "tags:2", "comments:5", "comments:12"])
    expect(db.log()).toEqual(["people:9", "tags:1,2", "comments:5,12"])
  })

  it("emits in walk order, not in the order the batches complete", async () => {
    // people is the slowest loader, but `author` is the first path.
    const db = store(graph, { delay: { people: 20, tags: 5 } })
    const included = await run(
      Handlers.resolveIncluded(article1, ["author", "tags", "comments"], db.targets("people", "tags", "comments"))
    )
    expect(ids(included)).toEqual(["people:9", "tags:1", "tags:2", "comments:5", "comments:12"])
  })
})

describe("Handlers.resolveIncluded — multi level", () => {
  it("walks a dotted path one level at a time", async () => {
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments.author"], db.targets("comments", "people"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9", "people:2"])
    // level 1: both comments in one call; level 2: both authors in one call
    expect(db.log()).toEqual(["comments:5,12", "people:9,2"])
  })

  it("walks three levels with one call per type per level", async () => {
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments.author.employer"], db.targets("comments", "people", "companies"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9", "people:2", "companies:acme"])
    // people:9 and people:2 share an employer — one company call, one id
    expect(db.log()).toEqual(["comments:5,12", "people:9,2", "companies:acme"])
  })

  it("charges nothing extra for a path that is another path's prefix", async () => {
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments", "comments.author"], db.targets("comments", "people"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9", "people:2"])
    expect(db.log()).toEqual(["comments:5,12", "people:9,2"])
  })

  it("charges nothing for a repeated path", async () => {
    const db = store(graph)
    const included = await run(Handlers.resolveIncluded(article1, ["author", "author"], db.targets("people")))
    expect(ids(included)).toEqual(["people:9"])
    expect(db.log()).toEqual(["people:9"])
  })
})

describe("Handlers.resolveIncluded — batching is per level, not per resource", () => {
  // 50 articles; 25 distinct authors (each shared by two articles); 5 distinct
  // employers (each shared by five authors). The naïve resolver issues 50 + 50
  // reads here; this one issues two.
  const page: ReadonlyArray<Handlers.ResourceValue> = Array.from({ length: 50 }, (_, index) => ({
    type: "articles",
    id: String(index),
    relationships: { author: one("people", String(index % 25)) }
  }))
  const people: ReadonlyArray<Handlers.ResourceValue> = Array.from({ length: 25 }, (_, index) => ({
    type: "people",
    id: String(index),
    relationships: { employer: one("companies", String(index % 5)) }
  }))
  const companies: ReadonlyArray<Handlers.ResourceValue> = Array.from({ length: 5 }, (_, index) => ({
    type: "companies",
    id: String(index)
  }))

  it("issues one call per level over a whole page, whatever the page size", async () => {
    const db = store([...people, ...companies])
    const included = await run(Handlers.resolveIncluded(page, ["author.employer"], db.targets("people", "companies")))

    expect(db.calls.length).toBe(2)
    expect(db.calls[0]!.type).toBe("people")
    // 50 articles, 25 distinct authors: the level is deduplicated before loading
    expect(db.calls[0]!.ids.length).toBe(25)
    expect(new Set(db.calls[0]!.ids).size).toBe(25)
    expect(db.calls[1]!.type).toBe("companies")
    expect(db.calls[1]!.ids.length).toBe(5)

    expect(included).toHaveLength(30)
  })

  it("scales with distinct resources, not with references", async () => {
    const db = store([...people, ...companies])
    const small = await run(
      Handlers.resolveIncluded(page.slice(0, 2), ["author.employer"], db.targets("people", "companies"))
    )
    expect(ids(small)).toEqual(["people:0", "people:1", "companies:0", "companies:1"])
    expect(db.calls.length).toBe(2)
  })

  it("bounds a level's fan-out with `concurrency`", async () => {
    const inFlight = { now: 0, peak: 0 }
    const watched =
      (rows: ReadonlyArray<Handlers.ResourceValue>): Handlers.IncludeTarget =>
      () =>
        Effect.gen(function* () {
          inFlight.now++
          inFlight.peak = Math.max(inFlight.peak, inFlight.now)
          yield* Effect.sleep(10)
          inFlight.now--
          return rows
        })

    const primary: Handlers.ResourceValue = {
      type: "articles",
      id: "1",
      relationships: {
        author: one("people", "9"),
        tags: many("tags", "1"),
        comments: many("comments", "5")
      }
    }
    const targets = {
      people: watched([{ type: "people", id: "9" }]),
      tags: watched([{ type: "tags", id: "1" }]),
      comments: watched([{ type: "comments", id: "5" }])
    }
    const paths = ["author", "tags", "comments"]

    await run(Handlers.resolveIncluded(primary, paths, targets, { concurrency: 1 }))
    expect(inFlight.peak).toBe(1)

    inFlight.peak = 0
    await run(Handlers.resolveIncluded(primary, paths, targets))
    // the default is unbounded: the level's three types load together
    expect(inFlight.peak).toBe(3)
  })
})

describe("Handlers.resolveIncluded — deduplication", () => {
  it("emits a resource reached by two paths exactly once, at its first position", async () => {
    // A diamond: people:9 is both the article's author and comments:5's author.
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["author", "comments.author"], db.targets("people", "comments"))
    )
    expect(ids(included)).toEqual(["people:9", "comments:5", "comments:12", "people:2"])
    // people:9 came back at level 1; level 2 asks only for the author it lacks
    expect(db.log()).toEqual(["people:9", "comments:5,12", "people:2"])
  })

  it("emits a resource reached from two rows exactly once", async () => {
    const db = store(graph)
    const other: Handlers.ResourceValue = {
      type: "articles",
      id: "2",
      relationships: { author: one("people", "9") }
    }
    const included = await run(Handlers.resolveIncluded([article1, other], ["author"], db.targets("people")))
    expect(ids(included)).toEqual(["people:9"])
    expect(db.log()).toEqual(["people:9"])
  })

  it("never duplicates a primary resource into `included`", async () => {
    // The document already holds articles:1; reaching it again through a
    // comment must not emit a second resource object for it (the spec's
    // one-object-per-(type, id) rule spans the whole document).
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments.article"], db.targets("comments", "articles"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12"])
    // …and it was not loaded a second time either: no articles call at all
    expect(db.log()).toEqual(["comments:5,12"])
  })

  it("deduplicates across a page of primary resources too", async () => {
    const db = store(graph)
    const other: Handlers.ResourceValue = {
      type: "articles",
      id: "2",
      relationships: { comments: many("comments", "5") }
    }
    const included = await run(
      Handlers.resolveIncluded([article1, other], ["comments.article"], db.targets("comments", "articles"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12"])
    expect(db.log()).toEqual(["comments:5,12"])
  })
})

describe("Handlers.resolveIncluded — cycles", () => {
  // articles:100 ──comments──▶ comments:200 ──article──▶ articles:101
  // articles:101 ──comments──▶ comments:201 ──article──▶ articles:100
  const cyclic: ReadonlyArray<Handlers.ResourceValue> = [
    {
      type: "articles",
      id: "100",
      relationships: { comments: many("comments", "200") }
    },
    {
      type: "articles",
      id: "101",
      relationships: { comments: many("comments", "201") }
    },
    { type: "comments", id: "200", relationships: { article: one("articles", "101") } },
    { type: "comments", id: "201", relationships: { article: one("articles", "100") } }
  ]
  const primary = cyclic[0]!

  it("terminates on a genuinely cyclic graph without duplicating anything", async () => {
    const db = store(cyclic)
    const included = await run(
      Handlers.resolveIncluded(primary, ["comments.article.comments.article"], db.targets("comments", "articles"), {
        depth: 8
      })
    )
    // 100 → 200 → 101 → 201 → back to 100, which the document already holds
    expect(ids(included)).toEqual(["comments:200", "articles:101", "comments:201"])
    // every hop loaded only what the document lacked; the last hop loaded nothing
    expect(db.log()).toEqual(["comments:200", "articles:101", "comments:201"])
  })

  it("terminates when the cycle closes immediately", async () => {
    const selfReferential: ReadonlyArray<Handlers.ResourceValue> = [
      { type: "comments", id: "300", relationships: { article: one("articles", "300") } },
      { type: "articles", id: "300", relationships: { comments: many("comments", "300") } }
    ]
    const db = store(selfReferential)
    const included = await run(
      Handlers.resolveIncluded(
        selfReferential[1]!,
        ["comments.article.comments.article.comments"],
        db.targets("comments", "articles"),
        { depth: 12 }
      )
    )
    expect(ids(included)).toEqual(["comments:300"])
    expect(db.log()).toEqual(["comments:300"])
  })

  it("still emits each member of a cycle when none of them is the primary", async () => {
    const db = store([...cyclic, { type: "people", id: "9", relationships: { latest: one("articles", "100") } }])
    const person: Handlers.ResourceValue = {
      type: "people",
      id: "1",
      relationships: { latest: one("articles", "100") }
    }
    const included = await run(
      Handlers.resolveIncluded(person, ["latest.comments.article.comments"], db.targets("articles", "comments"), {
        depth: 8
      })
    )
    expect(ids(included)).toEqual(["articles:100", "comments:200", "articles:101", "comments:201"])
    expect(db.log()).toEqual(["articles:100", "comments:200", "articles:101", "comments:201"])
  })
})

describe("Handlers.resolveIncluded — depth cap", () => {
  it("walks no further than `depth` hops", async () => {
    const db = store(graph)
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments.author.employer"], db.targets("comments", "people", "companies"), {
        depth: 2
      })
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9", "people:2"])
    // the third hop was never walked, so `companies` was never asked
    expect(db.log()).toEqual(["comments:5,12", "people:9,2"])
  })

  it("caps a cyclic walk however long the requested path is", async () => {
    const db = store(graph)
    const deep = ["comments.article.comments.article.comments.article.comments"]
    await run(Handlers.resolveIncluded(article1, deep, db.targets("comments", "articles"), { depth: 1 }))
    expect(db.log()).toEqual(["comments:5,12"])
  })

  it("defaults to three hops — the deepest path `Query.Include` legalises", async () => {
    const db = store(graph)
    // The fourth hop *would* resolve — holdings:h1 exists and has a loader —
    // so reaching it is the failure this asserts against.
    const included = await run(
      Handlers.resolveIncluded(
        article1,
        ["comments.author.employer.holding"],
        db.targets("comments", "people", "companies", "holdings")
      )
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9", "people:2", "companies:acme"])
    expect(db.log()).toEqual(["comments:5,12", "people:9,2", "companies:acme"])

    // …and four hops when the caller asks for four
    const deeper = await run(
      Handlers.resolveIncluded(
        article1,
        ["comments.author.employer.holding"],
        db.targets("comments", "people", "companies", "holdings"),
        { depth: 4 }
      )
    )
    expect(ids(deeper)?.at(-1)).toBe("holdings:h1")
  })

  it("resolves nothing at a depth below one", async () => {
    const db = store(graph)
    expect(await run(Handlers.resolveIncluded(article1, ["author"], db.targets("people"), { depth: 0 }))).toEqual([])
    expect(db.calls).toEqual([])
  })
})

describe("Handlers.resolveIncluded — unresolvable references", () => {
  it("drops a reference whose type has no target", async () => {
    const db = store(graph)
    const included = await run(Handlers.resolveIncluded(article1, ["author", "tags"], db.targets("people")))
    expect(ids(included)).toEqual(["people:9"])
    expect(db.log()).toEqual(["people:9"])
  })

  it("drops an id the batch did not return, and keeps walking the rest", async () => {
    // comments:12's author is people:2, which the store does not hold.
    const db = store(graph.filter((row) => !(row.type === "people" && row.id === "2")))
    const included = await run(
      Handlers.resolveIncluded(article1, ["comments.author"], db.targets("comments", "people"))
    )
    expect(ids(included)).toEqual(["comments:5", "comments:12", "people:9"])
    expect(db.log()).toEqual(["comments:5,12", "people:9,2"])
  })

  it("drops a reference to a relationship the resource does not carry", async () => {
    const db = store(graph)
    const included = await run(Handlers.resolveIncluded(article1, ["editor"], db.targets("people")))
    expect(included).toEqual([])
    expect(db.calls).toEqual([])
  })

  it("drops an empty to-one and an empty to-many", async () => {
    const db = store(graph)
    const bare: Handlers.ResourceValue = {
      type: "articles",
      id: "3",
      relationships: { author: { data: null }, tags: { data: [] } }
    }
    expect(await run(Handlers.resolveIncluded(bare, ["author", "tags"], db.targets("people", "tags")))).toEqual([])
    expect(db.calls).toEqual([])
  })

  it("walks nothing through a paginated relationship, which carries no linkage", async () => {
    const db = store(graph)
    const paginated: Handlers.ResourceValue = {
      type: "articles",
      id: "4",
      relationships: { comments: Handlers.paginatedRelationship("articles", "4", "comments") }
    }
    expect(await run(Handlers.resolveIncluded(paginated, ["comments"], db.targets("comments")))).toEqual([])
    expect(db.calls).toEqual([])
  })

  it("ignores a row nobody referenced, so full linkage still holds", async () => {
    // A loader that over-fetches must not widen `included`: an unreferenced
    // resource there is exactly what `buildIncluded` rejects.
    const targets = {
      people: (() =>
        Effect.succeed([
          { type: "people", id: "9" },
          { type: "people", id: "404" }
        ])) as Handlers.IncludeTarget
    }
    const included = await run(Handlers.resolveIncluded(article1, ["author"], targets))
    expect(ids(included)).toEqual(["people:9"])
    expect(() => Handlers.data(article1, { included })).not.toThrow()
  })

  it("ignores a row whose type is not the one asked for", async () => {
    const targets = {
      people: (() => Effect.succeed([{ type: "tags", id: "9" }])) as Handlers.IncludeTarget
    }
    expect(await run(Handlers.resolveIncluded(article1, ["author"], targets))).toEqual([])
  })
})

describe("Handlers.resolveIncluded — loader faults", () => {
  class Unavailable {
    readonly _tag = "Unavailable"
  }

  it("fails the effect when a loader fails", async () => {
    const targets = {
      people: ((): Effect.Effect<ReadonlyArray<Handlers.ResourceValue>, Unavailable> =>
        Effect.fail(new Unavailable())) as Handlers.IncludeTarget<Handlers.ResourceValue, Unavailable>
    }
    const exit = await Effect.runPromiseExit(Handlers.resolveIncluded(article1, ["author"], targets))
    expect(exit._tag).toBe("Failure")
  })

  it("fails a deeper level's failure too", async () => {
    const db = store(graph)
    const targets = {
      comments: db.target("comments"),
      people: ((): Effect.Effect<ReadonlyArray<Handlers.ResourceValue>, Unavailable> =>
        Effect.fail(new Unavailable())) as Handlers.IncludeTarget<Handlers.ResourceValue, Unavailable>
    }
    const exit = await Effect.runPromiseExit(Handlers.resolveIncluded(article1, ["comments.author"], targets))
    expect(exit._tag).toBe("Failure")
    expect(db.log()).toEqual(["comments:5,12"])
  })
})

describe("Handlers.resolveIncluded — composing a document", () => {
  it("feeds `Handlers.data`, whose linkage check passes by construction", async () => {
    const db = store(graph)
    const document = await run(
      Handlers.resolveIncluded(article1, ["author", "comments.author"], db.targets("people", "comments")).pipe(
        Effect.map((included) => Handlers.data(article1, { included, self: "/articles/1" }))
      )
    )
    expect(ids(document.included)).toEqual(["people:9", "comments:5", "comments:12", "people:2"])
    expect(document.links).toEqual({ self: "/articles/1" })
  })

  it("feeds `Handlers.collection` unchanged — the same call serves a page", async () => {
    const db = store(graph)
    const other: Handlers.ResourceValue = {
      type: "articles",
      id: "2",
      relationships: { author: one("people", "2") }
    }
    const document = await run(
      Handlers.resolveIncluded([article1, other], ["author"], db.targets("people")).pipe(
        Effect.map((included) => Handlers.collection([article1, other], { included, self: "/articles" }))
      )
    )
    expect(ids(document.included)).toEqual(["people:9", "people:2"])
    expect(db.log()).toEqual(["people:9,2"])
  })

  it("omits the member entirely when the client asked for nothing", async () => {
    const db = store(graph)
    const document = await run(
      Handlers.resolveIncluded(article1, undefined, db.targets("people")).pipe(
        Effect.map((included) => Handlers.data(article1, { included }))
      )
    )
    expect(document).toEqual({ data: article1 })
    expect("included" in document).toBe(false)
  })
})

describe("Handlers.resolveIncluded — types", () => {
  const Person = Resource.make("people", {
    attributes: { firstName: Schema.NonEmptyString }
  })
  const Comment = Resource.make("comments", {
    attributes: { body: Schema.NonEmptyString },
    relationships: { author: Relationship.one(() => Person) }
  })
  const Article = Resource.make("articles", {
    attributes: { title: Schema.NonEmptyString },
    relationships: {
      author: Relationship.one(() => Person),
      comments: Relationship.many(() => Comment)
    }
  })

  const person = Person.make({ id: Person.Id.make("9"), attributes: { firstName: "Dan" } })
  const comment = Comment.make({
    id: Comment.Id.make("5"),
    attributes: { body: "First!" },
    relationships: { author: { data: Person.ref("9") } }
  })
  const article = Article.make({
    id: Article.Id.make("1"),
    attributes: { title: "JSON:API paints my bikeshed!" },
    relationships: {
      author: { data: Person.ref("9") },
      comments: { data: [Comment.ref("5")] }
    }
  })

  class Unavailable {
    readonly _tag = "Unavailable"
  }
  // A stand-in for a service a loader would require (a database handle, the
  // request's viewer); only its presence in the context channel is asserted.
  interface Vault {
    readonly vault: "Vault"
  }

  it("resolves to the union of the targets' resource types", async () => {
    const resolved = Handlers.resolveIncluded(article, ["author", "comments.author"], {
      people: () => Effect.succeed([person]),
      comments: () => Effect.succeed([comment])
    })

    expectTypeOf(resolved).toEqualTypeOf<
      Effect.Effect<ReadonlyArray<typeof Person.Type | typeof Comment.Type> | undefined, never, never>
    >()

    const included = await run(resolved)
    expect(ids(included)).toEqual(["people:9", "comments:5"])
    // …and it is exactly what the document builder wants
    expect(Handlers.data(article, { included }).included).toEqual(included)
  })

  it("unions the targets' error and service channels", () => {
    const resolved = Handlers.resolveIncluded(article, ["author", "comments"], {
      people: (): Effect.Effect<ReadonlyArray<typeof Person.Type>, Unavailable> => Effect.fail(new Unavailable()),
      comments: (): Effect.Effect<ReadonlyArray<typeof Comment.Type>, never, Vault> => Effect.succeed([comment])
    })
    expectTypeOf(resolved).toEqualTypeOf<
      Effect.Effect<ReadonlyArray<typeof Person.Type | typeof Comment.Type> | undefined, Unavailable, Vault>
    >()
  })

  it("names the pieces of a registry declared separately", () => {
    const targets = {
      people: (ids: ReadonlyArray<string>) => Effect.succeed(ids.map(() => person))
    } satisfies Handlers.IncludeTargets

    expectTypeOf<Handlers.IncludeTargetResource<typeof targets>>().toEqualTypeOf<typeof Person.Type>()
    expectTypeOf<Handlers.IncludeTargetError<typeof targets>>().toEqualTypeOf<never>()
    expectTypeOf<Handlers.IncludeTargetServices<typeof targets>>().toEqualTypeOf<never>()
  })
})
