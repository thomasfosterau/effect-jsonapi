/**
 * End-to-end test of the GitHub-like API example: a real HTTP round-trip
 * (request encoding → routing → middleware → handler → response decoding)
 * through the in-memory `HttpApiTest` client.
 */
import { it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as DateTime from "effect/DateTime";
import { assert, describe, expect, expectTypeOf } from "vite-plus/test";
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Order from "effect/Order";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import { HttpApiTest, OpenApi } from "effect/http-api";
import { Client, Filter, Query, Registry } from "@thomasfosterau/effect-jsonapi";
import { Api, IssuesQuery, SearchQuery } from "../api.js";
import {
  IssueLocked,
  LabelNotFound,
  RepositoryNameTaken,
  RepositoryNotFound,
  UserNotFound,
} from "../errors.js";
import {
  bugComments,
  bugIssue,
  bugLabel,
  defunkt,
  enhancementLabel,
  featureIssue,
  GitHubLive,
  helloWorld,
  hubot,
  lockedIssue,
  octocat,
  readmePull,
  spoonKnife,
} from "../handlers.js";
import { Issue, Label, PullRequest, Repository, User } from "../resources.js";

const at = (input: string | number): Date => DateTime.toDateUtc(DateTime.makeUnsafe(input));
const now = (): Date => DateTime.toDateUtc(DateTime.nowUnsafe());

const buildClient = HttpApiTest.groups(Api, ["users", "repositories", "issues", "pulls", "search"]);

const jsonText = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

// What the effects under test read: the group services `GitHubLive` provides,
// and the platform services `HttpApiTest` names but a JSON:API never uses.
const Provided = Layer.mergeAll(GitHubLive, Registry.platformLayer);

const run = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof Provided> | Scope.Scope>,
): Effect.Effect<A, E> => effect.pipe(Effect.scoped, Effect.provide(Provided));

const runExit = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof Provided> | Scope.Scope>,
): Effect.Effect<Exit.Exit<A, E>> =>
  Effect.exit(effect.pipe(Effect.scoped, Effect.provide(Provided)));

