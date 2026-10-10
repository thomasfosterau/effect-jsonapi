/**
 * The pagination rule: a walk of a collection's `next` links from its first
 * page, held against the collection fetched another way.
 *
 * The kit is never told the set a server pages over; it derives it. It fetches
 * the collection as the server serves it by default — whole, or in the
 * server's own pages, walked — and then walks it again at a page size that
 * forces a different partition, so a pager that repeats or drops a resource
 * disagrees with the reference rather than with itself. The walk is bounded
 * (a page budget per walk, a request budget per run of the rule, a `next` that
 * leads back to a page already visited ends it), and a walk that runs out of
 * budget — or meets a server error, a rate limit, a request timeout or a lost
 * response, or starts on a page of items it cannot identify — is reported as
 * not checked, never as a partial pass.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import {
  coverageNote,
  describe,
  type Discovered,
  finding,
  type Finding,
  identity,
  isRecord,
  noProbeReason,
  type Observation,
  type Outcome,
  pass,
  probeable,
  resourceLabel,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  statusOf,
  succeeded,
  withQuery,
} from "./core.js";
import {
  budgeted,
  counted,
  type Io,
  Link,
  linkIn,
  listed,
  own,
  quote,
  SAYS_NOTHING,
  Step,
  stepTo,
  type Target,
  unanswered,
} from "./crawl.js";

const rule: Rule = {
  id: "spec/pagination/links-enumerate-collection",
  tier: "spec",
  section: "Pagination",
  reference: "https://jsonapi.org/format/1.1/#fetching-pagination",
  level: "MUST",
  requirement:
    "The keys `first`, `last`, `prev` and `next` MUST be used for the first, last, previous and next page of data, and a link that is unavailable MUST be omitted or `null`: the first page carries no `prev`, `first` and `last` answer the first and last pages, and following `next` from the first page visits each page once and ends at the last, with every resource of the collection on exactly one page.",
};

/** The pages one walk may fetch before it stops and reports itself unfinished. */
const PAGE_BUDGET = 20;

/** The requests one run of the rule may make, over every collection it walks. */
const REQUEST_BUDGET = 200;

/** The page-size parameters the kit can set, in the order it prefers them. */
const SIZE_KEYS = ["page[limit]", "page[size]"] as const;

/** The roles of an endpoint that may answer a resource collection. */
const COLLECTION_ROLES = ["collection", "related"] as const;

// ---------------------------------------------------------------------------
// Pages and links
// ---------------------------------------------------------------------------

/** A resource a page lists, by the identity the kit compares on and its label. */
interface Member {
  readonly key: string;
  readonly label: string;
}

/**
 * A page of the collection: where it was fetched, what came back, the
 * resources it lists, and how many items its `data` held — more than
 * `members` when some carry no identity the kit can compare on.
 */
interface Page extends Target {
  readonly observation: Observation;
  readonly members: ReadonlyArray<Member>;
  readonly items: number;
}

/** What a page of items none of which the kit can identify is said to list. */
const unidentified = (count: number): string =>
  `${counted(count, "item")}, none of them a resource the kit can identify (a string \`type\` and \`id\` or \`lid\`)`;

/** `true` when a page's `data` holds items but not one the kit can identify. */
const opaque = (page: Page): boolean => Arr.isReadonlyArrayEmpty(page.members) && page.items > 0;

/** The `links` member `name` of a page's document. */
const linkOf = (page: Page, name: string): Link =>
  linkIn(isRecord(page.observation.body) ? page.observation.body["links"] : undefined, name);

/** A response as a page of the collection, when it is one: 2xx, with `data` an array. */
const pageOf = (target: Target, observation: Observation): Option.Option<Page> => {
  const data = isRecord(observation.body) ? observation.body["data"] : undefined;
  return succeeded(observation) && Array.isArray(data)
    ? Option.some({
        ...target,
        observation,
        items: data.length,
        members: Arr.filterMap(data, (item) =>
          isRecord(item)
            ? Result.fromOption(
                Option.map(Option.fromUndefinedOr(identity(item)), (key) => ({
                  key,
                  label: resourceLabel(item),
                })),
                () => undefined,
              )
            : Result.fail(undefined),
        ),
      })
    : Option.none();
};

