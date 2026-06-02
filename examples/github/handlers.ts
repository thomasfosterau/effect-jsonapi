/**
 * The GitHub-like API's handlers: vanilla `HttpApiBuilder.group` implementations
 * backed by an in-memory store, using the JSON:API document builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.sort` / `query.page` / `query.filter` are typed
 *   - `payload.data.attributes` is the typed create/update payload
 *
 * and return document values (`JsonApi.data` / `JsonApi.collection`), which
 * are validated against the endpoint's document schema on the way out.
 */
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { JsonApi } from "effect-jsonapi"
import { Api } from "./api.js"
import { IssueLocked, IssueNotFound, PullRequestNotFound, RepositoryNameTaken, RepositoryNotFound, UserNotFound } from "./errors.js"
import { Issue, Label, PullRequest, Repository, User } from "./resources.js"

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const octocat: User = User.make({
  id: User.Id.make("1"),
  attributes: {
    login: "octocat",
    name: "The Octocat",
    bio: "GitHub's mascot",
    createdAt: new Date("2011-01-25T18:44:36.000Z")
  }
})

export const defunkt: User = User.make({
  id: User.Id.make("2"),
  attributes: {
    login: "defunkt",
    name: "Chris Wanstrath",
    createdAt: new Date("2007-10-20T05:24:19.000Z")
  }
})

export const hubot: User = User.make({
  id: User.Id.make("3"),
  attributes: {
    login: "hubot",
    name: "Hubot",
    bio: "A friendly robot",
    createdAt: new Date("2011-10-25T18:00:00.000Z")
  }
})

export const bugLabel: Label = Label.make({
  id: Label.Id.make("1"),
  attributes: { name: "bug", color: "d73a4a", description: "Something isn't working" }
})

export const enhancementLabel: Label = Label.make({
  id: Label.Id.make("2"),
  attributes: { name: "enhancement", color: "a2eeef", description: "New feature or request" }
})

export const helloWorld: Repository = Repository.make({
  id: Repository.Id.make("1"),
  attributes: {
    name: "Hello-World",
    description: "My first repository on GitHub!",
    private: false,
    language: "C",
    stargazerCount: 2127,
    createdAt: new Date("2011-01-26T19:01:12.000Z")
  },
  relationships: {
    // `ref` builds a typed `{ type: "users", id }` resource identifier
    owner: { data: User.ref(octocat.id) }
  }
})

export const spoonKnife: Repository = Repository.make({
  id: Repository.Id.make("2"),
  attributes: {
    name: "Spoon-Knife",
    description: "This repo is for demonstration purposes only.",
    private: false,
    language: "HTML",
    stargazerCount: 12000,
    createdAt: new Date("2011-01-27T19:30:43.000Z")
  },
  relationships: {
    owner: { data: User.ref(octocat.id) }
  }
})

export const secretProject: Repository = Repository.make({
  id: Repository.Id.make("3"),
  attributes: {
    name: "secret-project",
    private: true,
    language: "TypeScript",
    stargazerCount: 0,
    createdAt: new Date("2024-03-01T00:00:00.000Z")
  },
  relationships: {
    owner: { data: User.ref(defunkt.id) }
  }
})

export const bugIssue: Issue = Issue.make({
  id: Issue.Id.make("1"),
  attributes: {
    number: 1347,
    title: "Found a bug",
    body: "I'm having a problem with this.",
    state: "open",
    locked: false,
    createdAt: new Date("2011-04-22T13:33:48.000Z")
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(defunkt.id) },
    assignee: { data: User.ref(octocat.id) },
    labels: { data: [Label.ref(bugLabel.id)] }
  }
})

export const featureIssue: Issue = Issue.make({
  id: Issue.Id.make("2"),
  attributes: {
    number: 1348,
    title: "Add a CONTRIBUTING guide",
    body: "New contributors need guidance.",
    state: "closed",
    locked: false,
    createdAt: new Date("2011-05-01T10:00:00.000Z")
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(hubot.id) },
    assignee: { data: null },
    labels: { data: [Label.ref(enhancementLabel.id)] }
  }
})