describe("github example: fetching", () => {
  it.effect("fetches a repository document with a self link", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.get({
            params: { id: Repository.Id.make("1") },
            query: {},
          });
        }),
      );

      expect(document.data).toMatchObject({
        type: "repositories",
        id: "1",
        attributes: { name: "Hello-World", stargazerCount: 2127 },
      });
      expect(document.links?.self).toBe("/repositories/1");
      // dates decode through the wire format
      expect(document.data?.attributes.createdAt).toBeInstanceOf(Date);
    }),
  );

  it.effect("serves compound documents for ?include=owner", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.get({
            params: { id: Repository.Id.make("1") },
            query: { include: ["owner"] },
          });
        }),
      );

      expect(document.included?.map((resource) => resource.type)).toEqual(["users"]);
    }),
  );

  it.effect("omits `included` when the request carries no `include` (#232)", () =>
    Effect.gen(function* () {
      const { list, one } = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          const one = yield* client.repositories.get({
            params: { id: Repository.Id.make("1") },
            query: {},
          });
          const list = yield* client.repositories.list({ query: {} });
          return { list, one };
        }),
      );
      expect(one).not.toHaveProperty("included");
      expect(list).not.toHaveProperty("included");
    }),
  );

  it.effect("answers `?include=` with no paths with an empty `included` (#232)", () =>
    Effect.gen(function* () {
      // `include: []` goes on the wire as a bare `?include=`, which decodes to
      // `[]`: the request carried `include`, so the compound document keeps its
      // key (§Fetching Includes), empty because no path names anything to load.
      const { list, one } = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          const one = yield* client.repositories.get({
            params: { id: Repository.Id.make("1") },
            query: { include: [] },
          });
          const list = yield* client.repositories.list({ query: { include: [] } });
          return { list, one };
        }),
      );
      expect(one.included).toEqual([]);
      expect(list.included).toEqual([]);
    }),
  );

  it.effect("resolves 2-hop include paths: issue → repository → owner", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.get({
            params: { id: Issue.Id.make("1") },
            query: { include: ["repository.owner", "author", "labels"] },
          });
        }),
      );

      const types = Arr.sort(
        document.included?.map((resource) => resource.type) ?? [],
        Order.String,
      );
      // repository (intermediate), its owner + the issue's author (deduplicated users), the labels
      expect(types).toEqual(["labels", "repositories", "users", "users"]);
    }),
  );

  it.effect("narrows `included` to the requested include paths on the client", () =>
    Effect.gen(function* () {
      const include = ["owner"] as const;
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories
            .get({
              params: { id: Repository.Id.make("1") },
              query: { include },
            })
            .pipe(Client.narrowIncluded(Repository, include));
        }),
      );

      // Runtime: the server only included the requested owner
      expect(document.included?.map((resource) => resource.type)).toEqual(["users"]);
      // Types: `included` is narrowed to User — its attributes are accessible
      // without discriminating on `type`
      const owner = document.included?.[0];
      expect(owner?.attributes.login).toBe("octocat");
      assert(owner !== undefined);
      expectTypeOf(owner.attributes.login).toEqualTypeOf<string>();
      expectTypeOf(owner.type).toEqualTypeOf<"users">();
    }),
  );

  it.effect("fetches a pull request with its reviewers included", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.pulls.get({
            params: { id: PullRequest.Id.make("1") },
            query: { include: ["author", "reviewers"] },
          });
        }),
      );

      expect(document.data?.attributes.headRef).toBe("octocat:patch-1");
      // author + 2 reviewers
      expect(document.included?.filter((resource) => resource.type === "users")).toHaveLength(3);
    }),
  );

  it.effect("404s with a typed error for unknown repositories", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.get({
            params: { id: Repository.Id.make("nope") },
            query: {},
          });
        }),
      );

      assert(Exit.isFailure(exit));
      const error = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(error) && error.value instanceof RepositoryNotFound);
      expect(error.value.id).toBe("nope");
    }),
  );
});