/** The identities a run of pages lists, each once. */
const keysOf = (pages: ReadonlyArray<Page>): HashSet.HashSet<string> =>
  HashSet.fromIterable(Arr.flatMap(pages, ({ members }) => Arr.map(members, ({ key }) => key)));

/** The identities, in order, a page lists. */
const sequenceOf = (page: Page): string => page.members.map(({ key }) => key).join("\n");

// ---------------------------------------------------------------------------
// The budgeted transport
// ---------------------------------------------------------------------------

const REQUESTS_SPENT = `the rule's budget of ${REQUEST_BUDGET} requests ran out before the collection could be checked`;

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** How a walk ended. Page numbers are 1-based, as a finding names them. */
type End =
  | { readonly _tag: "Last" }
  | { readonly _tag: "Cycle"; readonly from: number; readonly to: number }
  | { readonly _tag: "Empty"; readonly from: number; readonly observation: Observation }
  | { readonly _tag: "NotAPage"; readonly from: number; readonly observation: Observation }
  | { readonly _tag: "Unanswered"; readonly from: number; readonly observation: Observation }
  | { readonly _tag: "Opaque"; readonly from: number; readonly items: number }
  | { readonly _tag: "NotALink"; readonly from: number; readonly value: unknown }
  | { readonly _tag: "Offsite"; readonly from: number; readonly to: string }
  | { readonly _tag: "Stalled"; readonly at: number }
  | { readonly _tag: "Overflow"; readonly at: number }
  | { readonly _tag: "Spent"; readonly reason: string };
const End = Data.taggedEnum<End>();

interface Walk {
  readonly pages: Arr.NonEmptyReadonlyArray<Page>;
  readonly end: End;
}

/**
 * Follows `next` from `first` until a page omits it or sets it `null` — or
 * until the walk can go no further: a `next` that is no link, leads off the
 * origin or back to a page already visited, answers something that is not a
 * page — or nothing the kit decides on: a server error, a rate limit, a
 * request timeout, no response — or a page that lists no resources, or none
 * the kit can identify; a page that lists nothing earlier pages did not (a
 * `next` that would never end); more resources than `holds`, when the
 * collection's size is known; or the budget.
 */
const walk = (
  io: Io,
  baseUrl: string,
  first: Page,
  holds: Option.Option<number>,
): Effect.Effect<Walk> => {
  const step = (
    pages: Arr.NonEmptyReadonlyArray<Page>,
    seen: HashSet.HashSet<string>,
  ): Effect.Effect<Walk> =>
    Result.match(nextOf(pages, first, baseUrl), {
      onFailure: (end) => Effect.succeed({ pages, end }),
      onSuccess: (target) =>
        Effect.flatMap(io.fetch(target), (answer) =>
          Option.match(answer, {
            onNone: () => Effect.succeed({ pages, end: End.Spent({ reason: REQUESTS_SPENT }) }),
            onSome: (observation) =>
              Result.match(arrive(pages, seen, holds, target, observation), {
                onFailure: (ended) => Effect.succeed(ended),
                onSuccess: ([walked, now]) => step(walked, now),
              }),
          }),
        ),
    });
  return step([first], keysOf([first]));
};

/**
 * Where a walk goes from its last page: the page `next` names, or how the walk
 * ends without fetching anything more.
 */
const nextOf = (
  pages: Arr.NonEmptyReadonlyArray<Page>,
  first: Page,
  baseUrl: string,
): Result.Result<Target, End> => {
  const current = Arr.lastNonEmpty(pages);
  const from = pages.length;
  const next = linkOf(current, "next");
  if (Link.$is("Unavailable")(next)) return Result.fail(End.Last());
  if (Link.$is("Malformed")(next)) return Result.fail(End.NotALink({ from, value: next.value }));
  const to = stepTo(next.href, current, baseUrl);
  if (Step.$is("Unparseable")(to)) return Result.fail(End.NotALink({ from, value: to.href }));
  if (Step.$is("Offsite")(to)) return Result.fail(End.Offsite({ from, to: to.to }));
  const back = pages.findIndex(({ href }) => href === to.target.href);
  if (back !== -1) return Result.fail(End.Cycle({ from, to: back + 1 }));
  return from >= PAGE_BUDGET
    ? Result.fail(
        End.Spent({
          reason: `the walk from ${first.url} did not end within its budget of ${PAGE_BUDGET} pages — a collection too large to walk at this page size, or a \`next\` that never ends; a partial walk is not passed`,
        }),
      )
    : Result.succeed(to.target);
};

