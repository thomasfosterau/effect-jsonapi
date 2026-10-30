/**
 * The profile's sort rules (`docs/filter-grammar.md` §10), against a canned
 * transport: a server that sorts as the profile says must pass, and each way
 * of getting the order wrong — ignoring `sort`, NULLs on the wrong end, a
 * locale collation, a second term ignored, ties broken by reversing the
 * answer, pages sorted one at a time — must fail its rule, while a collection
 * that cannot show what a rule checks leaves it `Skipped`, never passed.
 */
import { assert, describe, expect, it } from "vite-plus/test";
import { Array as Arr, Effect, Predicate, Schema } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { HttpApi } from "effect/http-api";
import * as Conformance from "./Conformance.js";
import * as Endpoint from "./Endpoint.js";
import * as Group from "./Group.js";
import * as Query from "./Query.js";
import * as Relationship from "./Relationship.js";
import * as Resource from "./Resource.js";
import { orderOf } from "./internal/filter.js";
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
  Group.make(Task, Endpoint.list(Task, { sort: true, page: Query.Page.Offset })),
  Group.make(Project, Endpoint.related(Project, "tasks", { sort: true })),
);

const unpagedApi = HttpApi.make("unpaged").add(
  Group.make(Task, Endpoint.list(Task, { sort: true })),
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
  /** When set, only the first term of `sort` is applied. */
  readonly firstTermOnly?: true;
  /** When set, the first term's direction is applied to every term. */
  readonly oneDirection?: true;
  /** When set, `-f` is answered as `f`, ties broken by `id`, then reversed whole. */
  readonly reverses?: true;
  /** When set, `page[limit]` is ignored: the whole collection is one page. */
  readonly unpaged?: true;
  /** When set, a page is cut from the collection unsorted, then sorted. */
  readonly sortsEachPage?: true;
}

const profileSorter: Sorter = { compare: (left, right) => ascending(left, right) };

/** What the canned server answers a request with. */
interface Answer {
  readonly status: number;
  readonly body: unknown;
}

interface Ordering {
  readonly field: string;
  readonly sign: number;
}

/** `rows` ordered by `terms` with `sorter`, lexicographically, ties broken by `id` ascending. */
const ordered = (
  sorter: Sorter,
  rows: ReadonlyArray<Wire>,
  terms: ReadonlyArray<Ordering>,
): ReadonlyArray<Wire> => {
  if (sorter.ignores === true) return rows;
  // Reversing the ascending answer for a leading `-` is the bug S-TIE-2 rules out.
  const reversed = sorter.reverses === true && terms[0]?.sign === -1;
  const flip = reversed ? -1 : 1;
  const applied = (sorter.firstTermOnly === true ? terms.slice(0, 1) : terms).map(
    ({ field, sign }) => ({
      field,
      sign: flip * (sorter.oneDirection === true ? (terms[0]?.sign ?? sign) : sign),
    }),
  );
  const sorted = Arr.sort(
    rows,
    orderOf<(typeof rows)[number]>((a, b) => {
      for (const { field, sign } of applied) {
        const order = sign * sorter.compare(valueOf(a, field), valueOf(b, field), field);
        if (order !== 0) return order;
      }
      return ascending(a.id, b.id);
    }),
  );
  return reversed ? sorted.toReversed() : sorted;
};

/**
 * A server ordering `tasks` by `sort` with `sorter`, and paging `/tasks` by
 * `page[offset]` / `page[limit]` when a limit is asked for, with a `next`
 * link on every page but the last.
 */
/** The terms of a `sort` value, in order. */
const termsOf = (sort: string): ReadonlyArray<Ordering> =>
  sort
    .split(",")
    .filter((term) => term !== "")
    .map((term) =>
      term.startsWith("-") ? { field: term.slice(1), sign: -1 } : { field: term, sign: 1 },
    );

const refusal: Answer = {
  status: 400,
  body: { errors: [{ status: "400", source: { parameter: "sort" } }] },
};

