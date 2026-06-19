/**
 * Type-level tests for client-side include narrowing.
 *
 * The `included` member of a response document is narrowed to exactly the
 * resources reachable via the include paths the client requested. The
 * narrowing is justified by the spec: when a client supplies `include`, "the
 * server MUST NOT include unrequested resource objects in the `included`
 * section" (https://jsonapi.org/format/1.1/#fetching-includes).
 *
 * Server-side (handler) narrowing is NOT possible: the response schema is
 * static and cannot depend on a runtime query value.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions.
 */
import { Effect, Schema } from "effect"
import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
const Person = Resource.make("people", {
  attributes: { firstName: Schema.NonEmptyString }
})

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: Relationship.one(() => Person) }
})

const Tag = Resource.make("tags", {
  attributes: { name: Schema.String }
})

const Revision = Resource.make("revisions", {
  attributes: { editedAt: Schema.String }
})

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person),
    comments: Relationship.many(() => Comment),
    tags: Relationship.many(() => Tag),
    // Paginated relationships are excluded from include paths entirely.
    revisions: Relationship.paginated(() => Revision)
  }
})

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {}

// ---------------------------------------------------------------------------
// IncludePath: legal paths as literals
// ---------------------------------------------------------------------------

type Paths = Resource.IncludePath<typeof Article>

// Expect: "author" | "comments" | "tags" | "comments.author"
const p1: Paths = "author"
const p2: Paths = "comments.author"
const p3: Paths = "tags"
// @ts-expect-error -- unknown path
const bad1: Paths = "publisher"
// @ts-expect-error -- unknown nested path
const bad2: Paths = "comments.likes"
// @ts-expect-error -- paginated relationships are not includable
const bad3: Paths = "revisions"

// ---------------------------------------------------------------------------
// IncludedFor: resources brought in by a set of paths
// ---------------------------------------------------------------------------

// Only "author" requested → included is just Person
type A = Resource.IncludedFor<typeof Article, ["author"]>
const a: A = Person
// @ts-expect-error -- Comment is not included when only "author" is requested
const aBad: A = Comment

// "comments.author" → Comment | Person (intermediate + leaf)
type B = Resource.IncludedFor<typeof Article, ["comments.author"]>
const b1: B = Comment
const b2: B = Person
// @ts-expect-error -- Tag not requested
const bBad: B = Tag

// Multiple paths union
type C = Resource.IncludedFor<typeof Article, ["author", "tags"]>
const c1: C = Person
const c2: C = Tag
// @ts-expect-error -- Comment not requested
const cBad: C = Comment

// ---------------------------------------------------------------------------
// narrowIncluded over a client call
// ---------------------------------------------------------------------------

// Stand-in for a derived client method (HttpApiClient / HttpApiTest)
type FetchDocument = ReturnType<typeof Article.document>["Type"]
declare const clientFetch: (request: {
  readonly params: { readonly id: string }
  readonly query: { readonly include?: ReadonlyArray<Resource.IncludePath<typeof Article>> }
}) => Effect.Effect<FetchDocument>

const program = Effect.gen(function* () {
  // Narrowed to Person only
  const include = ["author"] as const
  const onlyAuthor = yield* clientFetch({ params: { id: "1" }, query: { include } }).pipe(
    Client.narrowIncluded(Article, include)
  )
  const person = onlyAuthor.included?.[0]
  if (person !== undefined) {
    assertType<string>(person.attributes.firstName)
    // @ts-expect-error -- `body` doesn't exist on Person (it's a Comment attribute)
    assertType<string>(person.attributes.body)
  }

  // Dotted path: Comment | Person, discriminated by `type`
  const nested = ["comments.author"] as const
  const withComments = yield* clientFetch({ params: { id: "1" }, query: { include: nested } }).pipe(
    Client.narrowIncluded(Article, nested)
  )
  const item = withComments.included?.[0]
  if (item !== undefined && item.type === "comments") {
    assertType<string>(item.attributes.body)
  }

  // Nothing requested → included is ReadonlyArray<never>
  const none = [] as const
  const nothing = yield* clientFetch({ params: { id: "1" }, query: {} }).pipe(Client.narrowIncluded(Article, none))
  type NoneIncluded = NonNullable<typeof nothing.included>[number]
  assertType<NoneIncluded extends never ? true : false>(true)

  // Unknown paths are compile errors at the call site
  // @ts-expect-error -- "publisher" is not a relationship path of Article
  Client.narrowIncluded(Article, ["publisher"])
})

// ---------------------------------------------------------------------------
// narrowIncluded, data-first form
// ---------------------------------------------------------------------------

declare const someDocument: FetchDocument
const narrowed = Client.narrowIncluded(Article, ["tags"], someDocument)
const tag = narrowed.included?.[0]
if (tag !== undefined) {
  assertType<string>(tag.attributes.name)
  // @ts-expect-error -- firstName is a Person attribute; only Tag was requested
  assertType<string>(tag.attributes.firstName)
}

export { a, b1, b2, c1, c2, narrowed, p1, p2, p3, program }