describe("github example: listing", () => {
  it.effect("lists repositories sorted by stars with page-number pagination", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.list({
            query: {
              sort: [{ field: "stargazerCount", direction: "desc" }],
              page: { number: 1, size: 2 },
            },
          });
        }),
      );

      // most-starred first
      expect(document.data[0]?.attributes.name).toBe(spoonKnife.attributes.name);
      expect(document.data).toHaveLength(2);
      expect(document.meta?.total).toBe(3);
      expect(document.links?.next).toBe(
        "/repositories?sort=-stargazerCount&page[number]=2&page[size]=2",
      );
    }),
  );

  it.effect("filters repositories by language", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.list({
            query: { filter: { language: "TypeScript" } },
          });
        }),
      );

      expect(document.data.map((repository) => repository.attributes.name)).toEqual([
        "secret-project",
      ]);
    }),
  );

  it.effect("filters repositories by owner and visibility", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.list({
            query: { filter: { owner: octocat.id, visibility: "public" } },
          });
        }),
      );

      const names = Arr.sort(
        document.data.map((repository) => repository.attributes.name),
        Order.String,
      );
      expect(names).toEqual(["Hello-World", "Spoon-Knife"]);
    }),
  );

  it.effect("filters issues by state and repository", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.list({
            query: {
              filter: Filter.and(
                Filter.eq("state", "open"),
                Filter.eq("repository", helloWorld.id),
              ),
            },
          });
        }),
      );

      expect(document.data.map((issue) => issue.attributes.title)).toEqual([
        bugIssue.attributes.title,
      ]);
      // the closed attribute set decodes to its literal type
      Arr.forEach(document.data, (issue) => {
        expectTypeOf(issue.attributes.state).toEqualTypeOf<"open" | "closed">();
        expect(issue.attributes.state).toBe("open");
      });
    }),
  );

  it.effect(
    "evaluates an issue filter three-valued: an unassigned issue matches neither eq nor ne",
    () =>
      Effect.gen(function* () {
        const ids = (filter: Query.FilterAst<typeof Issue>) =>
          run(
            Effect.gen(function* () {
              const client = yield* buildClient;
              const document = yield* client.issues.list({ query: { filter } });
              return document.data.map((issue) => issue.id);
            }),
          );
        // bugIssue is octocat's; featureIssue and lockedIssue are unassigned.
        expect(yield* ids(Filter.eq("assignee", octocat.id))).toEqual([bugIssue.id]);
        expect(yield* ids(Filter.ne("assignee", octocat.id))).toEqual([]);
        expect(yield* ids(Filter.isNull("assignee"))).toEqual([featureIssue.id, lockedIssue.id]);
        // F-CONS-1: excluded middle does not hold where the field is NULL.
        const eq = Filter.eq("assignee", octocat.id);
        expect(yield* ids(Filter.or(eq, Filter.not(eq)))).toEqual([bugIssue.id]);
        // F-ORD-1: numbers numerically, dates as ISO-8601 text.
        expect(yield* ids(Filter.gt("number", 1000))).toEqual([bugIssue.id, featureIssue.id]);
        expect(yield* ids(Filter.lt("createdAt", lockedIssue.attributes.createdAt))).toEqual([
          bugIssue.id,
          featureIssue.id,
        ]);
        // F-AND-2: the empty groups.
        expect(yield* ids(Filter.and())).toHaveLength(3);
        expect(yield* ids(Filter.or())).toEqual([]);
      }),
  );

  it.effect("lists users sorted by login", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.users.list({
            query: { sort: [{ field: "login", direction: "asc" }] },
          });
        }),
      );

      expect(document.data.map((user) => user.attributes.login)).toEqual([
        "defunkt",
        "hubot",
        "octocat",
      ]);
    }),
  );

  it.effect("filters pull requests by state", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.pulls.list({
            query: { filter: { state: "merged" } },
          });
        }),
      );

      expect(document.data).toEqual([]);
    }),
  );
});

describe("github example: pagination links carry the request's query (#447)", () => {
  // A link's query string as the flat record the endpoint's query schema decodes.
  const searchOf = (link: string): Record<string, string> =>
    R.fromEntries(new URL(link, "https://example.test").searchParams);

  it.effect(
    "`next` on GET /issues keeps `sort`, `filter` and `include`, and continues the order",
    () =>
      Effect.gen(function* () {
        const [first, second] = yield* run(
          Effect.gen(function* () {
            const client = yield* buildClient;
            const first = yield* client.issues.list({
              query: {
                include: ["author"],
                filter: Filter.eq("state", "open"),
                sort: [{ field: "number", direction: "desc" }],
                page: { number: 1, size: 1 },
              },
            });
            const next = first.links?.next;
            assert(P.isString(next));
            const query = yield* Schema.decodeEffect(IssuesQuery)(searchOf(next));
            const second = yield* client.issues.list({ query });
            return [first, second] as const;
          }),
        );

        expect(first.links?.next).toBe(
          "/issues?include=author&filter[state]=open&sort=-number&page[number]=2&page[size]=1",
        );
        expect(first.links?.last).toMatch(
          /^\/issues\?include=author&filter\[state\]=open&sort=-number&/,
        );
        // Following `next` serves the second page of the same query, not the
        // default order: still open issues, still descending by number.
        const [top] = first.data;
        const [next] = second.data;
        assert.isDefined(top);
        assert.isDefined(next);
        expect(next.attributes.state).toBe("open");
        expect(next.attributes.number).toBeLessThan(top.attributes.number);
        expect(second.links?.prev).toBe(
          "/issues?include=author&filter[state]=open&sort=-number&page[number]=1&page[size]=1",
        );
      }),
  );

  it.effect("`next` on GET /search keeps `fields`, `filter` and `include`", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.search.search({
            query: {
              include: ["owner"],
              fields: { repositories: ["name"] },
              filter: { q: "o" },
              page: { offset: 0, limit: 1 },
            },
          });
        }),
      );

      expect(document.links?.next).toBe(
        "/search?include=owner&fields[repositories]=name&filter[q]=o&page[offset]=1&page[limit]=1",
      );
      const next = document.links?.next;
      assert(P.isString(next));
      expect(yield* Schema.decodeEffect(SearchQuery)(searchOf(next))).toEqual({
        include: ["owner"],
        fields: { repositories: ["name"] },
        filter: { q: "o" },
        page: { offset: 1, limit: 1 },
      });
    }),
  );
});