/** One page of `tasks` at `page[offset]` / `page[limit]`, with a `next` link unless it is the last. */
const paged = (
  sorter: Sorter,
  tasks: ReadonlyArray<Wire>,
  pathname: string,
  params: URLSearchParams,
  size: number,
): Answer => {
  const sort = params.get("sort") ?? "";
  const terms = termsOf(sort);
  const offset = Number(params.get("page[offset]") ?? "0");
  const page =
    sorter.sortsEachPage === true
      ? ordered(sorter, tasks.slice(offset, offset + size), terms)
      : ordered(sorter, tasks, terms).slice(offset, offset + size);
  const next =
    offset + size < tasks.length
      ? `${pathname}?sort=${sort}&page[offset]=${offset + size}&page[limit]=${size}`
      : null;
  return { status: 200, body: { data: page, links: { next } } };
};

/**
 * A server ordering `tasks` by `sort` with `sorter`, and paging `/tasks` by
 * `page[offset]` / `page[limit]` when a limit is asked for.
 */
const serve =
  (sorter: Sorter, tasks: ReadonlyArray<Wire> = TASKS) =>
  (path: string): Answer => {
    const [pathname = "", search = ""] = path.split("?");
    if (pathname !== "/tasks" && pathname !== "/projects/1/tasks" && !/^\/t\d+$/.test(pathname)) {
      return { status: 404, body: { errors: [{ status: "404" }] } };
    }
    const params = new URLSearchParams(search);
    const terms = termsOf(params.get("sort") ?? "");
    if (terms.some(({ field }) => sorter.refuses?.includes(field))) return refusal;
    const limit = params.get("page[limit]");
    return limit === null || sorter.unpaged === true
      ? { status: 200, body: { data: ordered(sorter, tasks, terms) } }
      : paged(sorter, tasks, pathname, params, Number(limit));
  };

/** The paths a run sent, in order. */
const run = async (
  answer: (path: string) => Answer,
  target: HttpApi.HttpApi<string, any> = api,
  ruleId: string = RULE,
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
      only: [ruleId],
    }),
  );
  const outcome = report.outcomes.find((candidate) => candidate.rule.id === ruleId);
  if (outcome === undefined) throw new Error(`no outcome for ${ruleId}`);
  return { outcome, sent };
};