export const lockedIssue: Issue = Issue.make({
  id: Issue.Id.make("3"),
  attributes: {
    number: 42,
    title: "Tabs vs spaces",
    body: "This discussion got out of hand.",
    state: "open",
    locked: true,
    createdAt: new Date("2024-04-01T00:00:00.000Z")
  },
  relationships: {
    repository: { data: Repository.ref(secretProject.id) },
    author: { data: User.ref(defunkt.id) },
    assignee: { data: null },
    labels: { data: [] }
  }
})

export const readmePull: PullRequest = PullRequest.make({
  id: PullRequest.Id.make("1"),
  attributes: {
    number: 1349,
    title: "Update the README with new information",
    body: "Fixes a few typos and adds a usage section.",
    state: "open",
    draft: false,
    headRef: "octocat:patch-1",
    baseRef: "master",
    createdAt: new Date("2011-04-30T20:00:00.000Z")
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(octocat.id) },
    reviewers: { data: [User.ref(defunkt.id), User.ref(hubot.id)] }
  }
})

const store = {
  users: new Map<string, User>([octocat, defunkt, hubot].map((user) => [user.id, user])),
  labels: new Map<string, Label>([bugLabel, enhancementLabel].map((label) => [label.id, label])),
  repositories: new Map<string, Repository>(
    [helloWorld, spoonKnife, secretProject].map((repository) => [repository.id, repository])
  ),
  issues: new Map<string, Issue>([bugIssue, featureIssue, lockedIssue].map((issue) => [issue.id, issue])),
  pulls: new Map<string, PullRequest>([[readmePull.id, readmePull]])
}

const loadUser = (id: string): Effect.Effect<User, UserNotFound> => {
  const user = store.users.get(id)
  return user === undefined ? Effect.fail(new UserNotFound({ id })) : Effect.succeed(user)
}

const loadRepository = (id: string): Effect.Effect<Repository, RepositoryNotFound> => {
  const repository = store.repositories.get(id)
  return repository === undefined ? Effect.fail(new RepositoryNotFound({ id })) : Effect.succeed(repository)
}

const loadIssue = (id: string): Effect.Effect<Issue, IssueNotFound> => {
  const issue = store.issues.get(id)
  return issue === undefined ? Effect.fail(new IssueNotFound({ id })) : Effect.succeed(issue)
}

const loadPull = (id: string): Effect.Effect<PullRequest, PullRequestNotFound> => {
  const pull = store.pulls.get(id)
  return pull === undefined ? Effect.fail(new PullRequestNotFound({ id })) : Effect.succeed(pull)
}

// ---------------------------------------------------------------------------
// Include resolution & shared helpers
// ---------------------------------------------------------------------------

// Resolve the resources referenced by the requested include paths.

const resolveRepositoryIncluded = (
  repository: Repository,
  include: ReadonlyArray<string> | undefined
): Array<User> => {
  const included: Array<User> = []
  if (include?.includes("owner")) {
    const owner = repository.relationships?.owner.data
    if (owner != null && store.users.has(owner.id)) included.push(store.users.get(owner.id)!)
  }
  return included
}

const resolveIssueIncluded = (
  issue: Issue,
  include: ReadonlyArray<string> | undefined
): Array<Repository | User | Label> => {
  const included: Array<Repository | User | Label> = []
  if (include === undefined) return included
  if (include.some((path) => path === "repository" || path === "repository.owner")) {
    const ref = issue.relationships?.repository.data
    const repository = ref != null ? store.repositories.get(ref.id) : undefined
    if (repository !== undefined) {
      included.push(repository)
      if (include.includes("repository.owner")) {
        included.push(...resolveRepositoryIncluded(repository, ["owner"]))
      }
    }
  }
  for (const key of ["author", "assignee"] as const) {
    if (include.includes(key)) {
      const ref = issue.relationships?.[key].data
      if (ref != null && store.users.has(ref.id)) included.push(store.users.get(ref.id)!)
    }
  }
  if (include.includes("labels")) {
    for (const ref of issue.relationships?.labels.data ?? []) {
      const label = store.labels.get(ref.id)
      if (label !== undefined) included.push(label)
    }
  }
  return included
}

