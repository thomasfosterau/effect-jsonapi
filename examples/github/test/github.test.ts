/**
 * End-to-end test of the GitHub-like API example: a real HTTP round-trip
 * (request encoding → routing → middleware → handler → response decoding)
 * through the in-memory `HttpApiTest` client.
 */
import { describe, expect, expectTypeOf, it } from "vitest"
import { Cause, Effect, Exit, Result, Schema } from "effect"
import { HttpApiTest, OpenApi } from "effect/unstable/httpapi"
import { Client } from "@thomasfosterau/effect-jsonapi"
import { Api } from "../api.js"
import { IssueLocked, RepositoryNameTaken, RepositoryNotFound, UserNotFound } from "../errors.js"
import {
  bugComments,
  bugIssue,
  bugLabel,
  defunkt,
  enhancementLabel,
  GitHubLive,
  helloWorld,
  hubot,
  lockedIssue,
  octocat,
  readmePull,
  spoonKnife
} from "../handlers.js"
import { Issue, Label, PullRequest, Repository, User } from "../resources.js"

const buildClient = HttpApiTest.groups(Api, ["users", "repositories", "issues", "pulls", "search"])

const run = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(GitHubLive)) as Effect.Effect<A, E, never>)

const runExit = <A, E>(effect: Effect.Effect<A, E, any>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(effect.pipe(Effect.scoped, Effect.provide(GitHubLive)) as Effect.Effect<A, E, never>)

const findFailure = <E>(cause: Cause.Cause<E>): E | undefined => {
  const result = Cause.findError(cause)
  return Result.isSuccess(result) ? result.success : undefined
}

describe("github example: fetching", () => {
  it("fetches a repository document with a self link", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.get({
          params: { id: Repository.Id.make("1") },
          query: {}
        })
      })
    )

    expect(document.data).toMatchObject({
      type: "repositories",
      id: "1",
      attributes: { name: "Hello-World", stargazerCount: 2127 }
    })
    expect(document.links?.self).toBe("/repositories/1")
    // dates decode through the wire format
    expect(document.data?.attributes.createdAt).toBeInstanceOf(Date)
  })

  it("serves compound documents for ?include=owner", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.get({
          params: { id: Repository.Id.make("1") },
          query: { include: ["owner"] }
        })
      })
    )

    expect(document.included?.map((resource) => resource.type)).toEqual(["users"])
  })

  it("resolves 2-hop include paths: issue → repository → owner", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.get({
          params: { id: Issue.Id.make("1") },
          query: { include: ["repository.owner", "author", "labels"] }
        })
      })
    )

    const types = document.included?.map((resource) => resource.type).sort()
    // repository (intermediate), its owner + the issue's author (deduplicated users), the labels
    expect(types).toEqual(["labels", "repositories", "users", "users"])
  })

  it("narrows `included` to the requested include paths on the client", async () => {
    const include = ["owner"] as const
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories
          .get({
            params: { id: Repository.Id.make("1") },
            query: { include }
          })
          .pipe(Client.narrowIncluded(Repository, include))
      })
    )

    // Runtime: the server only included the requested owner
    expect(document.included?.map((resource) => resource.type)).toEqual(["users"])
    // Types: `included` is narrowed to User — its attributes are accessible
    // without discriminating on `type`
    const owner = document.included?.[0]
    expect(owner?.attributes.login).toBe("octocat")
    expectTypeOf(owner!.attributes.login).toEqualTypeOf<string>()
    expectTypeOf(owner!.type).toEqualTypeOf<"users">()
  })

  it("fetches a pull request with its reviewers included", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.pulls.get({
          params: { id: PullRequest.Id.make("1") },
          query: { include: ["author", "reviewers"] }
        })
      })
    )

    expect(document.data?.attributes.headRef).toBe("octocat:patch-1")
    // author + 2 reviewers
    expect(document.included?.filter((resource) => resource.type === "users")).toHaveLength(3)
  })

  it("404s with a typed error for unknown repositories", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.get({
          params: { id: Repository.Id.make("nope") },
          query: {}
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(RepositoryNotFound)
      expect((error as RepositoryNotFound).id).toBe("nope")
    }
  })
})