const findingsOf = (outcome: Conformance.Outcome) => {
  expect(outcome._tag).toBe("Failed");
  return Predicate.isTagged(outcome, "Failed") ? outcome.findings : [];
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
    const ranked = TASKS.map((task) => ({
      ...task,
      attributes: { rank: task.attributes["rank"] },
    }));
    const tasks = Arr.sort(
      ranked,
      orderOf<(typeof ranked)[number]>((a, b) => ascending(valueOf(a, "rank"), valueOf(b, "rank"))),
    );
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
    assert(Predicate.isTagged(outcome, "Passed"));
    expect(outcome.note).toBe(
      "NULL placement (S-ORD-3) not observed: no attribute decided held a NULL in its answers",
    );
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
    assert(Predicate.isTagged(outcome, "Skipped"));
    expect(outcome.reason).toBe(
      "no attribute's order could be observed: /tasks: refused `sort` by `due`, `title`, `rank` with a 400 (not sortable there); /projects/1/tasks: refused `sort` by `due`, `title`, `rank` with a 400 (not sortable there)",
    );
  });

  it("decides nothing on a server error", async () => {
    const failing = (path: string) =>
      path.includes("sort=")
        ? { status: 503, body: { errors: [{ status: "503" }] } }
        : serve(profileSorter)(path);
    const { outcome } = await run(failing);
    assert(Predicate.isTagged(outcome, "Skipped"));
    expect(outcome.reason).toContain("`due`: `?sort=due` answered 503");
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

describe("Conformance: several sort fields (filter-grammar §10.4, S-MULTI-1)", () => {
  const MULTI = "profile/sort/multi-field";

  it("is a MUST citing §10.4", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === MULTI);
    expect(rule).toMatchObject({ tier: "profile", level: "MUST" });
    expect(rule?.reference).toMatch(/docs\/filter-grammar\.md#104-several-fields$/);
  });

  it("passes a server that orders lexicographically, each term in its own direction", async () => {
    const { outcome, sent } = await run(serve(profileSorter), api, MULTI);
    expect(outcome).toMatchObject({ _tag: "Passed", probes: 6, note: undefined });
    // `rank` ties tasks 1 and 4, whose `title`s differ: both directions of each term are asked for.
    expect(sent).toEqual([
      "/tasks",
      "/tasks?sort=rank,-title",
      "/tasks?sort=-rank,title",
      "/projects/1/tasks",
      "/projects/1/tasks?sort=rank,-title",
      "/projects/1/tasks?sort=-rank,title",
    ]);
  });

  it("fails a server that ignores every term but the first", async () => {
    // Ties on `rank` fall to `id` order, which `rank,-title` happens to agree with; `-rank,title` does not.
    const { outcome } = await run(serve({ ...profileSorter, firstTermOnly: true }), api, MULTI);
    const findings = findingsOf(outcome);
    expect(findings.map((found) => found.detail)).toEqual([
      '`?sort=-rank,title` lists tasks:1 (2, "b") before tasks:4 (2, "B")',
      '`?sort=-rank,title` lists tasks:1 (2, "b") before tasks:4 (2, "B")',
    ]);
    expect(findings[0]).toMatchObject({
      expected:
        "primary data ordered by `rank` descending, then by `title` ascending, each later term breaking only the ties the terms before it left (S-MULTI-1)",
      observed: '`rank`, `title` in the order served: (3, "c"), (2, "b"), (2, "B"), (1, "a")',
    });
    expect(findings[0]?.probe?.url).toBe("/tasks?sort=-rank%2Ctitle");
  });

  it("fails a server that applies the first term's direction to every term", async () => {
    const { outcome } = await run(serve({ ...profileSorter, oneDirection: true }), api, MULTI);
    expect(findingsOf(outcome).map((found) => found.detail)).toEqual([
      '`?sort=rank,-title` lists tasks:4 (2, "B") before tasks:1 (2, "b")',
      '`?sort=-rank,title` lists tasks:1 (2, "b") before tasks:4 (2, "B")',
      '`?sort=rank,-title` lists tasks:4 (2, "B") before tasks:1 (2, "b")',
      '`?sort=-rank,title` lists tasks:1 (2, "b") before tasks:4 (2, "B")',
    ]);
  });

  it("passes over a pair the server refuses for the next", async () => {
    const { outcome, sent } = await run(
      serve({ ...profileSorter, refuses: ["title"] }),
      api,
      MULTI,
    );
    expect(outcome).toMatchObject({ _tag: "Passed" });
    expect(sent.slice(0, 4)).toEqual([
      "/tasks",
      "/tasks?sort=rank,-title",
      "/tasks?sort=rank,-due",
      "/tasks?sort=-rank,due",
    ]);
  });

  it("skips a collection in which no two resources tie on an attribute another tells apart", async () => {
    const distinct = TASKS.map((task, at) => ({ ...task, attributes: { rank: at } }));
    const { outcome } = await run(serve(profileSorter, distinct), api, MULTI);
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason:
        "no two-term order could be observed: /tasks: no two of its 4 resources tie on one attribute and differ on another, so no second term can be observed; /projects/1/tasks: no two of its 4 resources tie on one attribute and differ on another, so no second term can be observed",
    });
  });
});

describe("Conformance: the `id` tiebreak (filter-grammar §10.5, S-TIE-1)", () => {
  const TIE = "profile/sort/id-tiebreak";

  it("is a SHOULD citing §10.5", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === TIE);
    expect(rule).toMatchObject({ tier: "profile", level: "SHOULD" });
    expect(rule?.reference).toMatch(/docs\/filter-grammar\.md#105-ties-and-stability$/);
  });

  it("passes a server that breaks ties by `id` whatever the direction", async () => {
    const { outcome, sent } = await run(serve(profileSorter), api, TIE);
    expect(outcome).toMatchObject({ _tag: "Passed", probes: 6, note: undefined });
    expect(sent).toEqual([
      "/tasks",
      "/tasks?sort=rank",
      "/tasks?sort=-rank",
      "/projects/1/tasks",
      "/projects/1/tasks?sort=rank",
      "/projects/1/tasks?sort=-rank",
    ]);
  });

  it("fails a server that answers `-f` by reversing its answer to `f`", async () => {
    // The order on `rank` itself is right both ways: only the tie shows the reversal.
    const { outcome } = await run(serve({ ...profileSorter, reverses: true }), api, TIE);
    const findings = findingsOf(outcome);
    expect(findings.map((found) => found.detail)).toEqual([
      "`?sort=rank` lists tasks:1 before tasks:4 and `?sort=-rank` lists tasks:4 before tasks:1, though the two tie on `rank` (2)",
      "`?sort=rank` lists tasks:1 before tasks:4 and `?sort=-rank` lists tasks:4 before tasks:1, though the two tie on `rank` (2)",
    ]);
    expect(findings[0]).toMatchObject({
      observed: "1 of the 1 tied pair both answers list in the other order: tasks:1 / tasks:4",
    });
    expect(findings[0]?.probe?.url).toBe("/tasks?sort=-rank");
    const ordering = await run(serve({ ...profileSorter, reverses: true }));
    expect(ordering.outcome).toMatchObject({ _tag: "Passed" });
  });

  it("passes over an attribute the server refuses for the next tie", async () => {
    const { outcome, sent } = await run(serve({ ...profileSorter, refuses: ["rank"] }), api, TIE);
    expect(outcome).toMatchObject({ _tag: "Passed" });
    expect(sent.slice(0, 4)).toEqual([
      "/tasks",
      "/tasks?sort=rank",
      "/tasks?sort=due",
      "/tasks?sort=-due",
    ]);
  });

  it("skips a collection in which no two resources tie", async () => {
    const distinct = TASKS.map((task, at) => ({ ...task, attributes: { rank: at } }));
    const { outcome } = await run(serve(profileSorter, distinct), api, TIE);
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason:
        "no tie could be observed: /tasks: no two of its 4 resources tie on an attribute, so no tiebreak can be observed; /projects/1/tasks: no two of its 4 resources tie on an attribute, so no tiebreak can be observed",
    });
  });
});