/**
 * What the answer `next` led to does to a walk: a page that extends it, with
 * the identities seen so far, or the walk as it ends there.
 */
const arrive = (
  pages: Arr.NonEmptyReadonlyArray<Page>,
  seen: HashSet.HashSet<string>,
  holds: Option.Option<number>,
  target: Target,
  observation: Observation,
): Result.Result<readonly [Arr.NonEmptyReadonlyArray<Page>, HashSet.HashSet<string>], Walk> => {
  const from = pages.length;
  if (unanswered(observation))
    return Result.fail({ pages, end: End.Unanswered({ from, observation }) });
  const page = pageOf(target, observation);
  if (Option.isNone(page)) return Result.fail({ pages, end: End.NotAPage({ from, observation }) });
  if (opaque(page.value))
    return Result.fail({ pages, end: End.Opaque({ from, items: page.value.items }) });
  if (Arr.isReadonlyArrayEmpty(page.value.members))
    return Result.fail({ pages, end: End.Empty({ from, observation }) });
  const walked = Arr.append(pages, page.value);
  const fresh = page.value.members.filter(({ key }) => !HashSet.has(seen, key));
  if (Arr.isReadonlyArrayEmpty(fresh))
    return Result.fail({ pages: walked, end: End.Stalled({ at: walked.length }) });
  const now = HashSet.union(seen, HashSet.fromIterable(fresh.map(({ key }) => key)));
  return Option.exists(holds, (size) => HashSet.size(now) > size)
    ? Result.fail({ pages: walked, end: End.Overflow({ at: walked.length }) })
    : Result.succeed([walked, now] as const);
};

// ---------------------------------------------------------------------------
// Judging a walk
// ---------------------------------------------------------------------------

/**
 * A finding, and whether it depends on the order the server lists the
 * collection in. Without `sort`, JSON:API leaves that order to the server, so
 * an order-dependent finding is held against the links only once the order is
 * shown to be stable.
 */
interface Judged {
  readonly finding: Finding;
  readonly ordered: boolean;
}

/** What one walk shows: its findings, and why it could not be finished, if it could not. */
interface Judgement {
  readonly judged: ReadonlyArray<Judged>;
  readonly unfinished: Option.Option<string>;
}

const at = (page: Page, index: number): string => `page ${index} (${page.url})`;

/** Each resource a page lists that an earlier page of the walk listed too. */
const repeatsOf = (pages: ReadonlyArray<Page>): ReadonlyArray<string> => {
  const firstOn = MutableHashMap.empty<string, number>();
  return Arr.flatMap(pages, (page, index) =>
    Arr.filterMap(page.members, ({ key, label }) =>
      Option.match(MutableHashMap.get(firstOn, key), {
        onNone: () => {
          MutableHashMap.set(firstOn, key, index);
          return Result.fail(undefined);
        },
        onSome: (earlier) =>
          earlier === index
            ? Result.fail(undefined)
            : Result.succeed(`${label} (pages ${earlier + 1} and ${index + 1})`),
      }),
    ),
  );
};