describe("github example: listing", () => {
  it("lists repositories sorted by stars with page-number pagination", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.list({
          query: {
            sort: [{ field: "stargazerCount", direction: "desc" }],
            page: { number: 1, size: 2 }
          }
        })
      })
    )

    // most-starred first
    expect(document.data[0]?.attributes.name).toBe(spoonKnife.attributes.name)
    expect(document.data).toHaveLength(2)
    expect(document.meta?.total).toBe(3)
    expect(document.links?.next).toBe("/repositories?page[number]=2&page[size]=2")
  })

  it("filters repositories by language", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.list({
          query: { filter: { language: "TypeScript" } }
        })
      })
    )

    expect(document.data.map((repository) => repository.attributes.name)).toEqual(["secret-project"])
  })

  it("filters repositories by owner and visibility", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.list({
          query: { filter: { owner: octocat.id, visibility: "public" } }
        })
      })
    )

    const names = document.data.map((repository) => repository.attributes.name).sort()
    expect(names).toEqual(["Hello-World", "Spoon-Knife"])
  })

  it("filters issues by state and repository", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.list({
          query: { filter: { state: "open", repository: helloWorld.id } }
        })
      })
    )

    expect(document.data.map((issue) => issue.attributes.title)).toEqual([bugIssue.attributes.title])
    // the closed attribute set decodes to its literal type
    for (const issue of document.data) {
      expectTypeOf(issue.attributes.state).toEqualTypeOf<"open" | "closed">()
      expect(issue.attributes.state).toBe("open")
    }
  })

  it("lists users sorted by login", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.users.list({
          query: { sort: [{ field: "login", direction: "asc" }] }
        })
      })
    )

    expect(document.data.map((user) => user.attributes.login)).toEqual(["defunkt", "hubot", "octocat"])
  })

  it("filters pull requests by state", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.pulls.list({
          query: { filter: { state: "merged" } }
        })
      })
    )

    expect(document.data).toEqual([])
  })
})

describe("github example: writing", () => {
  it("creates a repository from a JSON:API payload (201) and then deletes it (204)", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient

        const created = yield* client.repositories.create({
          payload: {
            data: {
              type: "repositories",
              lid: "temp-1",
              attributes: {
                name: "my-new-repo",
                description: "Created over JSON:API",
                private: false,
                language: "TypeScript",
                stargazerCount: 0,
                createdAt: new Date("2024-06-01T00:00:00.000Z")
              },
              relationships: {
                owner: { data: User.ref(octocat.id) }
              }
            }
          }
        })

        expect(created.data).not.toBeNull()
        expect(created.data?.attributes.name).toBe("my-new-repo")
        expect(created.data?.relationships?.owner.data?.id).toBe(octocat.id)

        // and delete it again
        yield* client.repositories.delete({ params: { id: created.data!.id } })
      })
    )
  })

  it("422s when the repository name is already taken by the same owner", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.create({
          payload: {
            data: {
              type: "repositories",
              attributes: {
                name: helloWorld.attributes.name,
                private: false,
                stargazerCount: 0,
                createdAt: new Date()
              },
              relationships: {
                owner: { data: User.ref(octocat.id) }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(RepositoryNameTaken)
    }
  })

  it("opens an issue against a repository (201)", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.create({
          payload: {
            data: {
              type: "issues",
              attributes: {
                number: 1350,
                title: "Docs are out of date",
                body: "The README still references the old API.",
                state: "open",
                locked: false,
                createdAt: new Date("2024-06-01T00:00:00.000Z")
              },
              relationships: {
                repository: { data: Repository.ref(helloWorld.id) },
                author: { data: User.ref(octocat.id) },
                assignee: { data: null },
                labels: { data: [] }
              }
            }
          }
        })
      })
    )

    expect(document.data?.attributes.title).toBe("Docs are out of date")
    expect(document.data?.relationships?.repository.data?.id).toBe(helloWorld.id)
  })

  it("404s when opening an issue against a missing repository", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.create({
          payload: {
            data: {
              type: "issues",
              attributes: {
                number: 1,
                title: "Lost issue",
                body: "",
                state: "open",
                locked: false,
                createdAt: new Date()
              },
              relationships: {
                repository: { data: Repository.ref("does-not-exist") },
                // `author` is required (`one`) — null wouldn't even decode.
                author: { data: User.ref(octocat.id) },
                assignee: { data: null },
                labels: { data: [] }
              }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(RepositoryNotFound)
    }
  })

  it("closes an issue with a partial update", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.update({
          params: { id: Issue.Id.make("1") },
          payload: {
            data: {
              type: "issues",
              id: Issue.Id.make("1"),
              attributes: { state: "closed" }
            }
          }
        })
      })
    )

    expect(document.data?.attributes.state).toBe("closed")
    // other attributes are untouched
    expect(document.data?.attributes.title).toBe(bugIssue.attributes.title)
  })

  it("403s with a typed error when updating a locked issue", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.update({
          params: { id: lockedIssue.id },
          payload: {
            data: {
              type: "issues",
              id: lockedIssue.id,
              attributes: { state: "closed" }
            }
          }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const error = findFailure(exit.cause)
      expect(error).toBeInstanceOf(IssueLocked)
      expect((error as IssueLocked).id).toBe(lockedIssue.id)
    }
  })
})

