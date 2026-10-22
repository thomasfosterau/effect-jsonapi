/**
 * The profile's sort-order rule (`docs/filter-grammar.md` §10), against a
 * canned transport: a server that sorts as the profile says must pass, and
 * each way of getting the order wrong — ignoring `sort`, NULLs on the wrong
 * end, a locale collation — must fail it, while a collection that cannot show
 * an order leaves the rule `Skipped`, never passed.
 */
import { describe, expect, it } from "vite-plus/test";
import { Array as Arr, Effect, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { MEDIA_TYPE } from "./internal/media.js";

const RULE = "profile/sort/ordering";

const Task = Resource.make("tasks", {
  attributes: {
    title: Schema.NonEmptyString,
    rank: Schema.Number,
    due: Schema.optionalKey(Schema.NullOr(Schema.String)),
  },
});

const Project = Resource.make("projects", {
  attributes: { name: Schema.NonEmptyString },
  relationships: { tasks: Relationship.many(() => Task) },
});

const api = HttpApi.make("sorting").add(
  Group.make(Task, Endpoint.list(Task, { sort: true })),
  Group.make(Project, Endpoint.related(Project, "tasks", { sort: true })),
);

type Wire = {
  readonly type: "tasks";
  readonly id: string;
  readonly attributes: Readonly<Record<string, unknown>>;
};

/**
 * Four tasks whose every attribute can show an order: `due` holds a `null`
 * and an absent member (both NULL), `title` differs only by case between two
 * of them, and `rank` ties two of them, so the `id` tiebreak decides.
 */
const TASKS: ReadonlyArray<Wire> = [
  { type: "tasks", id: "1", attributes: { title: "b", rank: 2, due: "2026-01-02T00:00:00.000Z" } },
  { type: "tasks", id: "2", attributes: { title: "a", rank: 1, due: null } },
  { type: "tasks", id: "3", attributes: { title: "c", rank: 3, due: "2026-01-01T00:00:00.000Z" } },
  { type: "tasks", id: "4", attributes: { title: "B", rank: 2 } },
];

type Value = string | number | boolean | null;

const valueOf = (task: Wire, field: string): Value => {
  const value = task.attributes[field];
  return value === undefined ? null : (value as Value);
};

/** UTF-8 byte order, which is code-point order (F-ORD-2). */
const codePointOrder = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/** Code-point order, NULL last: S-ORD-1 and S-ORD-3. */
const ascending = (left: Value, right: Value): number => {
  if (left === null || right === null) return Number(left === null) - Number(right === null);
  if (typeof left === "string" && typeof right === "string") return codePointOrder(left, right);
  return left < right ? -1 : left > right ? 1 : 0;
};

interface Sorter {
  /** Orders two values of `field` ascending; descending is its reverse (S-ORD-2). */
  readonly compare: (left: Value, right: Value, field: string) => number;
  /** The fields this server refuses to sort by, with a 400. */
  readonly refuses?: ReadonlyArray<string>;
  /** When set, `sort` is ignored altogether. */
  readonly ignores?: true;
}

const profileSorter: Sorter = { compare: (left, right) => ascending(left, right) };

/** A server ordering `tasks` by `sort` with `sorter`, lexicographically, ties broken by `id`. */
const serve =
  (sorter: Sorter, tasks: ReadonlyArray<Wire> = TASKS) =>
  (path: string): { readonly status: number; readonly body: unknown } => {
    const [pathname, search = ""] = path.split("?");
    if (pathname !== "/tasks" && pathname !== "/projects/1/tasks" && !/^\/t\d+$/.test(pathname!)) {
      return { status: 404, body: { errors: [{ status: "404" }] } };
    }
    const params = new URLSearchParams(search);
    const terms = (params.get("sort") ?? "")
      .split(",")
      .filter((term) => term !== "")
      .map((term) =>
        term.startsWith("-") ? { field: term.slice(1), sign: -1 } : { field: term, sign: 1 },
      );
    const refused = terms.find(({ field }) => sorter.refuses?.includes(field));
    if (refused !== undefined) {
      return {
        status: 400,
        body: { errors: [{ status: "400", source: { parameter: "sort" } }] },
      };
    }
    const ordered =
      sorter.ignores === true
        ? tasks
        : [...tasks].sort((a, b) => {
            for (const { field, sign } of terms) {
              const order = sign * sorter.compare(valueOf(a, field), valueOf(b, field), field);
              if (order !== 0) return order;
            }
            return ascending(a.id, b.id);
          });
    return { status: 200, body: { data: ordered } };
  };

/** The paths a run sent, in order. */
const run = async (
  answer: (path: string) => { readonly status: number; readonly body: unknown },
  target: HttpApi.HttpApi<string, any> = api,
) => {
  const sent: Array<string> = [];
  const client = HttpClient.make((request, url) =>
    Effect.sync(() => {
      const path = `${url.pathname}${url.search}`;
      sent.push(decodeURIComponent(path));
      const { status, body } = answer(path);
      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(body), { status, headers: { "content-type": MEDIA_TYPE } }),
      );
    }),
  );
  const report = await Effect.runPromise(
    Conformance.verifyWith(target, {
      client,
      baseUrl: "http://fixture.test",
      ids: { projects: "1" },
      only: [RULE],
    }),
  );
  const outcome = report.outcomes.find((candidate) => candidate.rule.id === RULE);
  if (outcome === undefined) throw new Error(`no outcome for ${RULE}`);
  return { outcome, sent };
};