/** The findings a walk's own pages and its end show, before any link is checked. */
const judgeEnd = (run: Walk, start: string): ReadonlyArray<Judged> => {
  const { pages, end } = run;
  const first = Arr.headNonEmpty(pages);
  const page = (number: number): Page => pages[number - 1] ?? first;
  const out: Array<Judged> = [];
  const prev = linkOf(first, "prev");
  if (!Link.$is("Unavailable")(prev)) {
    out.push({
      ordered: false,
      finding: finding(rule, {
        detail: `the first page (${first.url}) carries \`prev\`, but no page comes before it`,
        expected: "`prev` omitted or `null` on the first page",
        observed: `prev: ${quote(Link.$is("Href")(prev) ? prev.href : prev.value)}`,
        probe: first.observation.probe,
      }),
    });
  }
  const repeats = repeatsOf(pages);
  if (Arr.isReadonlyArrayNonEmpty(repeats)) {
    const stalled = End.$is("Stalled")(end)
      ? ` — page ${end.at} listed nothing earlier pages had not, so the walk stopped there`
      : "";
    out.push({
      ordered: true,
      finding: finding(rule, {
        detail: `following \`next\` from ${start} listed ${counted(repeats.length, "resource")} a second time${stalled}`,
        expected: "each resource on exactly one page",
        observed: listed(repeats),
        probe: undefined,
      }),
    });
  }
  End.$match(end, {
    Last: () => undefined,
    Stalled: () => undefined,
    Overflow: () => undefined,
    Offsite: () => undefined,
    Spent: () => undefined,
    Unanswered: () => undefined,
    Opaque: () => undefined,
    Cycle: ({ from, to }) => {
      out.push({
        ordered: false,
        finding: finding(rule, {
          detail: `\`next\` on ${at(page(from), from)} leads back to page ${to} (${page(to).url}), so following it never ends`,
          expected:
            "`next` leading to a page not yet visited, or omitted or `null` on the last page",
          observed: `next: ${quote(page(to).url)}`,
          probe: page(from).observation.probe,
        }),
      });
    },
    Empty: ({ from, observation }) => {
      out.push({
        ordered: false,
        finding: finding(rule, {
          detail: `\`next\` on ${at(page(from), from)} leads to a page that lists no resources, so the last page carries \`next\``,
          expected: "`next` omitted or `null` on the last page",
          observed: describe(observation),
          probe: observation.probe,
        }),
      });
    },
    NotAPage: ({ from, observation }) => {
      out.push({
        ordered: false,
        finding: finding(rule, {
          detail: `\`next\` on ${at(page(from), from)} leads to a response that is not a page of the collection`,
          expected: "a 2xx document whose `data` is the next page of the collection",
          observed: describe(observation),
          probe: observation.probe,
        }),
      });
    },
    NotALink: ({ from, value }) => {
      out.push({
        ordered: false,
        finding: finding(rule, {
          detail: `\`next\` on ${at(page(from), from)} is not a link the kit can follow`,
          expected: "a URL, a link object with an `href`, or `null`",
          observed: `next: ${quote(value)}`,
          probe: page(from).observation.probe,
        }),
      });
    },
  });
  return out;
};

/** Why a walk could not be finished, when it could not. */
const unfinishedOf = (end: End, pages: ReadonlyArray<Page>): Option.Option<string> => {
  const on = (from: number): string => `\`next\` on page ${from} (${pages[from - 1]?.url ?? ""})`;
  return End.$match(end, {
    Offsite: ({ from, to }) =>
      Option.some(`${on(from)} leads to ${to}, which the kit does not follow`),
    Unanswered: ({ from, observation }) =>
      Option.some(
        `${on(from)} got ${statusOf(observation)}, so the walk could not be finished — ${SAYS_NOTHING}`,
      ),
    Opaque: ({ from, items }) =>
      Option.some(
        `${on(from)} leads to a page of ${unidentified(items)}, so the walk could not be finished`,
      ),
    Spent: ({ reason }) => Option.some(reason),
    Last: () => Option.none(),
    Cycle: () => Option.none(),
    Empty: () => Option.none(),
    NotAPage: () => Option.none(),
    NotALink: () => Option.none(),
    Stalled: () => Option.none(),
    Overflow: () => Option.none(),
  });
};

/**
 * The page a `first` or `last` link names, when the kit should fetch it — none
 * when the link is absent, leads off the origin or names the expected page
 * itself — or the finding when it is not a link at all.
 */
const endLinkTarget = (
  baseUrl: string,
  name: "first" | "last",
  carrier: Page,
  expected: Page,
): Result.Result<Option.Option<Target>, Judged> => {
  const link = linkOf(carrier, name);
  if (Link.$is("Unavailable")(link)) return Result.succeed(Option.none());
  const to = Link.$is("Href")(link) ? stepTo(link.href, carrier, baseUrl) : undefined;
  if (to === undefined || Step.$is("Unparseable")(to)) {
    return Result.fail({
      ordered: false,
      finding: finding(rule, {
        detail: `\`${name}\` on ${carrier.url} is not a link the kit can follow`,
        expected: "a URL, a link object with an `href`, or `null`",
        observed: `${name}: ${quote(Link.$is("Href")(link) ? link.href : link.value)}`,
        probe: carrier.observation.probe,
      }),
    });
  }
  return Result.succeed(
    Step.$is("Follow")(to) && to.target.href !== expected.href
      ? Option.some(to.target)
      : Option.none(),
  );
};

