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
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi"
export const User = Resource.make("users", {
  attributes: {
    login: Schema.NonEmptyString,
    name: Schema.optionalKey(Schema.String),
    bio: Schema.optionalKey(Schema.String),
    // Wire form is an ISO-8601 string; decoded form is a `Date`.
    createdAt: Schema.DateFromString
  }
})

export const Label = Resource.make("labels", {
  attributes: {
    name: Schema.NonEmptyString,
    /** Six-character hex color code, without the leading `#`. */
    color: Schema.NonEmptyString,
    description: Schema.optionalKey(Schema.String)
  }
})

export const Repository = Resource.make("repositories", {
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
    owner: Relationship.one(() => User)
  }
})

export const IssueComment = Resource.make("issueComments", {
  attributes: {
    body: Schema.NonEmptyString,
    createdAt: Schema.DateFromString
  },
  relationships: {
    author: Relationship.one(() => User)
  }
})

export const Issue = Resource.make("issues", {
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
    repository: Relationship.one(() => Repository),
    author: Relationship.one(() => User),
    // ... but may be unassigned.
    assignee: Relationship.optional(() => User),
    // Labels are few and bounded: inlined identifiers, manageable through
    // the /issues/:id/relationships/labels endpoints.
    labels: Relationship.many(() => Label),
    // Comments are unbounded: reachable only through the related link
    // (GET /issues/:id/comments), never inlined.
    comments: Relationship.paginated(() => IssueComment)
  }
})

export const PullRequest = Resource.make("pulls", {
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
    repository: Relationship.one(() => Repository),
    author: Relationship.one(() => User),
    reviewers: Relationship.many(() => User)
  }
})

export type User = typeof User.Type
export type Label = typeof Label.Type
export type Repository = typeof Repository.Type
export type IssueComment = typeof IssueComment.Type
export type Issue = typeof Issue.Type
export type PullRequest = typeof PullRequest.Type