const findingsOf = (outcome: Conformance.Outcome) => {
  expect(outcome._tag).toBe("Failed");
  return outcome._tag === "Failed" ? outcome.findings : [];
};

describe("Conformance: sort order (filter-grammar §10)", () => {
  it("is a profile rule citing the profile's §10", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === RULE);
    expect(rule?.tier).toBe("profile");
    expect(rule?.level).toBe("MUST");
    expect(rule?.reference).toMatch(/docs\/filter-grammar\.md#10-sort-order$/);
    expect(Conformance.gaps.map((gap) => gap.area)).not.toContain("Sort ordering correctness");
  });

  it("passes a server that sorts as the profile says, on list and related endpoints alike", async () => {
    const { outcome, sent } = await run(serve(profileSorter));
    expect(outcome).toMatchObject({ _tag: "Passed", probes: 6, note: undefined });
    // `due` holds NULLs, so it is the attribute decided — both ways — on each endpoint.
    expect(sent).toEqual([
      "/tasks",
      "/tasks?sort=due",
      "/tasks?sort=-due",
      "/projects/1/tasks",
      "/projects/1/tasks?sort=due",
      "/projects/1/tasks?sort=-due",
    ]);
  });

  it("fails a server that ignores `sort`", async () => {
    const { outcome } = await run(serve({ ...profileSorter, ignores: true }));
    const findings = findingsOf(outcome);
    expect(findings.map((found) => found.detail)).toEqual([
      '`?sort=due` lists tasks:2 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
      '`?sort=-due` lists tasks:1 ("2026-01-02T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
      '`?sort=due` lists tasks:2 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
      '`?sort=-due` lists tasks:1 ("2026-01-02T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
    ]);
    expect(findings[0]).toMatchObject({
      expected:
        "primary data in ascending order of `due` under F-ORD-1, NULLs last (S-ORD-1, S-ORD-3)",
      observed:
        '`due` in the order served: "2026-01-02T00:00:00.000Z", NULL, "2026-01-01T00:00:00.000Z", NULL',
    });
    expect(findings[0]?.probe?.url).toBe("/tasks?sort=due");
  });

  it("fails a server that ignores `sort` over a collection with no NULL", async () => {
    // Already in ascending order of `rank`, so only the descending request shows it ignored.
    const tasks = [...TASKS]
      .map((task) => ({ ...task, attributes: { rank: task.attributes["rank"] } }))
      .sort((a, b) => ascending(valueOf(a, "rank"), valueOf(b, "rank")));
    const { outcome } = await run(serve({ ...profileSorter, ignores: true }, tasks));
    expect(findingsOf(outcome).map((found) => found.detail)).toEqual([
      "`?sort=-rank` lists tasks:2 (1) before tasks:1 (2)",
      "`?sort=-rank` lists tasks:2 (1) before tasks:1 (2)",
    ]);
  });

  it("fails a server that puts NULLs first ascending and last descending", async () => {
    const nullsFirst: Sorter = {
      compare: (left, right) =>
        left === null ? (right === null ? 0 : -1) : right === null ? 1 : ascending(left, right),
    };
    const { outcome } = await run(serve(nullsFirst));
    const findings = findingsOf(outcome);
    expect(findings.map((found) => found.detail)).toEqual([
      '`?sort=due` lists tasks:4 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
      '`?sort=-due` lists tasks:3 ("2026-01-01T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
      '`?sort=due` lists tasks:4 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
      '`?sort=-due` lists tasks:3 ("2026-01-01T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
    ]);
  });

  it("fails a server that puts NULLs last both ways", async () => {
    const reversedNullsLast = (path: string) => {
      const answer = serve(profileSorter)(path);
      if (!path.includes("sort=-")) return answer;
      const data = (answer.body as { readonly data: ReadonlyArray<Wire> }).data;
      return {
        ...answer,
        body: {
          data: [
            ...data.filter((task) => valueOf(task, "due") !== null),
            ...data.filter((task) => valueOf(task, "due") === null),
          ],
        },
      };
    };
    const { outcome } = await run(reversedNullsLast);
    expect(findingsOf(outcome).map((found) => found.detail)).toEqual([
      '`?sort=-due` lists tasks:3 ("2026-01-01T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
      '`?sort=-due` lists tasks:3 ("2026-01-01T00:00:00.000Z") before tasks:2 (NULL) — a NULL sorts before every value descending (S-ORD-3)',
    ]);
  });

  it("passes over an attribute the server refuses to sort by, and notes NULL placement went unobserved", async () => {
    const { outcome, sent } = await run(serve({ ...profileSorter, refuses: ["due"] }));
    expect(outcome._tag).toBe("Passed");
    if (outcome._tag === "Passed") {
      expect(outcome.note).toBe(
        "NULL placement (S-ORD-3) not observed: no attribute decided held a NULL in its answers",
      );
    }
    expect(sent.slice(0, 6)).toEqual([
      "/tasks",
      "/tasks?sort=due",
      "/tasks?sort=title",
      "/tasks?sort=-title",
      "/tasks?sort=rank",
      "/tasks?sort=-rank",
    ]);
  });

  it("fails a server that orders strings under a locale collation (F-ORD-2)", async () => {
    const locale: Sorter = {
      refuses: ["due"],
      compare: (left, right) =>
        typeof left === "string" && typeof right === "string"
          ? left.localeCompare(right, "en", { sensitivity: "base" })
          : ascending(left, right),
    };
    const { outcome } = await run(serve(locale));
    const details = findingsOf(outcome).map((found) => found.detail);
    expect(details).toContain('`?sort=title` lists tasks:1 ("b") before tasks:4 ("B")');
  });

  it("skips, never passes, a collection that cannot show an order", async () => {
    const { outcome } = await run(serve(profileSorter, [TASKS[0]!]));
    expect(outcome).toEqual({
      _tag: "Skipped",
      rule: expect.objectContaining({ id: RULE }),
      reason:
        "no attribute's order could be observed: /tasks: no attribute shows two distinct values across its 1 resource, so no order can be observed; /projects/1/tasks: no attribute shows two distinct values across its 1 resource, so no order can be observed",
    });
  });

  it("skips when the server refuses every attribute", async () => {
    const { outcome } = await run(serve({ ...profileSorter, refuses: ["title", "rank", "due"] }));
    expect(outcome._tag).toBe("Skipped");
    if (outcome._tag === "Skipped") {
      expect(outcome.reason).toBe(
        "no attribute's order could be observed: /tasks: refused `sort` by `due`, `title`, `rank` with a 400 (not sortable there); /projects/1/tasks: refused `sort` by `due`, `title`, `rank` with a 400 (not sortable there)",
      );
    }
  });

  it("decides nothing on a server error", async () => {
    const failing = (path: string) =>
      path.includes("sort=")
        ? { status: 503, body: { errors: [{ status: "503" }] } }
        : serve(profileSorter)(path);
    const { outcome } = await run(failing);
    expect(outcome._tag).toBe("Skipped");
    if (outcome._tag === "Skipped") {
      expect(outcome.reason).toContain("`due`: `?sort=due` answered 503");
    }
  });

  it("decides nothing on an attribute whose values are of more than one JSON type (S-KEY-2)", async () => {
    const mixed: ReadonlyArray<Wire> = [
      { type: "tasks", id: "1", attributes: { title: "a" } },
      { type: "tasks", id: "2", attributes: { title: 1 } },
    ];
    const { outcome } = await run(serve(profileSorter, mixed));
    expect(outcome._tag).toBe("Skipped");
  });

  it("keeps an ascending finding when the descending request decides nothing", async () => {
    const failingDescending = (path: string) =>
      path.includes("sort=-")
        ? { status: 503, body: { errors: [{ status: "503" }] } }
        : serve({ ...profileSorter, ignores: true })(path);
    const { outcome } = await run(failingDescending);
    expect(findingsOf(outcome).map((found) => found.detail)).toEqual([
      '`?sort=due` lists tasks:2 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
      '`?sort=due` lists tasks:2 (NULL) before tasks:3 ("2026-01-01T00:00:00.000Z") — a NULL sorts after every value ascending (S-ORD-3)',
    ]);
  });

  it("stops at its request budget of 60, noting the endpoints it never probed", async () => {
    // Twenty-one list endpoints, each costing a baseline and two sorted requests.
    const many = HttpApi.make("many").add(
      ...Arr.map(
        Arr.makeBy(21, (n) => `t${n}`),
        (type) => {
          const Numbered = Resource.make(type, { attributes: { title: Schema.String } });
          return Group.make(Numbered, Endpoint.list(Numbered, { sort: true }));
        },
      ),
    );
    const { outcome, sent } = await run(serve(profileSorter), many);
    expect(sent).toHaveLength(60);
    expect(outcome).toMatchObject({
      _tag: "Passed",
      probes: 60,
      note: "not decided: /t20: not probed, the rule's 60-request budget ran out",
    });
  });

  it("skips an api with no list or related endpoint declaring `sort`", async () => {
    const unsorted = HttpApi.make("unsorted").add(Group.make(Task, Endpoint.list(Task)));
    const { outcome, sent } = await run(serve(profileSorter), unsorted);
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason: "no list or related endpoint in this api declares `sort`",
    });
    expect(sent).toEqual([]);
  });
});