const resolvePullIncluded = (
  pull: PullRequest,
  include: ReadonlyArray<string> | undefined
): Array<Repository | User> => {
  const included: Array<Repository | User> = []
  if (include === undefined) return included
  if (include.some((path) => path === "repository" || path === "repository.owner")) {
    const ref = pull.relationships?.repository.data
    const repository = ref != null ? store.repositories.get(ref.id) : undefined
    if (repository !== undefined) {
      included.push(repository)
      if (include.includes("repository.owner")) {
        included.push(...resolveRepositoryIncluded(repository, ["owner"]))
      }
    }
  }
  if (include.includes("author")) {
    const ref = pull.relationships?.author.data
    if (ref != null && store.users.has(ref.id)) included.push(store.users.get(ref.id)!)
  }
  if (include.includes("reviewers")) {
    for (const ref of pull.relationships?.reviewers.data ?? []) {
      const reviewer = store.users.get(ref.id)
      if (reviewer !== undefined) included.push(reviewer)
    }
  }
  return included
}

// Apply `?sort=` terms (already decoded to `{ field, direction }`) in order.
const sortBy = <A extends { readonly attributes: any }>(
  items: Array<A>,
  sort: ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }> | undefined
): Array<A> => {
  for (const term of [...(sort ?? [])].reverse()) {
    const direction = term.direction === "desc" ? -1 : 1
    items.sort((a, b) => {
      const left = a.attributes[term.field]
      const right = b.attributes[term.field]
      return (left < right ? -1 : left > right ? 1 : 0) * direction
    })
  }
  return items
}

