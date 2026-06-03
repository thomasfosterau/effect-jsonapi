/**
 * The blog's resources: each one is defined once and everything else
 * (identifiers, payloads, documents, query parameters, endpoints) derives
 * from these definitions.
 *
 * The relationship graph exercises three of the four relationship kinds:
 *
 *   Article ──author───▶ Person   `one` — required, inline identifier
 *   Article ──tags─────▶ Tag      `many` — bounded, inline identifier array
 *   Article ──comments─▶ Comment  `paginated` — unbounded, reachable only via
 *                                  the related link (GET /articles/:id/comments)
 *   Comment ──author───▶ Person   `one`
 */
import { Schema } from "effect"
import { JsonApi } from "effect-jsonapi"

export const Person = JsonApi.Resource("people", {
  attributes: {
    firstName: Schema.NonEmptyString,
    lastName: Schema.NonEmptyString,
    twitter: Schema.optionalKey(Schema.String)
  }
})

export const Tag = JsonApi.Resource("tags", {
  attributes: {
    name: Schema.NonEmptyString
  }
})

export const Comment = JsonApi.Resource("comments", {
  attributes: {
    body: Schema.NonEmptyString
  },
  relationships: {
    // A comment always has an author: required to-one.
    author: JsonApi.Relationship.one(() => Person)
  }
})

export const Article = JsonApi.Resource("articles", {
  attributes: {
    title: Schema.NonEmptyString,
    body: Schema.String,
    // Wire form is an ISO-8601 string; decoded form is a `Date`.
    createdAt: Schema.DateFromString
  },
  relationships: {
    // Required to-one: an article cannot exist without an author, so the
    // create payload must carry it.
    author: JsonApi.Relationship.one(() => Person),
    // Bounded to-many: tags are few, so they are inlined as identifiers and
    // can be brought into compound documents via `?include=tags`.
    tags: JsonApi.Relationship.many(() => Tag),
    // Unbounded to-many: comments are reachable only through the relationship's
    // `related` link — a paginated collection endpoint. They never appear
    // inline and can't be included.
    comments: JsonApi.Relationship.paginated(() => Comment)
  }
})

export type Person = typeof Person.Type
export type Tag = typeof Tag.Type
export type Comment = typeof Comment.Type
export type Article = typeof Article.Type