describe("github example: related resource endpoints", () => {
  it("GET /repositories/:id/owner serves the owning user", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.repositories.owner({
          params: { id: Repository.Id.make("1") },
          query: {}
        })
      })
    )

    expect(document.data).toMatchObject({
      type: "users",
      id: octocat.id,
      attributes: { login: "octocat" }
    })
    expect(document.links?.self).toBe("/repositories/1/owner")
  })

  it("GET /issues/:id/comments serves the paginated comment feed", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.comments({
          params: { id: bugIssue.id },
          query: { page: { number: 1, size: 2 } }
        })
      })
    )

    // Full comment resources, paginated GitHub-style
    expect(document.data).toHaveLength(2)
    expect(document.data[0]?.attributes.body).toBe(bugComments[0]!.attributes.body)
    expect(document.meta?.total).toBe(3)
    expect(document.links?.next).toBe("/issues/1/comments?page[number]=2&page[size]=2")
  })

  it("GET /issues/:id/comments supports compound documents (?include=author)", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.comments({
          params: { id: bugIssue.id },
          query: { include: ["author"] }
        })
      })
    )

    // Three comments by two distinct users → two deduplicated includes
    expect(document.data).toHaveLength(3)
    const authors = document.included?.map((resource) => resource.id).sort()
    expect(authors).toEqual([octocat.id, defunkt.id].sort())
  })

  it("issues with no comments serve an empty related collection", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.comments({
          params: { id: lockedIssue.id },
          query: {}
        })
      })
    )

    expect(document.data).toEqual([])
    expect(document.meta?.total).toBe(0)
  })
})