describe("github example: writing", () => {
  it.effect("creates a repository from a JSON:API payload (201) and then deletes it (204)", () =>
    run(
      Effect.gen(function* () {
        const client = yield* buildClient;

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
                createdAt: at("2024-06-01T00:00:00.000Z"),
              },
              relationships: {
                owner: { data: User.ref(octocat.id) },
              },
            },
          },
        });

        expect(created.data).not.toBeNull();
        expect(created.data?.attributes.name).toBe("my-new-repo");
        expect(created.data?.relationships?.owner.data?.id).toBe(octocat.id);

        // and delete it again
        yield* client.repositories.delete({ params: { id: created.data.id } });
      }),
    ),
  );

  it.effect("422s when the repository name is already taken by the same owner", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.create({
            payload: {
              data: {
                type: "repositories",
                attributes: {
                  name: helloWorld.attributes.name,
                  private: false,
                  stargazerCount: 0,
                  createdAt: now(),
                },
                relationships: {
                  owner: { data: User.ref(octocat.id) },
                },
              },
            },
          });
        }),
      );

      assert(Exit.isFailure(exit));
      assert(
        Option.exists(
          Cause.findErrorOption(exit.cause),
          (error) => error instanceof RepositoryNameTaken,
        ),
      );
    }),
  );

  it.effect("opens an issue against a repository (201)", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
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
                  createdAt: at("2024-06-01T00:00:00.000Z"),
                },
                relationships: {
                  repository: { data: Repository.ref(helloWorld.id) },
                  author: { data: User.ref(octocat.id) },
                  assignee: { data: null },
                  labels: { data: [] },
                },
              },
            },
          });
        }),
      );

      expect(document.data?.attributes.title).toBe("Docs are out of date");
      expect(document.data?.relationships?.repository.data?.id).toBe(helloWorld.id);
    }),
  );

  it.effect("404s when opening an issue against a missing repository", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
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
                  createdAt: now(),
                },
                relationships: {
                  repository: { data: Repository.ref("does-not-exist") },
                  // `author` is required (`one`) — null wouldn't even decode.
                  author: { data: User.ref(octocat.id) },
                  assignee: { data: null },
                  labels: { data: [] },
                },
              },
            },
          });
        }),
      );

      assert(Exit.isFailure(exit));
      assert(
        Option.exists(
          Cause.findErrorOption(exit.cause),
          (error) => error instanceof RepositoryNotFound,
        ),
      );
    }),
  );

  it.effect("404s when opening an issue with linkage to a missing label, creating nothing", () =>
    Effect.gen(function* () {
      const { before, exit, after } = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          const list = client.issues.list({ query: {} });
          const before = (yield* list).meta?.total;
          const exit = yield* Effect.exit(
            client.issues.create({
              payload: {
                data: {
                  type: "issues",
                  attributes: {
                    number: 1351,
                    title: "Mislabelled",
                    body: "",
                    state: "open",
                    locked: false,
                    createdAt: bugIssue.attributes.createdAt,
                  },
                  relationships: {
                    repository: { data: Repository.ref(helloWorld.id) },
                    author: { data: User.ref(octocat.id) },
                    assignee: { data: null },
                    labels: { data: [Label.ref(bugLabel.id), Label.ref("does-not-exist")] },
                  },
                },
              },
            }),
          );
          const after = (yield* list).meta?.total;
          return { before, exit, after };
        }),
      );

      assert(Exit.isFailure(exit));
      const error = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(error) && error.value instanceof LabelNotFound);
      expect(error.value.id).toBe("does-not-exist");
      expect(after).toBe(before);
    }),
  );

  it.effect("404s when updating an issue's labels to a missing label, leaving it unchanged", () =>
    Effect.gen(function* () {
      const { exit, labels, title } = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          const exit = yield* Effect.exit(
            client.issues.update({
              params: { id: bugIssue.id },
              payload: {
                data: {
                  type: "issues",
                  id: bugIssue.id,
                  attributes: { title: "Renamed" },
                  relationships: { labels: { data: [Label.ref("does-not-exist")] } },
                },
              },
            }),
          );
          const after = yield* client.issues.get({ params: { id: bugIssue.id }, query: {} });
          return {
            exit,
            labels: after.data?.relationships?.labels?.data,
            title: after.data?.attributes.title,
          };
        }),
      );

      assert(Exit.isFailure(exit));
      const error = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(error) && error.value instanceof LabelNotFound);
      expect(error.value.id).toBe("does-not-exist");
      // the whole update is refused, attributes included
      expect(labels).toEqual(bugIssue.relationships?.labels.data);
      expect(title).toBe(bugIssue.attributes.title);
    }),
  );

  it.effect("closes an issue with a partial update", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.update({
            params: { id: Issue.Id.make("1") },
            payload: {
              data: {
                type: "issues",
                id: Issue.Id.make("1"),
                attributes: { state: "closed" },
              },
            },
          });
        }),
      );

      expect(document.data?.attributes.state).toBe("closed");
      // other attributes are untouched
      expect(document.data?.attributes.title).toBe(bugIssue.attributes.title);
      // a write response advertises JSON:API 1.1 too, not only the reads
      expect(document.jsonapi?.version).toBe("1.1");
    }),
  );

  it.effect("403s with a typed error when updating a locked issue", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.update({
            params: { id: lockedIssue.id },
            payload: {
              data: {
                type: "issues",
                id: lockedIssue.id,
                attributes: { state: "closed" },
              },
            },
          });
        }),
      );

      assert(Exit.isFailure(exit));
      const error = Cause.findErrorOption(exit.cause);
      assert(Option.isSome(error) && error.value instanceof IssueLocked);
      expect(error.value.id).toBe(lockedIssue.id);
    }),
  );
});