/** The resources of a page, as a finding lists them. */
const named = (page: Page): string =>
  Arr.isReadonlyArrayEmpty(page.members)
    ? "no resources"
    : listed(page.members.map(({ label }) => label));

/** A judgement of findings alone, with nothing left unfinished. */
const judgedOnly = (judged: ReadonlyArray<Judged>): Judgement => ({
  judged,
  unfinished: Option.none(),
});

/** A judgement that could not be made, and why. */
const unjudged = (why: string): Judgement => ({ judged: [], unfinished: Option.some(why) });

/**
 * What a `first` or `last` link answered, held against the page the walk
 * found there — or why it could not be: a response that says nothing of the
 * links, or a page of items none of which the kit can identify.
 */
const compareEndPage = (
  name: "first" | "last",
  carrier: Page,
  expected: Page,
  target: Target,
  observation: Observation,
): Judgement => {
  const which = name === "first" ? "first page" : "last page `next` reaches";
  const link = `\`${name}\` on ${carrier.url}`;
  if (unanswered(observation)) {
    return unjudged(
      `${link} got ${statusOf(observation)}, so it could not be checked — ${SAYS_NOTHING}`,
    );
  }
  return Option.match(pageOf(target, observation), {
    onNone: () =>
      judgedOnly([
        {
          ordered: false,
          finding: finding(rule, {
            detail: `${link} leads to a response that is not a page of the collection`,
            expected: `the ${which}, ${expected.url}`,
            observed: describe(observation),
            probe: observation.probe,
          }),
        },
      ]),
    onSome: (page) => {
      if (opaque(page)) {
        return unjudged(
          `${link} leads to a page of ${unidentified(page.items)}, so it could not be checked`,
        );
      }
      const answered = keysOf([page]);
      const wanted = keysOf([expected]);
      return judgedOnly(
        HashSet.isSubset(answered, wanted) && HashSet.isSubset(wanted, answered)
          ? []
          : [
              {
                ordered: true,
                finding: finding(rule, {
                  detail: `${link} answers different resources from the ${which}`,
                  expected: `${named(expected)} (${expected.url})`,
                  observed: `${named(page)} (${page.url})`,
                  probe: observation.probe,
                }),
              },
            ],
      );
    },
  });
};

/**
 * Checks the `first` or `last` link a walk's first page carries against the
 * page the walk found there: both must list the same resources. A link the
 * request budget leaves no request to follow is unfinished, not passed.
 */
const checkEndLink = (
  io: Io,
  baseUrl: string,
  name: "first" | "last",
  carrier: Page,
  expected: Page,
): Effect.Effect<Judgement> =>
  Result.match(endLinkTarget(baseUrl, name, carrier, expected), {
    onFailure: (judged) => Effect.succeed(judgedOnly([judged])),
    onSuccess: (target) =>
      Option.match(target, {
        onNone: () => Effect.succeed(judgedOnly([])),
        onSome: (resolved) =>
          Effect.map(io.fetch(resolved), (answer) =>
            Option.match(answer, {
              onNone: () => unjudged(REQUESTS_SPENT),
              onSome: (observation) =>
                compareEndPage(name, carrier, expected, resolved, observation),
            }),
          ),
      }),
  });

/** Everything one walk shows: its pages and end, then its `first` and `last` links. */
const judge = (io: Io, baseUrl: string, run: Walk): Effect.Effect<Judgement> =>
  Effect.gen(function* () {
    const first = Arr.headNonEmpty(run.pages);
    const firsts = yield* checkEndLink(io, baseUrl, "first", first, first);
    const lasts = End.$is("Last")(run.end)
      ? yield* checkEndLink(io, baseUrl, "last", first, Arr.lastNonEmpty(run.pages))
      : judgedOnly([]);
    return {
      judged: [...judgeEnd(run, first.url), ...firsts.judged, ...lasts.judged],
      unfinished: Option.firstSomeOf([
        unfinishedOf(run.end, run.pages),
        firsts.unfinished,
        lasts.unfinished,
      ]),
    };
  });

// ---------------------------------------------------------------------------
// One collection
// ---------------------------------------------------------------------------

/** What walking one collection endpoint showed, and why it was not decided, if it was not. */
interface Assessment {
  readonly where: string;
  readonly findings: ReadonlyArray<Finding>;
  readonly unsettled: Option.Option<string>;
}

