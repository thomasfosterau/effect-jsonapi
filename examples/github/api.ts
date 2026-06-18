/**
 * The GitHub-like HTTP API: JSON:API endpoints with conventional paths, typed
 * query parameters and JSON:API error documents — composed into a vanilla
 * `HttpApi`.
 *
 * - `users` is read-only (fetch + list)
 * - `repositories` is full CRUD with GitHub-style page-number pagination,
 *   plus a related-owner endpoint
 * - `issues` can be created and updated (closing an issue is a state update)
 *   but never deleted — just like on GitHub. Issue triage happens through
 *   relationship endpoints: assignment (`relationships/assignee`), labelling
 *   (`relationships/labels`) and a paginated comment feed (`/issues/:id/comments`)
 * - `pulls` is read-only
 * - `search` is a heterogeneous endpoint across repositories, issues and
 *   users, like GitHub's global search
 */
import { Schema } from "effect"
import { HttpApi } from "effect/unstable/httpapi"
import { JsonApi } from "@thomasfosterau/effect-jsonapi"
import {
  IssueLocked,
  IssueNotFound,
  PullRequestNotFound,
  RepositoryNameTaken,
  RepositoryNotFound,
  UserNotFound
} from "./errors.js"
import { Issue, PullRequest, Repository, User } from "./resources.js"

/**
 * Typed collection meta carried by list responses.
 */
export const PageMeta = Schema.Struct({
  total: Schema.Int
})

export const users = JsonApi.Group(
  User,
  // GET /users/:id
  JsonApi.Endpoint.fetch(User, {
    errors: [UserNotFound]
  }),
  // GET /users?sort=login&page[number]=1&page[size]=30
  JsonApi.Endpoint.list(User, {
    sort: ["login", "createdAt"],
    page: JsonApi.Page.Number,
    meta: PageMeta
  })
)

export const repositories = JsonApi.Group(
  Repository,
  // GET /repositories/:id?include=owner&fields[repositories]=name,description
  JsonApi.Endpoint.fetch(Repository, {
    include: true,
    fields: true,
    errors: [RepositoryNotFound]
  }),
  // GET /repositories?sort=-stargazerCount&filter[language]=TypeScript&page[number]=1&page[size]=30
  JsonApi.Endpoint.list(Repository, {
    include: true,
    sort: ["stargazerCount", "name", "createdAt"],
    page: JsonApi.Page.Number,
    filter: {
      owner: Schema.optionalKey(Schema.String),
      language: Schema.optionalKey(Schema.String),
      visibility: Schema.optionalKey(Schema.Literals(["public", "private"]))
    },
    meta: PageMeta
  }),
  // POST /repositories → 201
  JsonApi.Endpoint.create(Repository, {
    errors: [RepositoryNameTaken]
  }),
  // PATCH /repositories/:id (partial attributes)
  JsonApi.Endpoint.update(Repository, {
    errors: [RepositoryNotFound]
  }),
  // DELETE /repositories/:id → 204
  JsonApi.Endpoint.remove(Repository, {
    errors: [RepositoryNotFound]
  }),
  // GET /repositories/:id/owner — the owning user, as a full resource
  JsonApi.Endpoint.related(Repository, "owner", {
    errors: [RepositoryNotFound]
  })
)

export const issues = JsonApi.Group(
  Issue,
  // GET /issues/:id?include=author,assignee,labels,repository.owner
  JsonApi.Endpoint.fetch(Issue, {
    include: true,
    fields: true,
    errors: [IssueNotFound]
  }),
  // GET /issues?filter[state]=open&filter[repository]=1&sort=-createdAt
  JsonApi.Endpoint.list(Issue, {
    include: true,
    sort: ["number", "createdAt"],
    page: JsonApi.Page.Number,
    filter: {
      repository: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      assignee: Schema.optionalKey(Schema.String)
    },
    meta: PageMeta
  }),
  // POST /issues → 201 (repository and author are required relationships)
  JsonApi.Endpoint.create(Issue, {
    errors: [RepositoryNotFound]
  }),
  // PATCH /issues/:id — closing an issue is `attributes: { state: "closed" }`
  JsonApi.Endpoint.update(Issue, {
    errors: [IssueNotFound, IssueLocked]
  }),
  // --- Related resource endpoints --------------------------------------------
  // GET /issues/:id/comments?page[number]=1&page[size]=30&include=author —
  // the paginated comment feed the `comments` relationship's related link
  // points at
  JsonApi.Endpoint.related(Issue, "comments", {
    include: true,
    page: JsonApi.Page.Number,
    meta: PageMeta,
    errors: [IssueNotFound]
  }),
  // --- Relationship (linkage) endpoints: issue triage -------------------------
  // GET /issues/:id/relationships/labels — label identifiers
  JsonApi.Endpoint.fetchRelationship(Issue, "labels", {
    errors: [IssueNotFound]
  }),
  // PATCH /issues/:id/relationships/assignee — assign ({ data: identifier })
  // or unassign ({ data: null })
  JsonApi.Endpoint.updateRelationship(Issue, "assignee", {
    errors: [IssueNotFound, IssueLocked, UserNotFound]
  }),
  // PATCH /issues/:id/relationships/labels — replace all labels
  JsonApi.Endpoint.updateRelationship(Issue, "labels", {
    errors: [IssueNotFound, IssueLocked]
  }),
  // POST /issues/:id/relationships/labels — add labels
  JsonApi.Endpoint.addRelationship(Issue, "labels", {
    errors: [IssueNotFound, IssueLocked]
  }),
  // DELETE /issues/:id/relationships/labels → 204 — remove labels
  JsonApi.Endpoint.removeRelationship(Issue, "labels", {
    errors: [IssueNotFound, IssueLocked]
  })
)

export const pulls = JsonApi.Group(
  PullRequest,
  // GET /pulls/:id?include=author,reviewers,repository
  JsonApi.Endpoint.fetch(PullRequest, {
    include: true,
    errors: [PullRequestNotFound]
  }),
  // GET /pulls?filter[state]=open
  JsonApi.Endpoint.list(PullRequest, {
    include: true,
    sort: ["number", "createdAt"],
    page: JsonApi.Page.Number,
    filter: {
      repository: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.Literals(["open", "closed", "merged"]))
    },
    meta: PageMeta
  })
)

/**
 * GitHub-style global search: a heterogeneous collection of repositories,
 * issues and users, discriminated by their `type` tags.
 */
export const search = JsonApi.Group(
  "search",
  // GET /search?filter[q]=hello&include=owner&page[offset]=0&page[limit]=10
  JsonApi.Endpoint.search([Repository, Issue, User], {
    filter: { q: Schema.String },
    include: true,
    fields: true,
    page: JsonApi.Page.Offset,
    meta: PageMeta
  })
)

export const Api = HttpApi.make("github").add(users).add(repositories).add(issues).add(pulls).add(search)