describe("github example: related resource endpoints", () => {
  it.effect("GET /repositories/:id/owner serves the owning user", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.repositories.owner({
            params: { id: Repository.Id.make("1") },
            query: {},
          });
        }),
      );

      expect(document.data).toMatchObject({
        type: "users",
        id: octocat.id,
        attributes: { login: "octocat" },
      });
      expect(document.links?.self).toBe("/repositories/1/owner");
    }),
  );

  it.effect("GET /issues/:id/comments serves the paginated comment feed", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.comments({
            params: { id: bugIssue.id },
            query: { page: { number: 1, size: 2 } },
          });
        }),
      );

      // Full comment resources, paginated GitHub-style
      expect(document.data).toHaveLength(2);
      expect(document.data[0]?.attributes.body).toBe(bugComments[0].attributes.body);
      expect(document.meta?.total).toBe(3);
      expect(document.links?.next).toBe("/issues/1/comments?page[number]=2&page[size]=2");
    }),
  );

  it.effect("GET /issues/:id/comments supports compound documents (?include=author)", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.comments({
            params: { id: bugIssue.id },
            query: { include: ["author"] },
          });
        }),
      );

      // Three comments by two distinct users → two deduplicated includes
      expect(document.data).toHaveLength(3);
      const authors = Arr.sort(
        document.included?.map((resource) => resource.id) ?? [],
        Order.String,
      );
      expect(authors).toEqual(Arr.sort([octocat.id, defunkt.id], Order.String));
    }),
  );

  it.effect("issues with no comments serve an empty related collection", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.comments({
            params: { id: lockedIssue.id },
            query: {},
          });
        }),
      );

      expect(document.data).toEqual([]);
      expect(document.meta?.total).toBe(0);
    }),
  );
});

