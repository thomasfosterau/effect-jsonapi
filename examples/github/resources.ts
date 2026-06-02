/**
 * A GitHub-like API's resources: users, repositories, issues, pull requests
 * and labels. Each one is defined once and everything else (identifiers,
 * payloads, documents, query parameters, endpoints) derives from these
 * definitions.
 *
 * The relationship graph:
 *
 *   Repository ──owner──────────────▶ User
 *   Issue ──repository──▶ Repository ──owner──▶ User   (a 2-hop include path)
 *   Issue ──author/assignee─────────▶ User
 *   Issue ──labels──────────────────▶ Label
 *   PullRequest ──repository────────▶ Repository
 *   PullRequest ──author────────────▶ User
 *   PullRequest ──reviewers─────────▶ User
 */
import { Schema } from "effect"
import { JsonApi } from "effect-jsonapi"

export const User = JsonApi.Resource("users", {
  attributes: {
    login: Schema.NonEmptyString,
    name: Schema.optionalKey(Schema.String),
    bio: Schema.optionalKey(Schema.String),
    // Wire form is an ISO-8601 string; decoded form is a `Date`.
    createdAt: Schema.DateFromString
  }
})

export const Label = JsonApi.Resource("labels", {
  attributes: {
    name: Schema.NonEmptyString,
    /** Six-character hex color code, without the leading `#`. */
    color: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String)
  }
})

export const Repository = JsonApi.Resource("repositories", {
  attributes: {
    name: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String),
    private: Schema.Boolean,
    language: Schema.optionalKey(Schema.String),
    stargazerCount: Schema.Int,
    createdAt: Schema.DateFromString
  },
  relationships: {
    owner: JsonApi.toOne(() => User)
  }
})

export const Issue = JsonApi.Resource("issues", {
  attributes: {
    number: Schema.Int,
    title: Schema.NonEmptyString,
    body: Schema.String,
    // Closed attribute set — `state` only ever decodes to one of these.
    state: Schema.Literals(["open", "closed"]),
    locked: Schema.Boolean,
    createdAt: Schema.DateFromString
  },
  relationships: {
    repository: JsonApi.toOne(() => Repository),
    author: JsonApi.toOne(() => User),
    assignee: JsonApi.toOne(() => User),
    labels: JsonApi.toMany(() => Label)
  }
})

export const PullRequest = JsonApi.Resource("pulls", {
  attributes: {
    number: Schema.Int,
    title: Schema.NonEmptyString,
    body: Schema.String,
    state: Schema.Literals(["open", "closed", "merged"]),
    draft: Schema.Boolean,
    headRef: Schema.NonEmptyString,
    baseRef: Schema.NonEmptyString,
    createdAt: Schema.DateFromString
  },
  relationships: {
    repository: JsonApi.toOne(() => Repository),
    author: JsonApi.toOne(() => User),
    reviewers: JsonApi.toMany(() => User)
  }
})

export type User = typeof User.Type
export type Label = typeof Label.Type
export type Repository = typeof Repository.Type
export type Issue = typeof Issue.Type
export type PullRequest = typeof PullRequest.Type
