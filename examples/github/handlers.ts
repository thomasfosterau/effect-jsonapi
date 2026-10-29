/**
 * The GitHub-like API's handlers: vanilla `HttpApiBuilder.group` implementations
 * backed by an in-memory store, using the JSON:API document builders.
 *
 * Handlers receive fully-decoded, typed requests:
 *   - `params.id` is the resource's branded id
 *   - `query.include` / `query.fields` / `query.sort` / `query.page` /
 *     `query.filter` are typed — on `GET /issues`, which speaks the filter
 *     grammar, `query.filter` is one `Filter.Ast` root node, which the
 *     handler evaluates per the profile's semantics (`evaluate`, below)
 *   - `payload.data.attributes` is the typed create/update payload
 *   - relationship endpoints receive typed linkage payloads
 *
 * and return document values (`Handlers.data` / `Handlers.collection` /
 * `Handlers.linkage`), which are validated against the endpoint's document
 * schema on the way out. Each of those documents advertises the JSON:API
 * version it implements (`jsonapi: Document.v1_1`); the `ApiError` error
 * documents carry no `jsonapi` member. The reads that declare `fields` —
 * `GET /repositories/:id`, `GET /issues/:id` and `/search` — answer
 * `?fields[TYPE]=` by projecting each resource they carry, primary data and
 * `included` alike, with `onResource: Handlers.project(query.fields)`; the
 * other reads declare no `fields`, so their clients read every attribute as
 * required.
 */
import {
  Array as Arr,
  Effect,
  Layer,
  Match,
  Option,
  Order,
  Predicate,
  String as Str,
} from "effect";
import { HttpServerResponse } from "effect/http";
import { HttpApiBuilder } from "effect/http-api";
import { Document, Filter, Handlers, Middleware, Query } from "@thomasfosterau/effect-jsonapi";
import {
  Api,
  FilterProfile,
  IssueCommentsQuery,
  IssueCommentsRelationshipQuery,
  IssuesQuery,
  PullsQuery,
  RepositoriesQuery,
  SearchQuery,
  UsersQuery,
} from "./api.js";
import {
  IssueLocked,
  IssueNotFound,
  LabelNotFound,
  PullRequestNotFound,
  RepositoryNameTaken,
  RepositoryNotFound,
  UserNotFound,
} from "./errors.js";
import { Issue, IssueComment, Label, PullRequest, Repository, User } from "./resources.js";

/**
 * Drops every `undefined` member of a payload's `attributes`. In-process — and
 * over codec transports that preserve it — an explicit `undefined` is accepted
 * for an optional attribute, but the resource's own schema takes the key
 * absent, and under `exactOptionalPropertyTypes` the two spell differently.
 */
const definedAttributes = <A extends Record<string, unknown>>(
  attributes: A,
): { readonly [K in keyof A]: Exclude<A[K], undefined> } =>
  Object.fromEntries(Object.entries(attributes).filter(([, value]) => value !== undefined)) as {
    readonly [K in keyof A]: Exclude<A[K], undefined>;
  };

/**
 * Applies a PATCH's `attributes` over the current ones. An absent member —
 * or, in-process, an explicit `undefined` — leaves the current value; a plain
 * spread would type the result as possibly-`undefined`.
 */
const patchAttributes = <A extends Record<string, unknown>>(
  current: A,
  patch: { readonly [K in keyof A]?: A[K] | undefined } | undefined,
): A => ({ ...current, ...definedAttributes(patch ?? {}) });

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

export const octocat: User = User.make({
  id: User.Id.make("1"),
  attributes: {
    login: "octocat",
    name: "The Octocat",
    bio: "GitHub's mascot",
    createdAt: new Date("2011-01-25T18:44:36.000Z"),
  },
});

export const defunkt: User = User.make({
  id: User.Id.make("2"),
  attributes: {
    login: "defunkt",
    name: "Chris Wanstrath",
    createdAt: new Date("2007-10-20T05:24:19.000Z"),
  },
});

export const hubot: User = User.make({
  id: User.Id.make("3"),
  attributes: {
    login: "hubot",
    name: "Hubot",
    bio: "A friendly robot",
    createdAt: new Date("2011-10-25T18:00:00.000Z"),
  },
});

export const bugLabel: Label = Label.make({
  id: Label.Id.make("1"),
  attributes: { name: "bug", color: "d73a4a", description: "Something isn't working" },
});

export const enhancementLabel: Label = Label.make({
  id: Label.Id.make("2"),
  attributes: { name: "enhancement", color: "a2eeef", description: "New feature or request" },
});

export const helloWorld: Repository = Repository.make({
  id: Repository.Id.make("1"),
  attributes: {
    name: "Hello-World",
    description: "My first repository on GitHub!",
    private: false,
    language: "C",
    stargazerCount: 2127,
    createdAt: new Date("2011-01-26T19:01:12.000Z"),
  },
  relationships: {
    // `ref` builds a typed `{ type: "users", id }` resource identifier
    owner: { data: User.ref(octocat.id) },
  },
});