describe("github example: issue triage via relationship endpoints", () => {
  it.effect("GET /issues/:id/relationships/labels serves label linkage", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.labelsRelationship({
            params: { id: bugIssue.id },
            query: {},
          });
        }),
      );

      expect(document.data).toEqual([{ type: "labels", id: bugLabel.id }]);
      expect(document.links?.self).toBe("/issues/1/relationships/labels");
      expect(document.links?.related).toBe("/issues/1/labels");
    }),
  );

  it.effect("PATCH /issues/:id/relationships/assignee assigns a user", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          const linkage = yield* client.issues.updateAssigneeRelationship({
            params: { id: bugIssue.id },
            payload: { data: User.ref(hubot.id) },
          });
          // The issue reflects the assignment
          const issue = yield* client.issues.get({ params: { id: bugIssue.id }, query: {} });
          expect(issue.data?.relationships?.assignee?.data?.id).toBe(hubot.id);
          return linkage;
        }),
      );

      expect(document.data).toEqual({ type: "users", id: hubot.id });
    }),
  );

  it.effect("PATCH /issues/:id/relationships/assignee with null unassigns", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.updateAssigneeRelationship({
            params: { id: bugIssue.id },
            payload: { data: null },
          });
        }),
      );

      expect(document.data).toBeNull();
    }),
  );

  it.effect("404s when assigning an unknown user", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.updateAssigneeRelationship({
            params: { id: bugIssue.id },
            payload: { data: User.ref("ghost") },
          });
        }),
      );

      assert(Exit.isFailure(exit));
      assert(
        Option.exists(Cause.findErrorOption(exit.cause), (error) => error instanceof UserNotFound),
      );
    }),
  );

  it.effect.each(["updateLabelsRelationship", "addLabelsRelationship"] as const)(
    "404s when %s names a label that does not exist, leaving the labels unchanged",
    (endpoint) =>
      Effect.gen(function* () {
        const before = yield* run(
          Effect.gen(function* () {
            const client = yield* buildClient;
            return yield* client.issues.labelsRelationship({
              params: { id: featureIssue.id },
              query: {},
            });
          }),
        );
        const exit = yield* runExit(
          Effect.gen(function* () {
            const client = yield* buildClient;
            return yield* client.issues[endpoint]({
              params: { id: featureIssue.id },
              payload: { data: [Label.ref(bugLabel.id), Label.ref("no-such-label")] },
            });
          }),
        );

        assert(Exit.isFailure(exit));
        assert(
          Option.exists(
            Cause.findErrorOption(exit.cause),
            (error) => error instanceof LabelNotFound,
          ),
        );
        const after = yield* run(
          Effect.gen(function* () {
            const client = yield* buildClient;
            return yield* client.issues.labelsRelationship({
              params: { id: featureIssue.id },
              query: {},
            });
          }),
        );
        expect(after.data).toEqual(before.data);
      }),
  );

  it.effect("403s when triaging a locked issue", () =>
    Effect.gen(function* () {
      const exit = yield* runExit(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.issues.addLabelsRelationship({
            params: { id: lockedIssue.id },
            payload: { data: [Label.ref(bugLabel.id)] },
          });
        }),
      );

      assert(Exit.isFailure(exit));
      assert(
        Option.exists(Cause.findErrorOption(exit.cause), (error) => error instanceof IssueLocked),
      );
    }),
  );

  it.effect("POST adds labels, DELETE removes them, PATCH replaces them", () =>
    run(
      Effect.gen(function* () {
        const client = yield* buildClient;
        const issueId = bugIssue.id;

        // POST: add the enhancement label alongside the existing bug label
        const added = yield* client.issues.addLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(enhancementLabel.id)] },
        });
        expect(
          Arr.sort(
            added.data.map((identifier) => identifier.id),
            Order.String,
          ),
        ).toEqual(Arr.sort([bugLabel.id, enhancementLabel.id], Order.String));

        // Adding an already-present label is a no-op (spec: MUST NOT add it again)
        const addedTwice = yield* client.issues.addLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(enhancementLabel.id)] },
        });
        expect(addedTwice.data).toHaveLength(2);

        // DELETE: remove the bug label → 204
        yield* client.issues.removeLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(bugLabel.id)] },
        });
        const afterRemove = yield* client.issues.labelsRelationship({
          params: { id: issueId },
          query: {},
        });
        expect(afterRemove.data).toEqual([{ type: "labels", id: enhancementLabel.id }]);

        // PATCH: replace the full set
        const replaced = yield* client.issues.updateLabelsRelationship({
          params: { id: issueId },
          payload: { data: [Label.ref(bugLabel.id)] },
        });
        expect(replaced.data).toEqual([{ type: "labels", id: bugLabel.id }]);
      }),
    ),
  );

  it("documents relationship endpoints in OpenAPI", () => {
    const spec = OpenApi.fromApi(Api);
    // Related resource endpoints
    expect(spec.paths["/repositories/{id}/owner"]?.get).toBeDefined();
    expect(spec.paths["/issues/{id}/comments"]?.get).toBeDefined();
    // Relationship (linkage) endpoints: GET/PATCH/POST/DELETE on labels
    expect(spec.paths["/issues/{id}/relationships/labels"]?.get).toBeDefined();
    expect(spec.paths["/issues/{id}/relationships/labels"]?.patch).toBeDefined();
    expect(spec.paths["/issues/{id}/relationships/labels"]?.post).toBeDefined();
    expect(spec.paths["/issues/{id}/relationships/labels"]?.delete).toBeDefined();
    expect(spec.paths["/issues/{id}/relationships/assignee"]?.patch).toBeDefined();
    // DELETE → 204
    expect(spec.paths["/issues/{id}/relationships/labels"]?.delete?.responses).toHaveProperty(
      "204",
    );
    // Locked issues → 403 documented on triage endpoints
    expect(spec.paths["/issues/{id}/relationships/labels"]?.post?.responses).toHaveProperty("403");
  });
});