describe("github example: issue triage via relationship endpoints", () => {
  it("GET /issues/:id/relationships/labels serves label linkage", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.labelsRelationship({
          params: { id: bugIssue.id },
          query: {}
        })
      })
    )

    expect(document.data).toEqual([{ type: "labels", id: bugLabel.id }])
    expect(document.links?.self).toBe("/issues/1/relationships/labels")
    expect(document.links?.related).toBe("/issues/1/labels")
  })

  it("PATCH /issues/:id/relationships/assignee assigns a user", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const linkage = yield* client.issues.updateAssigneeRelationship({
          params: { id: bugIssue.id },
          payload: { data: User.ref(hubot.id) }
        })
        // The issue reflects the assignment
        const issue = yield* client.issues.get({ params: { id: bugIssue.id }, query: {} })
        expect(issue.data?.relationships?.assignee.data?.id).toBe(hubot.id)
        return linkage
      })
    )

    expect(document.data).toEqual({ type: "users", id: hubot.id })
  })

  it("PATCH /issues/:id/relationships/assignee with null unassigns", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.updateAssigneeRelationship({
          params: { id: bugIssue.id },
          payload: { data: null }
        })
      })
    )

    expect(document.data).toBeNull()
  })

  it("404s when assigning an unknown user", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.updateAssigneeRelationship({
          params: { id: bugIssue.id },
          payload: { data: User.ref("ghost") }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(UserNotFound)
    }
  })

  it("403s when triaging a locked issue", async () => {
    const exit = await runExit(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.issues.addLabelsRelationship({
          params: { id: lockedIssue.id },
          payload: { data: [Label.ref(bugLabel.id)] }
        })
      })
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(findFailure(exit.cause)).toBeInstanceOf(IssueLocked)
    }
  })

  it("POST adds labels, DELETE removes them, PATCH replaces them", async () => {
    await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        const issueId = bugIssue.id

        // POST: add the enhancement label alongside the existing bug label
        const added = yield* client.issues.addLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(enhancementLabel.id)] }
        })
        expect(added.data.map((identifier) => identifier.id).sort()).toEqual([bugLabel.id, enhancementLabel.id].sort())

        // Adding an already-present label is a no-op (spec: MUST NOT add it again)
        const addedTwice = yield* client.issues.addLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(enhancementLabel.id)] }
        })
        expect(addedTwice.data).toHaveLength(2)

        // DELETE: remove the bug label → 204
        yield* client.issues.removeLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(bugLabel.id)] }
        })
        const afterRemove = yield* client.issues.labelsRelationship({ params: { id: issueId }, query: {} })
        expect(afterRemove.data).toEqual([{ type: "labels", id: enhancementLabel.id }])

        // PATCH: replace the full set
        const replaced = yield* client.issues.updateLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(bugLabel.id)] }
        })
        expect(replaced.data).toEqual([{ type: "labels", id: bugLabel.id }])
      })
    )
  })

  it("documents relationship endpoints in OpenAPI", () => {
    const spec = OpenApi.fromApi(Api)
    // Related resource endpoints
    expect(spec.paths["/repositories/{id}/owner"]?.get).toBeDefined()
    expect(spec.paths["/issues/{id}/comments"]?.get).toBeDefined()
    // Relationship (linkage) endpoints: GET/PATCH/POST/DELETE on labels
    expect(spec.paths["/issues/{id}/relationships/labels"]?.get).toBeDefined()
    expect(spec.paths["/issues/{id}/relationships/labels"]?.patch).toBeDefined()
    expect(spec.paths["/issues/{id}/relationships/labels"]?.post).toBeDefined()
    expect(spec.paths["/issues/{id}/relationships/labels"]?.delete).toBeDefined()
    expect(spec.paths["/issues/{id}/relationships/assignee"]?.patch).toBeDefined()
    // DELETE → 204
    expect(spec.paths["/issues/{id}/relationships/labels"]?.delete?.responses).toHaveProperty("204")
    // Locked issues → 403 documented on triage endpoints
    expect(spec.paths["/issues/{id}/relationships/labels"]?.post?.responses).toHaveProperty("403")
  })
})