/**
 * The page size the second walk asks for: a third of the collection when the
 * server answered it whole, so the walk takes about three pages; one fewer
 * than the server's own page when it pages by default, so the two walks
 * partition the collection differently while taking about as many pages.
 */
const sizeFor = (reference: Walk, holds: number): number => {
  if (reference.pages.length === 1) return Math.ceil(holds / 3);
  const own = Arr.headNonEmpty(reference.pages).members.length;
  return own >= 2 ? own - 1 : 2;
};

/**
 * Re-asks for a page a walk started from: none when the second answer lists
 * the same resources in the same order, or why the order is not shown stable —
 * the server listed them in another order (the case JSON:API leaves to the
 * server when no `sort` is given), or the second ask got no page to compare.
 */
const recheck = (io: Io, start: Page): Effect.Effect<Option.Option<string>> =>
  Effect.map(io.refetch(start), (answer) =>
    Option.match(answer, {
      onNone: () =>
        Option.some(
          `the rule's budget of ${REQUEST_BUDGET} requests ran out before the collection's order could be confirmed stable`,
        ),
      onSome: (observation) =>
        Option.match(pageOf(start, observation), {
          onNone: () =>
            Option.some(
              `asked for ${start.url} a second time to confirm the collection's order is stable, the kit got ${statusOf(observation)}`,
            ),
          onSome: (page) =>
            sequenceOf(page) === sequenceOf(start)
              ? Option.none()
              : Option.some(
                  `the collection's order is not stable — asked for ${start.url} a second time, the server listed its resources in a different order — and JSON:API requires no stable order without \`sort\` (§Sorting: "The server MAY apply default sorting rules to top-level \`data\` if request parameter \`sort\` is not specified")`,
                ),
        }),
    }),
  );

/**
 * Re-asks for each page a walk started from, one at a time, stopping at the
 * first that does not show the order stable: none when every one does, or why
 * one did not. A second ask that cannot be made or answered confirms nothing.
 */
const reordered = (io: Io, starts: ReadonlyArray<Page>): Effect.Effect<Option.Option<string>> =>
  Effect.reduce(
    starts,
    (): Option.Option<string> => Option.none(),
    (why, start) => (Option.isSome(why) ? Effect.succeed(why) : recheck(io, start)),
  );

/** Why `withheld` order-dependent findings are not held against the links. */
const withholding = (why: string, withheld: number): string =>
  `${why}, so the walk's ${withheld} order-dependent finding${withheld === 1 ? "" : "s"} (resources repeated or missed across pages, or a \`first\` / \`last\` page that disagrees) cannot be held against the links`;

/** An assessment of `where` from what its walks showed. */
const settled = (
  where: string,
  judged: ReadonlyArray<Judged>,
  unsettled: Option.Option<string>,
): Assessment => ({
  where,
  findings: judged.map(({ finding: found }) => found),
  unsettled,
});

/**
 * An assessment of `where` whose order-dependent findings stand only once
 * asking again for each page a walk started from (`starts`) shows the order
 * stable; otherwise they are withheld, and `where` is not decided, saying why.
 * Every way out of {@link assess} that carries findings comes through here.
 */
const confirmed = (
  io: Io,
  where: string,
  judged: ReadonlyArray<Judged>,
  unsettled: Option.Option<string>,
  starts: ReadonlyArray<Page>,
): Effect.Effect<Assessment> => {
  const ordered = judged.filter(({ ordered: dependsOnOrder }) => dependsOnOrder);
  if (Arr.isReadonlyArrayEmpty(ordered)) return Effect.succeed(settled(where, judged, unsettled));
  return Effect.map(reordered(io, starts), (why) =>
    Option.match(why, {
      onNone: () => settled(where, judged, unsettled),
      onSome: (cause) =>
        settled(
          where,
          judged.filter(({ ordered: dependsOnOrder }) => !dependsOnOrder),
          Option.some(
            [...Option.toArray(unsettled), withholding(cause, ordered.length)].join("; "),
          ),
        ),
    }),
  );
};

/** Why a reference too small to page is not walked again. */
const tooFew = (holds: number): string =>
  `the collection holds ${holds === 0 ? "no resources" : "one resource"} — fewer than two, so no page size forces a second page`;

/**
 * Walks one collection endpoint: the collection as the server serves it by
 * default — whole, or its own pages walked — then again at a page size that
 * forces a different partition, each walk judged and the second held against
 * the first.
 */
