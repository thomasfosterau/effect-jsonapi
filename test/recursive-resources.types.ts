/**
 * Type-level tests for mutually-recursive resource definitions (#118).
 *
 * `Article ⇄ Comment` — a to-many and its inverse to-one — is the ordinary
 * JSON:API graph, and it is authorable: TypeScript cannot *infer* two resource
 * types that reference each other, but it resolves them fine when each is
 * declared first, the way recursive `Schema` definitions are always written.
 * The cycle passes through a relationship descriptor's `ref` thunk, which is a
 * deferred position, so a pair of circular type aliases is legal.
 *
 * What this file pins is that the cycle costs nothing at the type level: the
 * include paths are exact in both directions, one hop across the cycle and
 * back, and an illegal path is still rejected.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions.
 */
import { Schema } from "effect"
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"

// The attribute maps are values, so the interfaces below can reference them
// with `typeof` rather than restating them.
const articleAttributes = { title: Schema.NonEmptyString }
const commentAttributes = { body: Schema.NonEmptyString }

type ArticleResource = Resource.Resource<
  "articles",
  typeof articleAttributes,
  { comments: Relationship.Many<CommentResource> }
>

type CommentResource = Resource.Resource<
  "comments",
  typeof commentAttributes,
  { article: Relationship.One<ArticleResource, false> }
>

const Article: ArticleResource = Resource.make("articles", {
  attributes: articleAttributes,
  relationships: { comments: Relationship.many(() => Comment) }
})

const Comment: CommentResource = Resource.make("comments", {
  attributes: commentAttributes,
  relationships: { article: Relationship.one(() => Article) }
})

// ---------------------------------------------------------------------------
// Include paths are exact in both directions, and terminate
// ---------------------------------------------------------------------------

declare const articlePath: Resource.IncludePath<typeof Article>
declare const commentPath: Resource.IncludePath<typeof Comment>

// Exactly one hop across the cycle and back — no widening to `string`.
const articlePaths: "comments" | "comments.article" = articlePath
const commentPaths: "article" | "article.comments" = commentPath

// …and the assignment holds in the other direction too, so the unions are
// equal rather than merely assignable.
const articlePathsBack: Resource.IncludePath<typeof Article> = articlePaths
const commentPathsBack: Resource.IncludePath<typeof Comment> = commentPaths

// A third hop is not a legal path: the derivation is bounded, so a cycle
// cannot make the union infinite.
// @ts-expect-error — "comments.article.comments" exceeds the derivation depth
const tooDeep: Resource.IncludePath<typeof Article> = "comments.article.comments"

// A relationship that does not exist is still rejected across the cycle.
// @ts-expect-error — Comment has no `author` relationship
const unknownPath: Resource.IncludePath<typeof Article> = "comments.author"

// ---------------------------------------------------------------------------
// Relationship targets resolve through the cycle
// ---------------------------------------------------------------------------

declare const commentTarget: Resource.Target<typeof Article, "comments">
declare const articleTarget: Resource.Target<typeof Comment, "article">

const commentIsTheTarget: CommentResource = commentTarget
const articleIsTheTarget: ArticleResource = articleTarget

// The target's own attributes are known, which is the thing a widened
// (`Resource.Any`) escape hatch would have lost.
declare const included: Resource.Target<typeof Comment, "article">["Type"]
const titleIsAString: string = included.attributes.title

// @ts-expect-error — and an attribute it does not have is still an error
const noSuchAttribute: string = included.attributes.body

export {
  articleIsTheTarget,
  articlePaths,
  articlePathsBack,
  commentIsTheTarget,
  commentPaths,
  commentPathsBack,
  noSuchAttribute,
  titleIsAString,
  tooDeep,
  unknownPath
}