export const spoonKnife: Repository = Repository.make({
  id: Repository.Id.make("2"),
  attributes: {
    name: "Spoon-Knife",
    description: "This repo is for demonstration purposes only.",
    private: false,
    language: "HTML",
    stargazerCount: 12000,
    createdAt: new Date("2011-01-27T19:30:43.000Z"),
  },
  relationships: {
    owner: { data: User.ref(octocat.id) },
  },
});

export const secretProject: Repository = Repository.make({
  id: Repository.Id.make("3"),
  attributes: {
    name: "secret-project",
    private: true,
    language: "TypeScript",
    stargazerCount: 0,
    createdAt: new Date("2024-03-01T00:00:00.000Z"),
  },
  relationships: {
    owner: { data: User.ref(defunkt.id) },
  },
});

// The relationship objects of an issue's paginated comment feed: links only,
// no inline data.
const issueComments = (issueId: string) =>
  Handlers.paginatedRelationship("issues", issueId, "comments");

export const bugIssue: Issue = Issue.make({
  id: Issue.Id.make("1"),
  attributes: {
    number: 1347,
    title: "Found a bug",
    body: "I'm having a problem with this.",
    state: "open",
    locked: false,
    createdAt: new Date("2011-04-22T13:33:48.000Z"),
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(defunkt.id) },
    assignee: { data: User.ref(octocat.id) },
    labels: { data: [Label.ref(bugLabel.id)] },
    comments: issueComments("1"),
  },
});

export const featureIssue: Issue = Issue.make({
  id: Issue.Id.make("2"),
  attributes: {
    number: 1348,
    title: "Add a CONTRIBUTING guide",
    body: "New contributors need guidance.",
    state: "closed",
    locked: false,
    createdAt: new Date("2011-05-01T10:00:00.000Z"),
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(hubot.id) },
    assignee: { data: null },
    labels: { data: [Label.ref(enhancementLabel.id)] },
    comments: issueComments("2"),
  },
});

export const lockedIssue: Issue = Issue.make({
  id: Issue.Id.make("3"),
  attributes: {
    number: 42,
    title: "Tabs vs spaces",
    body: "This discussion got out of hand.",
    state: "open",
    locked: true,
    createdAt: new Date("2024-04-01T00:00:00.000Z"),
  },
  relationships: {
    repository: { data: Repository.ref(secretProject.id) },
    author: { data: User.ref(defunkt.id) },
    assignee: { data: null },
    labels: { data: [] },
    comments: issueComments("3"),
  },
});

export const bugComments: ReadonlyArray<IssueComment> = [
  IssueComment.make({
    id: IssueComment.Id.make("1"),
    attributes: {
      body: "Can you share a reproduction?",
      createdAt: new Date("2011-04-22T14:00:00.000Z"),
    },
    relationships: { author: { data: User.ref(octocat.id) } },
  }),
  IssueComment.make({
    id: IssueComment.Id.make("2"),
    attributes: {
      body: "Sure — pushed to the repro branch.",
      createdAt: new Date("2011-04-22T15:30:00.000Z"),
    },
    relationships: { author: { data: User.ref(defunkt.id) } },
  }),
  IssueComment.make({
    id: IssueComment.Id.make("3"),
    attributes: {
      body: "Thanks, I can reproduce it now.",
      createdAt: new Date("2011-04-23T09:00:00.000Z"),
    },
    relationships: { author: { data: User.ref(octocat.id) } },
  }),
];

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
    createdAt: new Date("2011-04-30T20:00:00.000Z"),
  },
  relationships: {
    repository: { data: Repository.ref(helloWorld.id) },
    author: { data: User.ref(octocat.id) },
    reviewers: { data: [User.ref(defunkt.id), User.ref(hubot.id)] },
  },
});

const store = {
  users: new Map<string, User>([octocat, defunkt, hubot].map((user) => [user.id, user])),
  labels: new Map<string, Label>([bugLabel, enhancementLabel].map((label) => [label.id, label])),
  repositories: new Map<string, Repository>(
    [helloWorld, spoonKnife, secretProject].map((repository) => [repository.id, repository]),
  ),
  issues: new Map<string, Issue>(
    [bugIssue, featureIssue, lockedIssue].map((issue) => [issue.id, issue]),
  ),
  issueComments: new Map<string, IssueComment>(bugComments.map((comment) => [comment.id, comment])),
  // The paginated comments relationship is backed by its own index, not by
  // inline linkage on the issue.
  commentsByIssue: new Map<string, Array<string>>([
    [bugIssue.id, bugComments.map((comment) => comment.id)],
    [featureIssue.id, []],
    [lockedIssue.id, []],
  ]),
  pulls: new Map<string, PullRequest>([[readmePull.id, readmePull]]),
};

const loadUser = (id: string): Effect.Effect<User, UserNotFound> => {
  const user = store.users.get(id);
  return user === undefined ? Effect.fail(new UserNotFound({ id })) : Effect.succeed(user);
};

