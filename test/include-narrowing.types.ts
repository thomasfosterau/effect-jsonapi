/**
 * Type-level proof: the `included` member of a response document CAN be
 * narrowed from the `include` query parameter — on the client side, where the
 * include paths exist as a literal type.
 *
 * This file is a verified design prototype for a potential `JsonApi.Client`
 * wrapper (not yet part of the public API). It is type-checked by
 * `tsconfig.test.json`; the `@ts-expect-error` annotations are the assertions.
 *
 * What it demonstrates:
 *   - `IncludePath<R>`: legal include paths as a literal union derived from
 *     the relationship graph (depth 2) — typos are compile errors
 *   - `IncludedFor<R, Paths>`: the union of resources brought in by a set of
 *     requested paths (dotted paths include intermediate + leaf resources)
 *   - a client wrapper generic over the literal paths, narrowing the response
 *     document's `included` per call site
 *
 * The narrowing cast is spec-sound: "the server MUST NOT include unrequested
 * resource objects" (https://jsonapi.org/format/1.1/#fetching-includes).
 *
 * Server-side (handler) narrowing is NOT possible: the response schema is
 * static and cannot depend on a runtime query value.
 */
import { Effect, Schema } from "effect"
import { JsonApi } from "effect-jsonapi"
import type * as Resource from "../src/Resource.js"

const Person = JsonApi.Resource("people", {
  attributes: { firstName: Schema.NonEmptyString }
})

const Comment = JsonApi.Resource("comments", {
  attributes: { body: Schema.NonEmptyString },
  relationships: { author: JsonApi.toOne(() => Person) }
})

const Tag = JsonApi.Resource("tags", {
  attributes: { name: Schema.String }
})

const Article = JsonApi.Resource("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: JsonApi.toOne(() => Person),
    comments: JsonApi.toMany(() => Comment),
    tags: JsonApi.toMany(() => Tag)
  }
})

// ---------------------------------------------------------------------------
// Type-level machinery
// ---------------------------------------------------------------------------

// The resource a relationship key points at
type Target<R extends Resource.Any, K> = R["relationships"][K & keyof R["relationships"]] extends
  { readonly ref: () => infer T } ? T extends Resource.Any ? T : never : never

// Legal include paths (depth 2): "author" | "comments" | "comments.author" | "tags" ...
type IncludePath<R extends Resource.Any> = {
  [K in keyof R["relationships"] & string]:
    | K
    | `${K}.${keyof Target<R, K>["relationships"] & string}`
}[keyof R["relationships"] & string]

// Resources brought in by one include path; per spec, a path like "comments.author"
// includes the intermediate resources ("comments") AND the leaf ("author" people).
type ResolvePath<R extends Resource.Any, P> = P extends `${infer Head}.${infer Rest}`
  ? Target<R, Head> | ResolvePath<Target<R, Head>, Rest>
  : Target<R, P>

// The union of resources for a set of requested paths
type IncludedFor<R extends Resource.Any, Paths extends ReadonlyArray<string>> = ResolvePath<R, Paths[number]>

// A document with `included` narrowed to the requested resources' decoded types
type NarrowIncluded<Doc, Included extends Resource.Any> = Omit<Doc, "included"> & {
  readonly included?: ReadonlyArray<Included["Type"]>
}

// ---------------------------------------------------------------------------
// Type assertions
// ---------------------------------------------------------------------------

type Paths = IncludePath<typeof Article>
// Expect: "author" | "comments" | "tags" | "comments.author"
const p1: Paths = "author"
const p2: Paths = "comments.author"
const p3: Paths = "tags"
// @ts-expect-error -- unknown path
const bad1: Paths = "publisher"
// @ts-expect-error -- unknown nested path
const bad2: Paths = "comments.likes"

// Narrowing: only "author" requested → included is just Person
type A = IncludedFor<typeof Article, ["author"]>
const a: A = Person
// @ts-expect-error -- Comment is not included when only "author" is requested
const aBad: A = Comment

// "comments.author" → Comment | Person (intermediate + leaf)
type B = IncludedFor<typeof Article, ["comments.author"]>
const b1: B = Comment
const b2: B = Person
// @ts-expect-error -- Tag not requested
const bBad: B = Tag

// Multiple paths union
type C = IncludedFor<typeof Article, ["author", "tags"]>
const c1: C = Person
const c2: C = Tag
// @ts-expect-error -- Comment not requested
const cBad: C = Comment

// ---------------------------------------------------------------------------
// A client wrapper that narrows the response document per call
// ---------------------------------------------------------------------------

declare const rawClientFetch: (request: {
  readonly params: { readonly id: string }
  readonly query: { readonly include?: ReadonlyArray<string> }
}) => Effect.Effect<typeof Article.document extends () => infer D ? D extends Schema.Top ? D["Type"] : never : never>

// The wrapper is generic over the literal include paths and casts the result.
// Sound per spec: "the server MUST NOT include unrequested resource objects".
const fetchArticle = <const Paths extends ReadonlyArray<IncludePath<typeof Article>> = readonly []>(
  id: string,
  options?: { readonly include?: Paths }
) =>
  rawClientFetch({ params: { id }, query: { include: options?.include ?? [] } }) as Effect.Effect<
    NarrowIncluded<
      typeof Article.document extends () => infer D ? D extends Schema.Top ? D["Type"] : never : never,
      IncludedFor<typeof Article, Paths>
    >
  >

// Asserts that a value's type is exactly `Expected` (bivariance-proof enough
// for these checks, and keeps `noUnusedLocals` happy).
const assertType = <Expected>(_value: Expected): void => {}

// Usage: included narrows per call site
const program = Effect.gen(function*() {
  const onlyAuthor = yield* fetchArticle("1", { include: ["author"] })
  // included is ReadonlyArray<Person.Type> | undefined
  const person = onlyAuthor.included?.[0]
  if (person !== undefined) {
    assertType<string>(person.attributes.firstName)
    // @ts-expect-error -- `body` doesn't exist on Person (it's a Comment attribute)
    assertType<string>(person.attributes.body)
  }

  const withComments = yield* fetchArticle("1", { include: ["comments.author"] })
  const item = withComments.included?.[0]
  if (item !== undefined && item.type === "comments") {
    assertType<string>(item.attributes.body) // narrowed by `type` discriminant
  }

  const nothing = yield* fetchArticle("1")
  // no include requested → included is ReadonlyArray<never> | undefined
  type NoneIncluded = NonNullable<typeof nothing.included>[number]
  assertType<NoneIncluded extends never ? true : false>(true)
})

export { a, b1, b2, c1, c2, p1, p2, p3, program }
