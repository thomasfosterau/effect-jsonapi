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
 * budget is reported as not checked, never as a partial pass.
 *
 * @since 0.17.0
 * @internal
 */
import {
  Array as Arr,
  Data,
  Effect,
  Formatter,
  HashSet,
  MutableHashMap,
  Option,
  Predicate,
  Result,
} from "effect";
import {
  type Context,
  coverageNote,
  describe,
  type Discovered,
  finding,
  type Finding,
  identity,
  isRecord,
  jsonApiAccept,
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

/** The longest server value a finding quotes, in UTF-16 code units. */
const QUOTE_LIMIT = 200;

/** The most resources a finding lists by name. */
const LIST_LIMIT = 10;

// ---------------------------------------------------------------------------
// Pages and links
// ---------------------------------------------------------------------------

/** A URL the kit can request: as sent, and as the absolute href it compares on. */
interface Target {
  readonly url: string;
  readonly href: string;
}

/** A resource a page lists, by the identity the kit compares on and its label. */
interface Member {
  readonly key: string;
  readonly label: string;
}

/** A page of the collection: where it was fetched, what came back, what it lists. */
interface Page extends Target {
  readonly observation: Observation;
  readonly members: ReadonlyArray<Member>;
}

/** A pagination link as a document carries it. */
type Link =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Href"; readonly href: string }
  | { readonly _tag: "Malformed"; readonly value: unknown };
const Link = Data.taggedEnum<Link>();

/** Where a link leads, or why the kit does not follow it. */
type Step =
  | { readonly _tag: "Follow"; readonly target: Target }
  | { readonly _tag: "Unparseable"; readonly href: string }
  | { readonly _tag: "Offsite"; readonly origin: string };
const Step = Data.taggedEnum<Step>();

/**
 * A server value as a finding quotes it: a string as itself, anything else
 * through `Formatter.format` (a JSON value can be `{"toString":1}`, which
 * `String` throws on), cut to {@link QUOTE_LIMIT}.
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- quotes whatever JSON a server put where a link belongs; it has no schema to parse it by
const quote = (value: unknown): string => {
  const text = Predicate.isString(value) ? value : Formatter.format(value);
  if (text.length <= QUOTE_LIMIT) return text;
  // Never split a surrogate pair: a high surrogate the cut would leave last goes too.
  const end = QUOTE_LIMIT - 1;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

/** Labels as one line, the first {@link LIST_LIMIT} by name and the rest counted. */
const listed = (labels: ReadonlyArray<string>): string =>
  labels.length > LIST_LIMIT
    ? `${labels.slice(0, LIST_LIMIT).join(", ")} and ${labels.length - LIST_LIMIT} more`
    : labels.join(", ");

/** `n resource(s)`. */
const resources = (count: number): string => `${count} resource${count === 1 ? "" : "s"}`;

/** The `links` member `name` of a page's document. */
const linkOf = (page: Page, name: string): Link => {
  const body = page.observation.body;
  const links = isRecord(body) ? body["links"] : undefined;
  const value = isRecord(links) ? links[name] : undefined;
  if (Predicate.isNullish(value)) return Link.Unavailable();
  if (Predicate.isString(value)) return Link.Href({ href: value });
  const href = isRecord(value) ? value["href"] : undefined;
  return Predicate.isString(href) ? Link.Href({ href }) : Link.Malformed({ value });
};

/**
 * The URL a run sends for an absolute href: relative to the run's base URL
 * when it lies under it, so the report reads as the other rules' do, and
 * absolute otherwise.
 */
const targetOf = (href: string, baseUrl: string): Target => {
  const base = baseUrl.replace(/\/$/, "");
  return { url: href.startsWith(`${base}/`) ? href.slice(base.length) : href, href };
};

/** A URL a rule built — the endpoint's path, with or without a page size — as a target. */
const own = (url: string, baseUrl: string): Option.Option<Target> => {
  const absolute = url.startsWith("http") ? url : `${baseUrl.replace(/\/$/, "")}${url}`;
  return URL.canParse(absolute)
    ? Option.some({ url, href: new URL(absolute).href })
    : Option.none();
};

/**
 * Where a link found on `from` leads. A link is resolved against the page it
 * was found on, as a browser would; one that leads off the run's origin is
 * not followed, so a server cannot point the kit at another host.
 */
const stepTo = (href: string, from: Page, baseUrl: string): Step => {
  if (!URL.canParse(href, from.href)) return Step.Unparseable({ href });
  const resolved = new URL(href, from.href);
  const origin = new URL(URL.canParse(baseUrl) ? baseUrl : from.href).origin;
  return resolved.origin === origin
    ? Step.Follow({ target: targetOf(resolved.href, baseUrl) })
    : Step.Offsite({ origin: resolved.origin });
};

/** A response as a page of the collection, when it is one: 2xx, with `data` an array. */
const pageOf = (target: Target, observation: Observation): Option.Option<Page> => {
  const data = isRecord(observation.body) ? observation.body["data"] : undefined;
  return succeeded(observation) && Array.isArray(data)
    ? Option.some({
        ...target,
        observation,
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

/**
 * The rule's requests, under its request budget, with each answer remembered
 * by href so a `first` or `last` link to a page the walk already fetched costs
 * nothing. `fetch` answers `None` once the budget is spent.
 */
interface Io {
  readonly fetch: (target: Target) => Effect.Effect<Option.Option<Observation>>;
  /** As `fetch`, but always asks the server again. */
  readonly refetch: (target: Target) => Effect.Effect<Option.Option<Observation>>;
  readonly spent: () => number;
}

const budgeted = (ctx: Context): Io => {
  let spent = 0;
  const answers = MutableHashMap.empty<string, Observation>();
  const refetch = (target: Target): Effect.Effect<Option.Option<Observation>> =>
    Effect.suspend(() => {
      if (spent >= REQUEST_BUDGET) return Effect.succeed(Option.none());
      spent += 1;
      return ctx.request({ url: target.url, headers: jsonApiAccept }).pipe(
        Effect.tap((observation) =>
          Effect.sync(() => MutableHashMap.set(answers, target.href, observation)),
        ),
        Effect.map(Option.some),
      );
    });
  return {
    refetch,
    fetch: (target) =>
      Effect.suspend(() =>
        Option.match(MutableHashMap.get(answers, target.href), {
          onNone: () => refetch(target),
          onSome: (observation) => Effect.succeed(Option.some(observation)),
        }),
      ),
    spent: () => spent,
  };
};

const REQUESTS_SPENT = `the rule's budget of ${REQUEST_BUDGET} requests ran out before the walk ended`;

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

/** How a walk ended. Page numbers are 1-based, as a finding names them. */
type End =
  | { readonly _tag: "Last" }
  | { readonly _tag: "Cycle"; readonly from: number; readonly to: number }
  | { readonly _tag: "Empty"; readonly from: number; readonly observation: Observation }
  | { readonly _tag: "NotAPage"; readonly from: number; readonly observation: Observation }
  | { readonly _tag: "NotALink"; readonly from: number; readonly value: unknown }
  | { readonly _tag: "Offsite"; readonly from: number; readonly origin: string }
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
 * page, or a page that lists no resources; a page that lists nothing earlier pages did
 * not (a `next` that would never end); more resources than `holds`, when the
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
  if (Step.$is("Offsite")(to)) return Result.fail(End.Offsite({ from, origin: to.origin }));
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
  const page = pageOf(target, observation);
  if (Option.isNone(page)) return Result.fail({ pages, end: End.NotAPage({ from, observation }) });
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
        detail: `following \`next\` from ${start} listed ${resources(repeats.length)} a second time${stalled}`,
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
const unfinishedOf = (end: End, pages: ReadonlyArray<Page>): Option.Option<string> =>
  End.$match(end, {
    Offsite: ({ from, origin }) =>
      Option.some(
        `\`next\` on page ${from} (${pages[from - 1]?.url ?? ""}) leads to another origin, ${origin}, which the kit does not follow`,
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

/** What a `first` or `last` link answered, held against the page the walk found there. */
const compareEndPage = (
  name: "first" | "last",
  carrier: Page,
  expected: Page,
  target: Target,
  observation: Observation,
): ReadonlyArray<Judged> => {
  const which = name === "first" ? "first page" : "last page `next` reaches";
  return Option.match(pageOf(target, observation), {
    onNone: () => [
      {
        ordered: false,
        finding: finding(rule, {
          detail: `\`${name}\` on ${carrier.url} leads to a response that is not a page of the collection`,
          expected: `the ${which}, ${expected.url}`,
          observed: describe(observation),
          probe: observation.probe,
        }),
      },
    ],
    onSome: (page) => {
      const answered = keysOf([page]);
      const wanted = keysOf([expected]);
      return HashSet.isSubset(answered, wanted) && HashSet.isSubset(wanted, answered)
        ? []
        : [
            {
              ordered: true,
              finding: finding(rule, {
                detail: `\`${name}\` on ${carrier.url} answers different resources from the ${which}`,
                expected: `${named(expected)} (${expected.url})`,
                observed: `${named(page)} (${page.url})`,
                probe: observation.probe,
              }),
            },
          ];
    },
  });
};

/**
 * Checks the `first` or `last` link a walk's first page carries against the
 * page the walk found there: both must list the same resources.
 */
const checkEndLink = (
  io: Io,
  baseUrl: string,
  name: "first" | "last",
  carrier: Page,
  expected: Page,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Result.match(endLinkTarget(baseUrl, name, carrier, expected), {
    onFailure: (judged) => Effect.succeed([judged]),
    onSuccess: (target) =>
      Option.match(target, {
        onNone: () => Effect.succeed([]),
        onSome: (resolved) =>
          Effect.map(io.fetch(resolved), (answer) =>
            Option.match(answer, {
              onNone: () => [],
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
      : [];
    return {
      judged: [...judgeEnd(run, first.url), ...firsts, ...lasts],
      unfinished: unfinishedOf(run.end, run.pages),
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
 * Re-asks for each page a walk started from, and says how the order changed
 * if a second answer lists its resources in a different order from the
 * first — the case JSON:API leaves to the server when no `sort` is given.
 */
const reordered = (io: Io, starts: ReadonlyArray<Page>): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const again = yield* Effect.forEach(starts, (start) => io.refetch(start), {
      concurrency: 1,
    });
    return Arr.findFirst(Arr.zip(starts, again), ([start, answer]) =>
      Option.exists(
        Option.flatMap(answer, (observation) => pageOf(start, observation)),
        (page) => sequenceOf(page) !== sequenceOf(start),
      ),
    ).pipe(Option.map(([start]) => start.url));
  });

const unstable = (url: string, withheld: number): string =>
  `the collection's order is not stable — asked for ${url} a second time, the server listed its resources in a different order — and JSON:API requires no stable order without \`sort\` (§Sorting: "The server MAY apply default sorting rules to top-level \`data\` if request parameter \`sort\` is not specified"), so the walk's ${withheld} order-dependent finding${withheld === 1 ? "" : "s"} (resources repeated or missed across pages, or a \`first\` / \`last\` page that disagrees) cannot be held against the links`;

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
      holds < 2
        ? Option.some(
            `the collection holds ${holds === 0 ? "no resources" : "one resource"} — fewer than two, so no page size forces a second page`,
          )
        : Option.none(),
    );
    if (Option.isSome(blocked)) return settled(path, judged.judged, blocked);
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
    const started = yield* fetchPage(io, own(sized, baseUrl), sized);
    if (Result.isFailure(started))
      return settled(path, referenceJudged, Option.some(started.failure));
    const paged = yield* walk(io, baseUrl, started.success, Option.some(holds));
    const pagedJudged = yield* judge(io, baseUrl, paged);
    const judged = [...referenceJudged, ...pagedJudged.judged];
    if (Option.isSome(pagedJudged.unfinished)) return settled(path, judged, pagedJudged.unfinished);
    const all = [...judged, ...crossCheck(reference, paged, path)];
    if (paged.pages.length === 1 && End.$is("Last")(paged.end) && Arr.isReadonlyArrayEmpty(all)) {
      return settled(
        path,
        all,
        Option.some(
          `\`${key}=${size}\` answered all ${resources(holds)} on one page, with no \`next\` to follow — the server does not page at that size`,
        ),
      );
    }
    const ordered = all.filter(({ ordered: dependsOnOrder }) => dependsOnOrder);
    if (Arr.isReadonlyArrayEmpty(ordered)) return settled(path, all, Option.none());
    const moved = yield* reordered(io, [Arr.headNonEmpty(reference.pages), started.success]);
    return Option.match(moved, {
      onNone: () => settled(path, all, Option.none()),
      onSome: (url) =>
        settled(
          path,
          all.filter(({ ordered: dependsOnOrder }) => !dependsOnOrder),
          Option.some(unstable(url, ordered.length)),
        ),
    });
  });

/** The page at a URL the rule built, or why there is none. */
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
            Result.fromOption(pageOf(resolved, observation), () =>
              succeeded(observation)
                ? `${url} answered ${observation.status} without a resource collection as primary data`
                : `${url} answered ${statusOf(observation)}`,
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
              detail: `following \`next\` from ${start} never reached ${resources(missed.length)} ${path} lists`,
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
              detail: `following \`next\` from ${start} reached ${resources(extra.length)} ${path} does not list`,
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
      const io = budgeted(ctx);
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