describe("github example: heterogeneous search", () => {
  it("returns a mixed collection of repositories, issues and users, discriminated by type", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        // "o" hits all three stores: "Hello-World", "Found a bug", "octocat"
        return yield* client.search.search({
          query: { filter: { q: "o" } }
        })
      })
    )

    const types = [...new Set(document.data.map((result) => result.type))].sort()
    expect(types).toEqual(["issues", "repositories", "users"])

    // the union is discriminated by the `type` tag
    for (const result of document.data) {
      if (result.type === "repositories") {
        expectTypeOf(result.attributes.stargazerCount).toEqualTypeOf<number>()
      } else if (result.type === "issues") {
        expectTypeOf(result.attributes.state).toEqualTypeOf<"open" | "closed">()
      } else {
        expectTypeOf(result.attributes.login).toEqualTypeOf<string>()
      }
    }
  })

  it("filters across all resource types", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "spoon" } }
        })
      })
    )

    // only the Spoon-Knife repository matches
    expect(document.data.map((result) => result.type)).toEqual(["repositories"])
    expect(document.meta?.total).toBe(1)
  })

  it("paginates heterogeneous results with links", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "" }, page: { offset: 0, limit: 2 } }
        })
      })
    )

    expect(document.data).toHaveLength(2)
    expect(document.meta?.total).toBeGreaterThan(2)
    expect(document.links?.next).toBe("/search?page[offset]=2&page[limit]=2")
  })

  it("supports include across the searched resources' graphs", async () => {
    const document = await run(
      Effect.gen(function* () {
        const client = yield* buildClient
        return yield* client.search.search({
          query: { filter: { q: "spoon" }, include: ["owner"] }
        })
      })
    )

    // the matched repository's owner is included
    expect(document.included?.map((resource) => resource.type)).toEqual(["users"])
  })
})

describe("github example: spec compliance on the wire", () => {
  it("error documents are spec-compliant JSON:API", () => {
    const wire = Schema.encodeUnknownSync(IssueLocked.wire)(new IssueLocked({ id: "3" }))
    expect(wire).toEqual({
      errors: [
        {
          status: "403",
          code: "issue_locked",
          title: "Issue is locked",
          detail: "Issue 3 is locked and cannot be modified",
          meta: { id: "3" }
        }
      ]
    })

    const taken = Schema.encodeUnknownSync(RepositoryNameTaken.wire)(new RepositoryNameTaken({ name: "Hello-World" }))
    expect(taken).toEqual({
      errors: [
        {
          status: "422",
          code: "name_taken",
          title: "Repository name already taken",
          detail: `A repository named "Hello-World" already exists for this owner`,
          meta: { name: "Hello-World" }
        }
      ]
    })
  })

  it("OpenAPI generation reflects the JSON:API media type, statuses and query parameters", () => {
    const spec = OpenApi.fromApi(Api)
    const json = JSON.stringify(spec)
    expect(json).toContain("application/vnd.api+json")

    // create → 201 + 422, remove → 204, fetch errors → 404, update locked → 403
    expect(spec.paths["/repositories"]?.post?.responses).toHaveProperty("201")
    expect(spec.paths["/repositories"]?.post?.responses).toHaveProperty("422")
    expect(spec.paths["/repositories/{id}"]?.delete?.responses).toHaveProperty("204")
    expect(spec.paths["/repositories/{id}"]?.get?.responses).toHaveProperty("404")
    expect(spec.paths["/issues/{id}"]?.patch?.responses).toHaveProperty("403")

    // typed query parameters are documented with their bracket names
    const listParams = spec.paths["/repositories"]?.get?.parameters?.map((parameter: any) => parameter.name)
    expect(listParams).toContain("sort")
    expect(listParams).toContain("page[number]")
    expect(listParams).toContain("page[size]")
    expect(listParams).toContain("filter[language]")
    expect(listParams).toContain("filter[visibility]")

    // the heterogeneous search endpoint documents per-type sparse fieldsets
    const searchParams = spec.paths["/search"]?.get?.parameters?.map((parameter: any) => parameter.name)
    expect(searchParams).toContain("filter[q]")
    expect(searchParams).toContain("fields[repositories]")
    expect(searchParams).toContain("fields[issues]")
    expect(searchParams).toContain("fields[users]")
  })

  it("sample resources decode against their own schemas (round-trip)", () => {
    const encoded = Schema.encodeUnknownSync(Repository)(helloWorld)
    expect(encoded.attributes.createdAt).toBe("2011-01-26T19:01:12.000Z")
    const decoded = Schema.decodeUnknownSync(Repository)(encoded)
    expect(decoded).toEqual(helloWorld)

    const pull = Schema.encodeUnknownSync(PullRequest)(readmePull)
    expect(pull.relationships?.reviewers.data).toHaveLength(2)
  })
})
