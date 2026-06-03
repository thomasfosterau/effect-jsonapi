/**
 * A GitHub-like API's resources: users, repositories, issues, issue comments,
 * pull requests and labels. Each one is defined once and everything else
 * (identifiers, payloads, documents, query parameters, endpoints) derives
 * from these definitions.
 *
 * The relationship graph exercises all four relationship kinds:
 *
 *   Repository ──owner──────────────▶ User          `one`
 *   Issue ──repository──▶ Repository ──owner──▶ User  (a 2-hop include path)
 *   Issue ──author──────────────────▶ User          `one`
 *   Issue ──assignee────────────────▶ User          `optional` (may be null)
 *   Issue ──labels──────────────────▶ Label         `many` (bounded, inlined)
 *   Issue ──comments────────────────▶ IssueComment  `paginated` (unbounded, linked)
 *   IssueComment ──author───────────▶ User          `one`
 *   PullRequest ──repository────────▶ Repository    `one`
 *   PullRequest ──author────────────▶ User          `one`
 *   PullRequest ──reviewers─────────▶ User          `many`
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
    // Every repository has an owner: required to-one.
    owner: JsonApi.Relationship.one(() => User)
  }
})

export const IssueComment = JsonApi.Resource("issueComments", {
  attributes: {
    body: Schema.NonEmptyString,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: JsonApi.Relationship.one(() => User)
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
    // An issue is always opened against a repository, by someone.
    repository: JsonApi.Relationship.one(() => Repository),
    author: JsonApi.Relationship.one(() => User),
    // ... but may be unassigned.
    assignee: JsonApi.Relationship.optional(() => User),
    // Labels are few and bounded: inlined identifiers, manageable through
    // the /issues/:id/relationships/labels endpoints.
    labels: JsonApi.Relationship.many(() => Label),
    // Comments are unbounded: reachable only through the related link
    // (GET /issues/:id/comments), never inlined.
    comments: JsonApi.Relationship.paginated(() => IssueComment)
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
    repository: JsonApi.Relationship.one(() => Repository),
    author: JsonApi.Relationship.one(() => User),
    reviewers: JsonApi.Relationship.many(() => User)
  }
})

export type User = typeof User.Type
export type Label = typeof Label.Type
export type Repository = typeof Repository.Type
export type IssueComment = typeof IssueComment.Type
export type Issue = typeof Issue.Type
export type PullRequest = typeof PullRequest.Type