describe("github example: heterogeneous search", () => {
  it.effect(
    "returns a mixed collection of repositories, issues and users, discriminated by type",
    () =>
      Effect.gen(function* () {
        const document = yield* run(
          Effect.gen(function* () {
            const client = yield* buildClient;
            // "o" hits all three stores: "Hello-World", "Found a bug", "octocat"
            return yield* client.search.search({
              query: { filter: { q: "o" } },
            });
          }),
        );

        const types = Arr.sort(
          Arr.dedupe(document.data.map((result) => result.type)),
          Order.String,
        );
        expect(types).toEqual(["issues", "repositories", "users"]);

        // the union is discriminated by the `type` tag; the endpoint declares
        // `fields`, so a client reads each attribute as optional (#322)
        Arr.forEach(document.data, (result) => {
          if (result.type === "repositories") {
            expectTypeOf<Pick<typeof result.attributes, "stargazerCount">>().toEqualTypeOf<{
              readonly stargazerCount?: number;
            }>();
          } else if (result.type === "issues") {
            expectTypeOf<Pick<typeof result.attributes, "state">>().toEqualTypeOf<{
              readonly state?: "open" | "closed";
            }>();
          } else {
            expectTypeOf<Pick<typeof result.attributes, "login">>().toEqualTypeOf<{
              readonly login?: string;
            }>();
          }
        });
      }),
  );

  it.effect("filters across all resource types", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.search.search({
            query: { filter: { q: "spoon" } },
          });
        }),
      );

      // only the Spoon-Knife repository matches
      expect(document.data.map((result) => result.type)).toEqual(["repositories"]);
      expect(document.meta?.total).toBe(1);
    }),
  );

  it.effect("paginates heterogeneous results with links", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.search.search({
            query: { filter: { q: "" }, page: { offset: 0, limit: 2 } },
          });
        }),
      );

      expect(document.data).toHaveLength(2);
      expect(document.meta?.total).toBeGreaterThan(2);
      expect(document.links?.next).toBe("/search?filter[q]=&page[offset]=2&page[limit]=2");
    }),
  );

  it.effect("supports include across the searched resources' graphs", () =>
    Effect.gen(function* () {
      const document = yield* run(
        Effect.gen(function* () {
          const client = yield* buildClient;
          return yield* client.search.search({
            query: { filter: { q: "spoon" }, include: ["owner"] },
          });
        }),
      );

      // the matched repository's owner is included
      expect(document.included?.map((resource) => resource.type)).toEqual(["users"]);
    }),
  );
});