/**
 * Removes a repository outright, bypassing the API — the cleanup a conformance
 * run's write fixture hands back (`test/conformance.test.ts`).
 */
export const discardRepository = (id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    store.repositories.delete(id);
  });

/**
 * Removes an issue outright, bypassing the API — issues have no DELETE
 * endpoint, so this is the only way a conformance run's created issues go.
 */
export const discardIssue = (id: string): Effect.Effect<void> =>
  Effect.sync(() => {
    store.issues.delete(id);
    store.commentsByIssue.delete(id);
  });

const loadRepository = (id: string): Effect.Effect<Repository, RepositoryNotFound> => {
  const repository = store.repositories.get(id);
  return repository === undefined
    ? Effect.fail(new RepositoryNotFound({ id }))
    : Effect.succeed(repository);
};

const loadIssue = (id: string): Effect.Effect<Issue, IssueNotFound> => {
  const issue = store.issues.get(id);
  return issue === undefined ? Effect.fail(new IssueNotFound({ id })) : Effect.succeed(issue);
};

const loadUnlockedIssue = (id: string): Effect.Effect<Issue, IssueNotFound | IssueLocked> =>
  loadIssue(id).pipe(
    Effect.flatMap((issue) =>
      issue.attributes.locked
        ? Effect.fail(new IssueLocked({ id: issue.id }))
        : Effect.succeed(issue),
    ),
  );

/**
 * Fails with `LabelNotFound` for the first identifier the store holds no label
 * for — a relationship write naming a label that does not exist answers 404
 * (JSON:API §Updating Relationships) rather than linking it.
 */
const requireLabels = (
  identifiers: ReadonlyArray<{ readonly id: string }>,
): Effect.Effect<void, LabelNotFound> => {
  const missing = identifiers.find((identifier) => !store.labels.has(identifier.id));
  return missing === undefined ? Effect.void : Effect.fail(new LabelNotFound({ id: missing.id }));
};

const loadPull = (id: string): Effect.Effect<PullRequest, PullRequestNotFound> => {
  const pull = store.pulls.get(id);
  return pull === undefined ? Effect.fail(new PullRequestNotFound({ id })) : Effect.succeed(pull);
};

// ---------------------------------------------------------------------------
// Include resolution & shared helpers
// ---------------------------------------------------------------------------

// Resolve the resources referenced by the requested include paths.

const resolveRepositoryIncluded = (
  repository: Repository,
  include: ReadonlyArray<string> | undefined,
): Array<User> => {
  const included: Array<User> = [];
  if (include?.includes("owner")) {
    const owner = repository.relationships?.owner.data;
    if (owner !== undefined && store.users.has(owner.id)) included.push(store.users.get(owner.id)!);
  }
  return included;
};

const resolveIssueIncluded = (
  issue: Issue,
  include: ReadonlyArray<string> | undefined,
): Array<Repository | User | Label> => {
  const included: Array<Repository | User | Label> = [];
  if (include === undefined) return included;
  if (include.some((path) => path === "repository" || path === "repository.owner")) {
    const ref = issue.relationships?.repository.data;
    const repository = ref !== undefined ? store.repositories.get(ref.id) : undefined;
    if (repository !== undefined) {
      included.push(repository);
      if (include.includes("repository.owner")) {
        included.push(...resolveRepositoryIncluded(repository, ["owner"]));
      }
    }
  }
  for (const key of ["author", "assignee"] as const) {
    if (include.includes(key)) {
      const ref = issue.relationships?.[key].data;
      if (ref != null && store.users.has(ref.id)) included.push(store.users.get(ref.id)!);
    }
  }
  if (include.includes("labels")) {
    for (const ref of issue.relationships?.labels.data ?? []) {
      const label = store.labels.get(ref.id);
      if (label !== undefined) included.push(label);
    }
  }
  return included;
};

const resolvePullIncluded = (
  pull: PullRequest,
  include: ReadonlyArray<string> | undefined,
): Array<Repository | User> => {
  const included: Array<Repository | User> = [];
  if (include === undefined) return included;
  if (include.some((path) => path === "repository" || path === "repository.owner")) {
    const ref = pull.relationships?.repository.data;
    const repository = ref !== undefined ? store.repositories.get(ref.id) : undefined;
    if (repository !== undefined) {
      included.push(repository);
      if (include.includes("repository.owner")) {
        included.push(...resolveRepositoryIncluded(repository, ["owner"]));
      }
    }
  }
  if (include.includes("author")) {
    const ref = pull.relationships?.author.data;
    if (ref !== undefined && store.users.has(ref.id)) included.push(store.users.get(ref.id)!);
  }
  if (include.includes("reviewers")) {
    for (const ref of pull.relationships?.reviewers.data ?? []) {
      const reviewer = store.users.get(ref.id);
      if (reviewer !== undefined) included.push(reviewer);
    }
  }
  return included;
};