describe("Conformance: the order across pages (filter-grammar §10.6, S-PAGE-1)", () => {
  const PAGES = "profile/sort/across-pages";

  it("is a MUST citing §10.6", () => {
    const rule = Conformance.rules.find((candidate) => candidate.id === PAGES);
    expect(rule).toMatchObject({ tier: "profile", level: "MUST" });
    expect(rule?.reference).toMatch(/docs\/filter-grammar\.md#106-with-filter-and-page$/);
  });

  it("passes a server that sorts the collection before it pages it, walking `next`", async () => {
    const { outcome, sent } = await run(serve(profileSorter), api, PAGES);
    expect(outcome).toMatchObject({ _tag: "Passed", probes: 3, note: undefined });
    // Only the list declares a page size; half the baseline's four resources a page.
    expect(sent).toEqual([
      "/tasks",
      "/tasks?sort=due&page[limit]=2",
      "/tasks?sort=due&page[offset]=2&page[limit]=2",
    ]);
  });

  it("fails a server that sorts each page on its own", async () => {
    const { outcome } = await run(serve({ ...profileSorter, sortsEachPage: true }), api, PAGES);
    const findings = findingsOf(outcome);
    expect(findings.map((found) => found.detail)).toEqual([
      'page 1 of `?sort=due&page[limit]=2` (/tasks?sort=due&page[limit]=2) lists tasks:2 (NULL), which sorts after tasks:3 ("2026-01-01T00:00:00.000Z") on page 2 (/tasks?sort=due&page[offset]=2&page[limit]=2)',
    ]);
    expect(findings[0]).toMatchObject({
      observed:
        '`due` page by page: ["2026-01-02T00:00:00.000Z", NULL] ["2026-01-01T00:00:00.000Z", NULL]',
    });
    // Each page is in order on its own, so the ordering rule cannot see it.
    const ordering = await run(serve({ ...profileSorter, sortsEachPage: true }));
    expect(ordering.outcome).toMatchObject({ _tag: "Passed" });
  });

  it("decides nothing on a server that ignores the page size", async () => {
    const { outcome } = await run(serve({ ...profileSorter, unpaged: true }), api, PAGES);
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason:
        "no order across pages could be observed: /tasks: `due`: `?sort=due&page[limit]=2` answered one page, so no page boundary can be observed; `title`: `?sort=title&page[limit]=2` answered one page, so no page boundary can be observed; `rank`: `?sort=rank&page[limit]=2` answered one page, so no page boundary can be observed",
    });
  });

  it("skips an api with no endpoint declaring both `sort` and a page size", async () => {
    const { outcome, sent } = await run(serve(profileSorter), unpagedApi, PAGES);
    expect(outcome).toMatchObject({
      _tag: "Skipped",
      reason:
        "no list or related endpoint in this api declares `sort` and `page[limit]` or `page[size]`",
    });
    expect(sent).toEqual([]);
  });
});
