/**
 * The blog's resources: each one is defined once and everything else
 * (identifiers, payloads, documents, query parameters, endpoints) derives
 * from these definitions.
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

export const Comment = JsonApi.Resource("comments", {
  attributes: {
    body: Schema.NonEmptyString
  },
  relationships: {
    author: JsonApi.toOne(() => Person)
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
    author: JsonApi.toOne(() => Person),
    comments: JsonApi.toMany(() => Comment)
  }
})

export type Person = typeof Person.Type
export type Comment = typeof Comment.Type
export type Article = typeof Article.Type