// Apply `?sort=` terms (already decoded to `{ field, direction }`) in order.
const sortBy = <A extends { readonly attributes: any }>(
  items: Array<A>,
  sort: ReadonlyArray<{ readonly field: string; readonly direction: "asc" | "desc" }> | undefined,
): Array<A> => {
  for (const term of [...(sort ?? [])].reverse()) {
    const direction = term.direction === "desc" ? -1 : 1;
    items.sort((a, b) => {
      const left = a.attributes[term.field];
      const right = b.attributes[term.field];
      return (left < right ? -1 : left > right ? 1 : 0) * direction;
    });
  }
  return items;
};

// One page of a collection, with the collection's size and the window it shows.
interface Page<A> {
  readonly page: ReadonlyArray<A>;
  readonly total: number;
  readonly number: number;
  readonly size: number;
}

// Apply `?page[number]=&page[size]=` pagination.
const paginate = <A>(
  items: ReadonlyArray<A>,
  page: { readonly number?: number; readonly size?: number } | undefined,
): Page<A> => {
  const total = items.length;
  const size = page?.size ?? Math.max(total, 1);
  const number = page?.number ?? 1;
  return { page: items.slice((number - 1) * size, number * size), total, number, size };
};

// ---------------------------------------------------------------------------
// The filter grammar's semantics (docs/filter-grammar.md §6)
// ---------------------------------------------------------------------------
//
// The package decodes `GET /issues?filter[…]` into one `Filter.Ast` root node
// and evaluates none (§6.9): the handler does, against its store. A store
// that is SQL gets most of §6 for free; this one is an array, so the handler
// spells §6 out — three truth values, Kleene's connectives, every comparison
// against NULL UNKNOWN, and the order of each field's JSON value.

/** §6.3: the three truth values. */
type Truth = "TRUE" | "FALSE" | "UNKNOWN";

/** §6.2 F-ORD-1: every filterable value, and every literal, is a JSON scalar. */
type Scalar = string | number | boolean;

/** The decoded filter `GET /issues` receives, and the fields it may name. */
type IssueFilter = Query.FilterAst<typeof Issue>;
type IssueField = Extract<IssueFilter, { readonly _tag: "Compare" }>["field"];

/** A value in its JSON form, the one F-ORD-1 compares on: a `Date` as its ISO-8601 text. */
const toJson = (value: Scalar | Date): Scalar =>
  Predicate.isDate(value) ? value.toISOString() : value;

/**
 * §6.1 F-EVAL-4: an attribute's JSON value, or a to-one relationship's related
 * id; NULL for an absent member and for empty linkage (an unassigned issue).
 */
const valueOf = (issue: Issue, field: IssueField): Option.Option<Scalar> =>
  field === "repository" || field === "author" || field === "assignee"
    ? Option.fromNullishOr(issue.relationships?.[field].data?.id)
    : Option.some(toJson(issue.attributes[field]));

/** F-ORD-2: strings in code-point order — no locale, no case folding. */
const codePointOrder = Order.mapInput(Arr.makeOrder(Order.Number), (text: string) =>
  Arr.map(Array.from(text), (char) => char.codePointAt(0) ?? 0),
);

/** F-ORD-1: numbers numerically, `false < true`, strings by code point. */
const compareJson = (value: Scalar, literal: Scalar): number =>
  Predicate.isString(value) && Predicate.isString(literal)
    ? codePointOrder(value, literal)
    : Number(value) - Number(literal);

const truth = (holds: boolean): Truth => (holds ? "TRUE" : "FALSE");

/** F-CMP-2: each operator's relation on a non-NULL value's order. */
const RELATIONS = {
  eq: (order: number) => order === 0,
  ne: (order: number) => order !== 0,
  lt: (order: number) => order < 0,
  lte: (order: number) => order <= 0,
  gt: (order: number) => order > 0,
  gte: (order: number) => order >= 0,
} as const satisfies { readonly [Op in Filter.CompareOperator]: (order: number) => boolean };

/** F-CMP-1 / F-CMP-2: UNKNOWN against NULL, else the two-valued relation. */
const comparison = (
  op: Filter.CompareOperator,
  value: Option.Option<Scalar>,
  literal: Scalar | Date,
): Truth =>
  Option.match(
    Option.map(value, (present) => compareJson(present, toJson(literal))),
    {
      onNone: (): Truth => "UNKNOWN",
      onSome: (order) => truth(RELATIONS[op](order)),
    },
  );

/** A fold of `table` over `truths` from `identity`: F-IN-1, and F-AND-1 / F-AND-2. */
const fold = (
  table: { readonly [A in Truth]: { readonly [B in Truth]: Truth } },
  identity: Truth,
  truths: ReadonlyArray<Truth>,
): Truth => Arr.reduce(truths, identity, (acc, next) => table[acc][next]);