const assess = (
  io: Io,
  baseUrl: string,
  endpoint: Discovered,
  path: string,
): Effect.Effect<Assessment> =>
  Effect.gen(function* () {
    const reached = yield* fetchPage(io, own(path, baseUrl), path);
    if (Result.isFailure(reached)) return settled(path, [], Option.some(reached.failure));
    const reference = yield* walk(io, baseUrl, reached.success, Option.none());
    const judged = yield* judge(io, baseUrl, reference);
    const holds = HashSet.size(keysOf(reference.pages));
    const blocked = Option.orElse(judged.unfinished, () =>
      holds < 2 ? Option.some(tooFew(holds)) : Option.none(),
    );
    if (Option.isSome(blocked))
      return yield* confirmed(io, path, judged.judged, blocked, [reached.success]);
    const key =
      SIZE_KEYS.find((candidate) => endpoint.queryKeys.includes(candidate)) ?? "page[limit]";
    return yield* assessPaged(io, baseUrl, path, reference, judged.judged, [
      key,
      sizeFor(reference, holds),
    ]);
  });

/**
 * The second walk, at `size`, judged and held against the reference, with the
 * order-dependent findings withheld if the server's order shifts.
 */
const assessPaged = (
  io: Io,
  baseUrl: string,
  path: string,
  reference: Walk,
  referenceJudged: ReadonlyArray<Judged>,
  [key, size]: readonly [string, number],
): Effect.Effect<Assessment> =>
  Effect.gen(function* () {
    const holds = HashSet.size(keysOf(reference.pages));
    const sized = withQuery(path, [[key, `${size}`]]);
    const referenceStart = Arr.headNonEmpty(reference.pages);
    const started = yield* fetchPage(io, own(sized, baseUrl), sized);
    if (Result.isFailure(started)) {
      return yield* confirmed(io, path, referenceJudged, Option.some(started.failure), [
        referenceStart,
      ]);
    }
    const starts = [referenceStart, started.success];
    const paged = yield* walk(io, baseUrl, started.success, Option.some(holds));
    const pagedJudged = yield* judge(io, baseUrl, paged);
    const judged = [...referenceJudged, ...pagedJudged.judged];
    if (Option.isSome(pagedJudged.unfinished))
      return yield* confirmed(io, path, judged, pagedJudged.unfinished, starts);
    const all = [...judged, ...crossCheck(reference, paged, path)];
    if (paged.pages.length === 1 && End.$is("Last")(paged.end) && Arr.isReadonlyArrayEmpty(all)) {
      return settled(
        path,
        all,
        Option.some(
          `\`${key}=${size}\` answered all ${counted(holds, "resource")} on one page, with no \`next\` to follow — the server does not page at that size`,
        ),
      );
    }
    return yield* confirmed(io, path, all, Option.none(), starts);
  });

/**
 * The page at a URL the rule built, where a walk starts, or why there is none.
 * A page of items none of which the kit can identify is no start: what it
 * lists cannot be compared with anything, so a walk from it would hold the
 * links to resources the kit never saw.
 */
const fetchPage = (
  io: Io,
  target: Option.Option<Target>,
  url: string,
): Effect.Effect<Result.Result<Page, string>> =>
  Option.match(target, {
    onNone: () => Effect.succeed(Result.fail(`${url} is not a URL the kit can request`)),
    onSome: (resolved) =>
      Effect.map(io.fetch(resolved), (answer) =>
        Option.match(answer, {
          onNone: () => Result.fail(REQUESTS_SPENT),
          onSome: (observation) =>
            Result.flatMap(
              Result.fromOption(pageOf(resolved, observation), () =>
                succeeded(observation)
                  ? `${url} answered ${observation.status} without a resource collection as primary data`
                  : `${url} answered ${statusOf(observation)}`,
              ),
              (page) =>
                opaque(page)
                  ? Result.fail(
                      `${url} answered a page of ${unidentified(page.items)}, so no walk can start from it`,
                    )
                  : Result.succeed(page),
            ),
        }),
      ),
  });

/**
 * The second walk held against the reference: every resource the reference
 * lists reached, and none it does not. Only a walk that ended at a page
 * without `next` is held to reaching everything — one cut short by a broken
 * link has already been reported for it.
 */