describe("github example: spec compliance on the wire", () => {
  it("error documents are spec-compliant JSON:API", () => {
    const wire = Schema.encodeUnknownSync(IssueLocked.wire)(new IssueLocked({ id: "3" }));
    expect(wire).toEqual({
      errors: [
        {
          status: "403",
          code: "issue_locked",
          title: "Issue is locked",
          detail: "Issue 3 is locked and cannot be modified",
          meta: { id: "3" },
        },
      ],
    });

    const taken = Schema.encodeUnknownSync(RepositoryNameTaken.wire)(
      new RepositoryNameTaken({ name: "Hello-World" }),
    );
    expect(taken).toEqual({
      errors: [
        {
          status: "422",
          code: "name_taken",
          title: "Repository name already taken",
          detail: `A repository named "Hello-World" already exists for this owner`,
          meta: { name: "Hello-World" },
        },
      ],
    });
  });

  it("OpenAPI generation reflects the JSON:API media type, statuses and query parameters", () => {
    const spec = OpenApi.fromApi(Api);
    const json = jsonText(spec);
    expect(json).toContain("application/vnd.api+json");

    // create → 201 + 422, remove → 204, fetch errors → 404, update locked → 403
    expect(spec.paths["/repositories"]?.post?.responses).toHaveProperty("201");
    expect(spec.paths["/repositories"]?.post?.responses).toHaveProperty("422");
    expect(spec.paths["/repositories/{id}"]?.delete?.responses).toHaveProperty("204");
    expect(spec.paths["/repositories/{id}"]?.get?.responses).toHaveProperty("404");
    expect(spec.paths["/issues/{id}"]?.patch?.responses).toHaveProperty("403");

    // typed query parameters are documented with their bracket names
    const listParams = spec.paths["/repositories"]?.get?.parameters?.map(
      (parameter: { readonly name: string }) => parameter.name,
    );
    expect(listParams).toContain("sort");
    expect(listParams).toContain("page[number]");
    expect(listParams).toContain("page[size]");
    expect(listParams).toContain("filter[language]");
    expect(listParams).toContain("filter[visibility]");

    // the heterogeneous search endpoint documents per-type sparse fieldsets
    const searchParams = spec.paths["/search"]?.get?.parameters?.map(
      (parameter: { readonly name: string }) => parameter.name,
    );
    expect(searchParams).toContain("filter[q]");
    expect(searchParams).toContain("fields[repositories]");
    expect(searchParams).toContain("fields[issues]");
    expect(searchParams).toContain("fields[users]");
  });

  it("sample resources decode against their own schemas (round-trip)", () => {
    const encoded = Schema.encodeUnknownSync(Repository)(helloWorld);
    expect(encoded.attributes.createdAt).toBe("2011-01-26T19:01:12.000Z");
    const decoded = Schema.decodeSync(Repository)(encoded);
    expect(decoded).toEqual(helloWorld);

    const pull = Schema.encodeUnknownSync(PullRequest)(readmePull);
    expect(pull.relationships?.reviewers.data).toHaveLength(2);
  });
});