/** F-LOGIC-1: Kleene's strong connectives. */
const AND = {
  TRUE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  FALSE: { TRUE: "FALSE", FALSE: "FALSE", UNKNOWN: "FALSE" },
  UNKNOWN: { TRUE: "UNKNOWN", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
} as const satisfies { readonly [A in Truth]: { readonly [B in Truth]: Truth } };
const OR = {
  TRUE: { TRUE: "TRUE", FALSE: "TRUE", UNKNOWN: "TRUE" },
  FALSE: { TRUE: "TRUE", FALSE: "FALSE", UNKNOWN: "UNKNOWN" },
  UNKNOWN: { TRUE: "TRUE", FALSE: "UNKNOWN", UNKNOWN: "UNKNOWN" },
} as const satisfies { readonly [A in Truth]: { readonly [B in Truth]: Truth } };
const NOT = { TRUE: "FALSE", FALSE: "TRUE", UNKNOWN: "UNKNOWN" } as const satisfies {
  readonly [A in Truth]: Truth;
};

/** F-IN-1: a disjunction of equalities. */
const membership = (value: Option.Option<Scalar>, literals: ReadonlyArray<Scalar | Date>): Truth =>
  fold(
    OR,
    "FALSE",
    Arr.map(literals, (literal) => comparison("eq", value, literal)),
  );

/** §6.3: a filter tree's truth value for one issue. */
const evaluate = (node: IssueFilter, issue: Issue): Truth =>
  Match.valueTags(node, {
    Compare: ({ op, field, value }) => comparison(op, valueOf(issue, field), value),
    In: ({ field, values }) => membership(valueOf(issue, field), values),
    // F-IN-2: the negation of F-IN-1.
    NotIn: ({ field, values }) => NOT[membership(valueOf(issue, field), values)],
    // F-ISNULL-1 / F-ISNULL-2: total, never UNKNOWN.
    IsNull: ({ field, negated }) => truth(Option.isNone(valueOf(issue, field)) !== negated),
    // F-AND-1 / F-AND-2: the folds, `And([])` TRUE and `Or([])` FALSE.
    And: ({ members }) =>
      fold(
        AND,
        "TRUE",
        Arr.map(members, (member) => evaluate(member, issue)),
      ),
    Or: ({ members }) =>
      fold(
        OR,
        "FALSE",
        Arr.map(members, (member) => evaluate(member, issue)),
      ),
    // F-NOT-1.
    Not: ({ member }) => NOT[evaluate(member, issue)],
  });

/**
 * §6.1 F-EVAL-3: an issue is in the primary data iff the tree is TRUE for it —
 * FALSE and UNKNOWN both exclude. An absent `filter` is no constraint (F-ERR-3).
 */
const matching = (issues: ReadonlyArray<Issue>, filter: Option.Option<IssueFilter>) =>
  Option.match(filter, {
    onNone: () => [...issues],
    onSome: (tree) => Arr.filter(issues, (issue) => evaluate(tree, issue) === "TRUE"),
  });

/** The media type of an answer from an endpoint speaking the grammar (§5). */
const PROFILED_MEDIA_TYPE = `application/vnd.api+json; profile="${Filter.PROFILE_URI}"`;

/**
 * The live {@link FilterProfile}: names the profile on the media type of every
 * JSON:API answer from the endpoints it is attached to (`GET /issues`).
 */
export const FilterProfileLive: Layer.Layer<FilterProfile> = Layer.succeed(
  FilterProfile,
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      Option.exists(
        Option.fromNullishOr(response.headers["content-type"]),
        Str.startsWith("application/vnd.api+json"),
      )
        ? HttpServerResponse.setHeader(response, "content-type", PROFILED_MEDIA_TYPE)
        : response,
    ),
);

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export const UsersLive = HttpApiBuilder.group(Api, "users", (handlers) =>
  handlers
    .handle("get", ({ params }) =>
      loadUser(params.id).pipe(
        Effect.map((user) =>
          Handlers.data(user, { self: `/users/${user.id}`, jsonapi: Document.v1_1 }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      const users = sortBy([...store.users.values()], query.sort);
      const { number, page, size, total } = paginate(users, query.page);
      return Effect.succeed(
        Handlers.collection(page, {
          meta: { total },
          links: Handlers.numberPaginationLinks("/users", { number, size }, total, {
            query: Query.canonicalPairs(UsersQuery)(query),
          }),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

export const RepositoriesLive = HttpApiBuilder.group(Api, "repositories", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) =>
          Handlers.data(repository, {
            included:
              query.include === undefined
                ? undefined
                : resolveRepositoryIncluded(repository, query.include),
            self: `/repositories/${repository.id}`,
            onResource: Handlers.project(query.fields),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let repositories = [...store.repositories.values()];

      // filter[owner]=<user id>
      const owner = query.filter?.owner;
      if (owner !== undefined) {
        repositories = repositories.filter(
          (repository) => repository.relationships?.owner.data.id === owner,
        );
      }
      // filter[language]=TypeScript
      const language = query.filter?.language;
      if (language !== undefined) {
        repositories = repositories.filter(
          (repository) => repository.attributes.language === language,
        );
      }
      // filter[visibility]=public|private
      const visibility = query.filter?.visibility;
      if (visibility !== undefined) {
        repositories = repositories.filter(
          (repository) => repository.attributes.private === (visibility === "private"),
        );
      }

      sortBy(repositories, query.sort);
      const { number, page, size, total } = paginate(repositories, query.page);

      return Effect.succeed(
        Handlers.collection(page, {
          included:
            query.include === undefined
              ? undefined
              : page.flatMap((repository) => resolveRepositoryIncluded(repository, query.include)),
          meta: { total },
          links: Handlers.numberPaginationLinks("/repositories", { number, size }, total, {
            query: Query.canonicalPairs(RepositoriesQuery)(query),
          }),
          jsonapi: Document.v1_1,
        }),
      );
    })
    .handle("create", ({ payload }) => {
      const name = payload.data.attributes.name;
      // `owner` is a required (`one`) relationship — the payload always carries it.
      const owner = payload.data.relationships.owner.data.id;
      for (const existing of store.repositories.values()) {
        if (existing.attributes.name === name && existing.relationships?.owner.data.id === owner) {
          return Effect.fail(new RepositoryNameTaken({ name }));
        }
      }
      const repository = Repository.make({
        id: Repository.Id.make(`${store.repositories.size + 1}`),
        attributes: definedAttributes(payload.data.attributes),
        relationships: payload.data.relationships,
      });
      store.repositories.set(repository.id, repository);
      // The created resource carries its own `self` link: the 201's `Location`
      // header is copied from it, so the two match.
      const self = `/repositories/${repository.id}`;
      return Effect.succeed(
        Handlers.data({ ...repository, links: { self } }, { self, jsonapi: Document.v1_1 }),
      );
    })
    .handle("update", ({ params, payload }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) => {
          const updated = Repository.make({
            ...repository,
            attributes: patchAttributes(repository.attributes, payload.data.attributes),
            relationships: {
              owner: payload.data.relationships?.owner ?? repository.relationships!.owner,
            },
          });
          store.repositories.set(updated.id, updated);
          return Handlers.data(updated, {
            self: `/repositories/${updated.id}`,
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    .handle("delete", ({ params }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) => {
          store.repositories.delete(repository.id);
        }),
      ),
    )
    // GET /repositories/:id/owner — the related user as a full resource
    .handle("owner", ({ params }) =>
      loadRepository(params.id).pipe(
        Effect.map((repository) => {
          const owner = store.users.get(repository.relationships!.owner.data.id) ?? null;
          return Handlers.data(owner, {
            self: Handlers.relatedLink("repositories", repository.id, "owner"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

// The comments attached to an issue, via the relationship index.
const commentsFor = (issueId: string): Array<IssueComment> =>
  (store.commentsByIssue.get(issueId) ?? []).flatMap((commentId) => {
    const comment = store.issueComments.get(commentId);
    return comment === undefined ? [] : [comment];
  });

export const IssuesLive = HttpApiBuilder.group(Api, "issues", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadIssue(params.id).pipe(
        Effect.map((issue) =>
          Handlers.data(issue, {
            included:
              query.include === undefined ? undefined : resolveIssueIncluded(issue, query.include),
            self: `/issues/${issue.id}`,
            onResource: Handlers.project(query.fields),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      // filter[state]=open&filter[repository]=1, filter[assignee][isnull]=true,
      // filter[number][gt]=1000, an `OR` group, … — the grammar, evaluated per §6.
      const issues = matching([...store.issues.values()], Option.fromUndefinedOr(query.filter));

      sortBy(issues, query.sort);
      const { number, page, size, total } = paginate(issues, query.page);

      return Effect.succeed(
        Handlers.collection(page, {
          included:
            query.include === undefined
              ? undefined
              : page.flatMap((issue) => resolveIssueIncluded(issue, query.include)),
          meta: { total },
          links: Handlers.numberPaginationLinks("/issues", { number, size }, total, {
            query: Query.canonicalPairs(IssuesQuery)(query),
          }),
          jsonapi: Document.v1_1,
        }),
      );
    })
    .handle("create", ({ payload }) => {
      // `repository` and `author` are required (`one`) relationships — the
      // payload always carries them; the repository must also exist.
      const repository = payload.data.relationships.repository.data;
      if (!store.repositories.has(repository.id)) {
        return Effect.fail(new RepositoryNotFound({ id: repository.id }));
      }
      // Linkage naming a label the store does not hold answers 404 (JSON:API
      // §Creating Resources) rather than creating the issue with it.
      return requireLabels(payload.data.relationships.labels?.data ?? []).pipe(
        Effect.map(() => {
          const id = Issue.Id.make(`${store.issues.size + 1}`);
          const issue = Issue.make({
            id,
            attributes: definedAttributes(payload.data.attributes),
            relationships: {
              repository: payload.data.relationships.repository,
              author: payload.data.relationships.author,
              assignee: payload.data.relationships.assignee ?? { data: null },
              labels: payload.data.relationships.labels ?? { data: [] },
              // The paginated comment feed starts empty; only its links exist.
              comments: issueComments(id),
            },
          });
          store.issues.set(issue.id, issue);
          store.commentsByIssue.set(issue.id, []);
          // The created resource carries its own `self` link: the 201's
          // `Location` header is copied from it, so the two match.
          const self = `/issues/${issue.id}`;
          return Handlers.data({ ...issue, links: { self } }, { self, jsonapi: Document.v1_1 });
        }),
      );
    })
    .handle("update", ({ params, payload }) =>
      loadUnlockedIssue(params.id).pipe(
        // Linkage naming an absent label answers 404 (JSON:API §Updating
        // Resources) and leaves the issue unchanged.
        Effect.tap(() => requireLabels(payload.data.relationships?.labels?.data ?? [])),
        Effect.map((issue) => {
          const relationships = issue.relationships!;
          const updated = Issue.make({
            ...issue,
            attributes: patchAttributes(issue.attributes, payload.data.attributes),
            relationships: {
              repository: payload.data.relationships?.repository ?? relationships.repository,
              author: payload.data.relationships?.author ?? relationships.author,
              assignee: payload.data.relationships?.assignee ?? relationships.assignee,
              labels: payload.data.relationships?.labels ?? relationships.labels,
              comments: relationships.comments,
            },
          });
          store.issues.set(updated.id, updated);
          return Handlers.data(updated, { self: `/issues/${updated.id}`, jsonapi: Document.v1_1 });
        }),
      ),
    )
    // --- Related resource endpoints -----------------------------------------
    // GET /issues/:id/comments — the paginated comment feed
    .handle("comments", ({ params, query }) =>
      loadIssue(params.id).pipe(
        Effect.map((issue) => {
          const all = commentsFor(issue.id);
          const { number, page, size, total } = paginate(all, query.page);
          const path = Handlers.relatedLink("issues", issue.id, "comments");
          return Handlers.collection(page, {
            included:
              query.include === undefined
                ? undefined
                : query.include.includes("author")
                  ? page.flatMap((comment) => {
                      const author = store.users.get(comment.relationships!.author.data.id);
                      return author === undefined ? [] : [author];
                    })
                  : [],
            meta: { total },
            links: Handlers.numberPaginationLinks(path, { number, size }, total, {
              query: Query.canonicalPairs(IssueCommentsQuery)(query),
            }),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // --- Relationship (linkage) endpoints ------------------------------------
    // GET /issues/:id/relationships/comments — the comment feed's identifiers
    .handle("commentsRelationship", ({ params, query }) =>
      loadIssue(params.id).pipe(
        Effect.map((issue) => {
          const all = commentsFor(issue.id).map((comment) => IssueComment.ref(comment.id));
          const { number, page, size, total } = paginate(all, query.page);
          const path = Handlers.relationshipLink("issues", issue.id, "comments");
          return Handlers.linkage(page, {
            related: Handlers.relatedLink("issues", issue.id, "comments"),
            meta: { total },
            links: Handlers.numberPaginationLinks(path, { number, size }, total, {
              query: Query.canonicalPairs(IssueCommentsRelationshipQuery)(query),
            }),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // GET /issues/:id/relationships/labels
    .handle("labelsRelationship", ({ params }) =>
      loadIssue(params.id).pipe(
        Effect.map((issue) =>
          Handlers.linkage(issue.relationships?.labels.data ?? [], {
            self: Handlers.relationshipLink("issues", issue.id, "labels"),
            related: Handlers.relatedLink("issues", issue.id, "labels"),
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    // PATCH /issues/:id/relationships/assignee — assign or unassign
    .handle("updateAssigneeRelationship", ({ params, payload }) =>
      loadUnlockedIssue(params.id).pipe(
        Effect.flatMap((issue) => {
          if (payload.data !== null && !store.users.has(payload.data.id)) {
            return Effect.fail(new UserNotFound({ id: payload.data.id }));
          }
          const updated = Issue.make({
            ...issue,
            relationships: { ...issue.relationships!, assignee: { data: payload.data } },
          });
          store.issues.set(updated.id, updated);
          return Effect.succeed(
            Handlers.linkage(payload.data, {
              self: Handlers.relationshipLink("issues", issue.id, "assignee"),
              jsonapi: Document.v1_1,
            }),
          );
        }),
      ),
    )
    // PATCH /issues/:id/relationships/labels — replace all labels
    .handle("updateLabelsRelationship", ({ params, payload }) =>
      loadUnlockedIssue(params.id).pipe(
        Effect.tap(() => requireLabels(payload.data)),
        Effect.map((issue) => {
          const updated = Issue.make({
            ...issue,
            relationships: { ...issue.relationships!, labels: { data: payload.data } },
          });
          store.issues.set(updated.id, updated);
          return Handlers.linkage(payload.data, {
            self: Handlers.relationshipLink("issues", issue.id, "labels"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // POST /issues/:id/relationships/labels — add labels
    .handle("addLabelsRelationship", ({ params, payload }) =>
      loadUnlockedIssue(params.id).pipe(
        Effect.tap(() => requireLabels(payload.data)),
        Effect.map((issue) => {
          const existing = issue.relationships?.labels.data ?? [];
          const known = new Set<string>(existing.map((identifier) => identifier.id));
          const added = [
            ...existing,
            ...payload.data.filter((identifier) => !known.has(identifier.id)),
          ];
          const updated = Issue.make({
            ...issue,
            relationships: { ...issue.relationships!, labels: { data: added } },
          });
          store.issues.set(updated.id, updated);
          return Handlers.linkage(added, {
            self: Handlers.relationshipLink("issues", issue.id, "labels"),
            jsonapi: Document.v1_1,
          });
        }),
      ),
    )
    // DELETE /issues/:id/relationships/labels — remove labels → 204
    .handle("removeLabelsRelationship", ({ params, payload }) =>
      loadUnlockedIssue(params.id).pipe(
        Effect.map((issue) => {
          const remove = new Set<string>(payload.data.map((identifier) => identifier.id));
          const remaining = (issue.relationships?.labels.data ?? []).filter(
            (identifier) => !remove.has(identifier.id),
          );
          const updated = Issue.make({
            ...issue,
            relationships: { ...issue.relationships!, labels: { data: remaining } },
          });
          store.issues.set(updated.id, updated);
        }),
      ),
    ),
);

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const PullsLive = HttpApiBuilder.group(Api, "pulls", (handlers) =>
  handlers
    .handle("get", ({ params, query }) =>
      loadPull(params.id).pipe(
        Effect.map((pull) =>
          Handlers.data(pull, {
            included:
              query.include === undefined ? undefined : resolvePullIncluded(pull, query.include),
            self: `/pulls/${pull.id}`,
            jsonapi: Document.v1_1,
          }),
        ),
      ),
    )
    .handle("list", ({ query }) => {
      let pulls = [...store.pulls.values()];

      const repository = query.filter?.repository;
      if (repository !== undefined) {
        pulls = pulls.filter((pull) => pull.relationships?.repository.data.id === repository);
      }
      const state = query.filter?.state;
      if (state !== undefined) {
        pulls = pulls.filter((pull) => pull.attributes.state === state);
      }

      sortBy(pulls, query.sort);
      const { number, page, size, total } = paginate(pulls, query.page);

      return Effect.succeed(
        Handlers.collection(page, {
          included:
            query.include === undefined
              ? undefined
              : page.flatMap((pull) => resolvePullIncluded(pull, query.include)),
          meta: { total },
          links: Handlers.numberPaginationLinks("/pulls", { number, size }, total, {
            query: Query.canonicalPairs(PullsQuery)(query),
          }),
          jsonapi: Document.v1_1,
        }),
      );
    }),
);

// ---------------------------------------------------------------------------
// Search — a heterogeneous collection of repositories, issues and users
// ---------------------------------------------------------------------------

const matches = (haystack: ReadonlyArray<string | undefined>, needle: string): boolean =>
  haystack.some(
    (value) => value !== undefined && value.toLowerCase().includes(needle.toLowerCase()),
  );

export const SearchLive = HttpApiBuilder.group(Api, "search", (handlers) =>
  handlers.handle("search", ({ query }) => {
    const q = query.filter?.q ?? "";

    // search across all three resource types; results stay discriminated by `type`
    const repositories = [...store.repositories.values()].filter((repository) =>
      matches([repository.attributes.name, repository.attributes.description], q),
    );
    const issues = [...store.issues.values()].filter((issue) =>
      matches([issue.attributes.title, issue.attributes.body], q),
    );
    const users = [...store.users.values()].filter((user) =>
      matches([user.attributes.login, user.attributes.name], q),
    );
    const results = [...repositories, ...issues, ...users];

    const total = results.length;
    const offset = query.page?.offset ?? 0;
    const limit = query.page?.limit ?? Math.max(total, 1);
    const page = results.slice(offset, offset + limit);

    return Effect.succeed(
      Handlers.collection(page, {
        included:
          query.include === undefined
            ? undefined
            : page.flatMap((result) =>
                result.type === "repositories"
                  ? resolveRepositoryIncluded(result, query.include)
                  : result.type === "issues"
                    ? resolveIssueIncluded(result, query.include)
                    : [],
              ),
        meta: { total },
        links: Handlers.offsetPaginationLinks("/search", { offset, limit }, total, {
          query: Query.canonicalPairs(SearchQuery)(query),
        }),
        onResource: Handlers.project(query.fields),
        jsonapi: Document.v1_1,
      }),
    );
  }),
);

/**
 * Everything needed to serve the GitHub-like API: the handlers plus the
 * JSON:API protocol middleware (content negotiation + spec-compliant 400s),
 * and the filter grammar's profile advertisement on `GET /issues`.
 *
 * The middleware is provided *into* the handler groups (not merged alongside
 * them) so that every endpoint's middleware requirement is satisfied.
 */
export const GitHubLive = Layer.mergeAll(
  UsersLive,
  RepositoriesLive,
  IssuesLive,
  PullsLive,
  SearchLive,
).pipe(Layer.provideMerge(Layer.mergeAll(Middleware.layer, FilterProfileLive)));