const crossCheck = (reference: Walk, paged: Walk, path: string): ReadonlyArray<Judged> => {
  const expected = keysOf(reference.pages);
  const reached = keysOf(paged.pages);
  const labels = (pages: ReadonlyArray<Page>, keep: (key: string) => boolean) =>
    Arr.dedupe(
      Arr.flatMap(pages, ({ members }) =>
        members.filter(({ key }) => keep(key)).map(({ label }) => label),
      ),
    );
  const start = Arr.headNonEmpty(paged.pages).url;
  const missed = End.$is("Last")(paged.end)
    ? labels(reference.pages, (key) => !HashSet.has(reached, key))
    : [];
  const extra = labels(paged.pages, (key) => !HashSet.has(expected, key));
  return [
    ...(Arr.isReadonlyArrayEmpty(missed)
      ? []
      : [
          {
            ordered: true,
            finding: finding(rule, {
              detail: `following \`next\` from ${start} never reached ${counted(missed.length, "resource")} ${path} lists`,
              expected: `every resource ${path} lists, on some page`,
              observed: `never reached: ${listed(missed)}`,
              probe: undefined,
            }),
          },
        ]),
    ...(Arr.isReadonlyArrayEmpty(extra)
      ? []
      : [
          {
            ordered: true,
            finding: finding(rule, {
              detail: `following \`next\` from ${start} reached ${counted(extra.length, "resource")} ${path} does not list`,
              expected: `only resources ${path} lists`,
              observed: `not in ${path}: ${listed(extra)}`,
              probe: undefined,
            }),
          },
        ]),
  ];
};

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** `true` when an endpoint declares a page size the kit can set. */
const declaresSize = (endpoint: Discovered): boolean =>
  SIZE_KEYS.some((key) => endpoint.queryKeys.includes(key));

/**
 * Walks every list and related endpoint that declares `page[limit]` or
 * `page[size]` and whose URL resolves.
 *
 * @internal
 */
export const linksEnumerateCollection: RuleImpl = {
  rule,
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = probeable(
        { ...ctx, endpoints: ctx.endpoints.filter(declaresSize) },
        COLLECTION_ROLES,
      );
      if (Arr.isReadonlyArrayEmpty(resolved)) {
        return skip(
          rule,
          Arr.isReadonlyArrayEmpty(unresolved)
            ? "no list or related endpoint declares `page[limit]` or `page[size]`, so there is no paginated collection to walk"
            : noProbeReason("paginated list or related endpoint", unresolved),
        );
      }
      const io = budgeted(ctx, REQUEST_BUDGET);
      const assessments = yield* Effect.forEach(
        resolved,
        ({ endpoint, path }) => assess(io, ctx.options.baseUrl, endpoint, path),
        { concurrency: 1 },
      );
      return outcomeOf(assessments, io.spent(), unresolved);
    }),
};

/**
 * Any finding fails the rule; otherwise it passes when at least one collection
 * was walked to a verdict, noting the ones that were not, and skips naming
 * each when none was.
 */
const outcomeOf = (
  assessments: ReadonlyArray<Assessment>,
  probes: number,
  unresolved: ReadonlyArray<string>,
): Outcome => {
  const findings = Arr.flatMap(assessments, ({ findings: found }) => found);
  const notes = Arr.filterMap(assessments, ({ where, unsettled }) =>
    Result.fromOption(
      Option.map(unsettled, (why) => `${where}: ${why}`),
      () => undefined,
    ),
  );
  if (Arr.isReadonlyArrayNonEmpty(findings)) return settle(rule, probes, findings);
  const decided = assessments.filter(({ unsettled }) => Option.isNone(unsettled));
  if (Arr.isReadonlyArrayEmpty(decided)) {
    return skip(
      rule,
      `no paginated collection could be walked to a verdict (${[...notes, ...unresolved].join("; ")})`,
    );
  }
  const note = [
    ...Option.toArray(
      Arr.isReadonlyArrayEmpty(notes)
        ? Option.none()
        : Option.some(
            `${notes.length} collection${notes.length === 1 ? "" : "s"} not decided: ${notes.join("; ")}`,
          ),
    ),
    ...Option.toArray(Option.fromUndefinedOr(coverageNote(unresolved))),
  ];
  return pass(rule, probes, Arr.isReadonlyArrayEmpty(note) ? undefined : note.join("; "));
};