// Apply `?page[number]=&page[size]=` pagination.
const paginate = <A>(
  items: ReadonlyArray<A>,
  page: { readonly number?: number; readonly size?: number } | undefined
): { readonly page: ReadonlyArray<A>; readonly total: number; readonly number: number; readonly size: number } => {
  const total = items.length
  const size = page?.size ?? Math.max(total, 1)
  const number = page?.number ?? 1
  return { page: items.slice((number - 1) * size, number * size), total, number, size }
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const UsersLive = HttpApiBuilder.group(Api, "users", (handlers) =>
  handlers
    .handle("fetch", ({ params }) =>
      loadUser(params.id).pipe(
        Effect.map((user) => JsonApi.data(user, { self: `/users/${user.id}` }))
      ))
    .handle("list", ({ query }) => {
      const users = sortBy([...store.users.values()], query.sort)
      const { number, page, size, total } = paginate(users, query.page)
      return Effect.succeed(
        JsonApi.collection(page, {
          meta: { total },
          links: JsonApi.numberPaginationLinks("/users", { number, size }, total)
        })
      )
    })
)

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const RepositoriesLive = HttpApiBuilder.group(Api, "repositories", (handlers) =>
  handlers
    .handle("fetch", ({ params, query }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) =>
          JsonApi.data(repository, {
            included: resolveRepositoryIncluded(repository, query.include),
            self: `/repositories/${repository.id}`
          })
        )
      ))
    .handle("list", ({ query }) => {
      let repositories = [...store.repositories.values()]

      // filter[owner]=<user id>
      const owner = query.filter?.owner
      if (owner !== undefined) {
        repositories = repositories.filter((repository) => repository.relationships?.owner.data?.id === owner)
      }
      // filter[language]=TypeScript
      const language = query.filter?.language
      if (language !== undefined) {
        repositories = repositories.filter((repository) => repository.attributes.language === language)
      }
      // filter[visibility]=public|private
      const visibility = query.filter?.visibility
      if (visibility !== undefined) {
        repositories = repositories.filter((repository) =>
          repository.attributes.private === (visibility === "private")
        )
      }

      sortBy(repositories, query.sort)
      const { number, page, size, total } = paginate(repositories, query.page)

      return Effect.succeed(
        JsonApi.collection(page, {
          included: page.flatMap((repository) => resolveRepositoryIncluded(repository, query.include)),
          meta: { total },
          links: JsonApi.numberPaginationLinks("/repositories", { number, size }, total)
        })
      )
    })
    .handle("create", ({ payload }) => {
      const name = payload.data.attributes.name
      const owner = payload.data.relationships?.owner.data?.id
      for (const existing of store.repositories.values()) {
        if (existing.attributes.name === name && existing.relationships?.owner.data?.id === owner) {
          return Effect.fail(new RepositoryNameTaken({ name }))
        }
      }
      const repository = Repository.make({
        id: Repository.Id.make(`${store.repositories.size + 1}`),
        attributes: payload.data.attributes,
        relationships: payload.data.relationships ?? { owner: { data: null } }
      })
      store.repositories.set(repository.id, repository)
      return Effect.succeed(JsonApi.data(repository, { self: `/repositories/${repository.id}` }))
    })
    .handle("update", ({ params, payload }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) => {
          const updated = Repository.make({
            ...repository,
            attributes: { ...repository.attributes, ...(payload.data.attributes ?? {}) },
            relationships: payload.data.relationships ?? repository.relationships ?? { owner: { data: null } }
          })
          store.repositories.set(updated.id, updated)
          return JsonApi.data(updated, { self: `/repositories/${updated.id}` })
        })
      ))
    .handle("remove", ({ params }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) => {
          store.repositories.delete(repository.id)
        })
      ))
)

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const IssuesLive = HttpApiBuilder.group(Api, "issues", (handlers) =>
  handlers
    .handle("fetch", ({ params, query }) =>
      loadIssue(params.id).pipe(
        Effect.map((issue) =>
          JsonApi.data(issue, {
            included: resolveIssueIncluded(issue, query.include),
            self: `/issues/${issue.id}`
          })
        )
      ))
    .handle("list", ({ query }) => {
      let issues = [...store.issues.values()]

      // filter[repository]=<repository id>
      const repository = query.filter?.repository
      if (repository !== undefined) {
        issues = issues.filter((issue) => issue.relationships?.repository.data?.id === repository)
      }
      // filter[state]=open|closed
      const state = query.filter?.state
      if (state !== undefined) {
        issues = issues.filter((issue) => issue.attributes.state === state)
      }
      // filter[assignee]=<user id>
      const assignee = query.filter?.assignee
      if (assignee !== undefined) {
        issues = issues.filter((issue) => issue.relationships?.assignee.data?.id === assignee)
      }

      sortBy(issues, query.sort)
      const { number, page, size, total } = paginate(issues, query.page)

      return Effect.succeed(
        JsonApi.collection(page, {
          included: page.flatMap((issue) => resolveIssueIncluded(issue, query.include)),
          meta: { total },
          links: JsonApi.numberPaginationLinks("/issues", { number, size }, total)
        })
      )
    })
    .handle("create", ({ payload }) => {
      // An issue must be opened against an existing repository.
      const relationships = payload.data.relationships
      const repository = relationships?.repository.data
      if (relationships === undefined || repository == null || !store.repositories.has(repository.id)) {
        return Effect.fail(new RepositoryNotFound({ id: repository?.id ?? "unknown" }))
      }
      const issue = Issue.make({
        id: Issue.Id.make(`${store.issues.size + 1}`),
        attributes: payload.data.attributes,
        relationships
      })
      store.issues.set(issue.id, issue)
      return Effect.succeed(JsonApi.data(issue, { self: `/issues/${issue.id}` }))
    })
    .handle("update", ({ params, payload }) =>
      loadIssue(params.id).pipe(
        Effect.flatMap((issue) => {
          // Locked issues cannot be modified (403).
          if (issue.attributes.locked) {
            return Effect.fail(new IssueLocked({ id: issue.id }))
          }
          const updated = Issue.make({
            ...issue,
            attributes: { ...issue.attributes, ...(payload.data.attributes ?? {}) },
            relationships: payload.data.relationships ?? issue.relationships ?? {
              repository: { data: null },
              author: { data: null },
              assignee: { data: null },
              labels: { data: [] }
            }
          })
          store.issues.set(updated.id, updated)
          return Effect.succeed(JsonApi.data(updated, { self: `/issues/${updated.id}` }))
        })
      ))
)

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const PullsLive = HttpApiBuilder.group(Api, "pulls", (handlers) =>
  handlers
    .handle("fetch", ({ params, query }) =>
      loadPull(params.id).pipe(
        Effect.map((pull) =>
          JsonApi.data(pull, {
            included: resolvePullIncluded(pull, query.include),
            self: `/pulls/${pull.id}`
          })
        )
      ))
    .handle("list", ({ query }) => {
      let pulls = [...store.pulls.values()]

      const repository = query.filter?.repository
      if (repository !== undefined) {
        pulls = pulls.filter((pull) => pull.relationships?.repository.data?.id === repository)
      }
      const state = query.filter?.state
      if (state !== undefined) {
        pulls = pulls.filter((pull) => pull.attributes.state === state)
      }

      sortBy(pulls, query.sort)
      const { number, page, size, total } = paginate(pulls, query.page)

      return Effect.succeed(
        JsonApi.collection(page, {
          included: page.flatMap((pull) => resolvePullIncluded(pull, query.include)),
          meta: { total },
          links: JsonApi.numberPaginationLinks("/pulls", { number, size }, total)
        })
      )
    })
)

// ---------------------------------------------------------------------------
// Search — a heterogeneous collection of repositories, issues and users
// ---------------------------------------------------------------------------

const matches = (haystack: ReadonlyArray<string | undefined>, needle: string): boolean =>
  haystack.some((value) => value !== undefined && value.toLowerCase().includes(needle.toLowerCase()))

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => {
    const q = query.filter?.q ?? ""

    // search across all three resource types; results stay discriminated by `type`
    const repositories = [...store.repositories.values()].filter((repository) =>
      matches([repository.attributes.name, repository.attributes.description], q)
    )
    const issues = [...store.issues.values()].filter((issue) =>
      matches([issue.attributes.title, issue.attributes.body], q)
    )
    const users = [...store.users.values()].filter((user) =>
      matches([user.attributes.login, user.attributes.name], q)
    )
    const results = [...repositories, ...issues, ...users]

    const total = results.length
    const offset = query.page?.offset ?? 0
    const limit = query.page?.limit ?? Math.max(total, 1)
    const page = results.slice(offset, offset + limit)

    return Effect.succeed(
      JsonApi.collection(page, {
        included: page.flatMap((result) =>
          result.type === "repositories"
            ? resolveRepositoryIncluded(result, query.include)
            : result.type === "issues"
            ? resolveIssueIncluded(result, query.include)
            : []
        ),
        meta: { total },
        links: JsonApi.offsetPaginationLinks("/search", { offset, limit }, total)
      })
    )
  })
)

/**
 * Everything needed to serve the GitHub-like API: the handlers plus the
 * JSON:API protocol middleware (content negotiation + spec-compliant 400s).
 *
 * The middleware is provided *into* the handler groups (not merged alongside
 * them) so that every endpoint's middleware requirement is satisfied.
 */
export const GitHubLive = Layer.mergeAll(
  UsersLive,
  RepositoriesLive,
  IssuesLive,
  PullsLive,
  SearchLive
).pipe(Layer.provideMerge(JsonApi.Middleware.layer))
