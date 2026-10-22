/**
 * The profile's sort rules: `docs/filter-grammar.md` §10, checked from the
 * wire.
 *
 * Read-only and fixture-free. Each rule fetches every list or related endpoint
 * that declares `sort` once, picks from that answer the attributes whose
 * values could show what it checks, and asks for the collection sorted by
 * them, holding each answer to §10:
 *
 * - `profile/sort/ordering` — `?sort=f` and `?sort=-f` for an attribute that
 *   shows two distinct values, in F-ORD-1's order of its JSON value, NULLs (an
 *   absent member or `null`) last ascending and first descending (S-ORD-1 to
 *   S-ORD-3).
 * - `profile/sort/multi-field` — `?sort=a,-b` and `?sort=-a,b` for an
 *   attribute `a` two resources tie on and an attribute `b` that tells them
 *   apart, in lexicographic order of the terms (S-MULTI-1).
 * - `profile/sort/id-tiebreak` — `?sort=f` and `?sort=-f` for an attribute two
 *   resources tie on: a SHOULD that they are listed in the same relative order
 *   both times, the fixed `id` tiebreak (S-TIE-1, S-TIE-2).
 * - `profile/sort/across-pages` — `?sort=f` at a page size that cuts the
 *   collection in two at least, its `next` links followed: every resource on
 *   a page follows every resource on the page before it (S-PAGE-1).
 *
 * An attribute the server refuses to sort by (a 400) is passed over for the
 * next; one whose answers cannot show what the rule checks — values of more
 * than one JSON type (S-KEY-2), say — decides nothing.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type * as Schema from "effect/Schema";
import {
  type Context,
  coverageNote,
  type Discovered,
  finding,
  type Finding,
  identity,
  isRecord,
  jsonApiAccept,
  type Observation,
  resolvePath,
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
  answeredFrom,
  counted,
  Link,
  linkIn,
  listed,
  own,
  quote,
  Step,
  stepTo,
  type Target,
  unanswered,
} from "./crawl.js";

const REFERENCE =
  "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md";

const rule: Rule = {
  id: "profile/sort/ordering",
  tier: "profile",
  section: "filter-grammar/v1 §10 Sort order",
  reference: `${REFERENCE}#10-sort-order`,
  level: "MUST",
  requirement:
    "`?sort=f` MUST list a collection's primary data in ascending order of `f`'s JSON value — F-ORD-1's order for that JSON type: numeric, code-point, `false` < `true` — with every NULL (an absent member or `null`) after every value, and `?sort=-f` MUST list it in exactly the reverse order, NULLs first (S-ORD-1 to S-ORD-3).",
};

const multiRule: Rule = {
  id: "profile/sort/multi-field",
  tier: "profile",
  section: "filter-grammar/v1 §10.4 Several fields",
  reference: `${REFERENCE}#104-several-fields`,
  level: "MUST",
  requirement:
    "`?sort=f₁,f₂,…` MUST order the primary data by `f₁`, the resources that tie on `f₁` by `f₂`, and so on, each term in its own direction — so `?sort=a,-b` lists the resources that tie on `a` in descending order of `b` (S-MULTI-1).",
};

const tieRule: Rule = {
  id: "profile/sort/id-tiebreak",
  tier: "profile",
  section: "filter-grammar/v1 §10.5 Ties and stability",
  reference: `${REFERENCE}#105-ties-and-stability`,
  level: "SHOULD",
  requirement:
    "A server SHOULD break every tie left after the last sort field by `id`, in one fixed order the same for every request, so that resources tying on `f` are listed in the same relative order under `?sort=f` and `?sort=-f` (S-TIE-1, S-TIE-2).",
};

const pageRule: Rule = {
  id: "profile/sort/across-pages",
  tier: "profile",
  section: "filter-grammar/v1 §10.6 With `filter` and `page`",
  reference: `${REFERENCE}#106-with-filter-and-page`,
  level: "MUST",
  requirement:
    "The order `sort` asks for MUST be the whole collection's, before `page` cuts it into pages: walking `next` through `?sort=f`, every resource on a page follows every resource on the page before it (S-PAGE-1).",
};

/** The requests one run of `profile/sort/ordering` may make, over every endpoint it probes. */
const REQUEST_BUDGET = 60;

/** The requests one run of `profile/sort/multi-field` or `profile/sort/id-tiebreak` may make. */
const PAIR_BUDGET = 40;

/** The requests one run of `profile/sort/across-pages` may make, its walks' pages included. */
const PAGE_REQUEST_BUDGET = 60;

/** The pages one walk of `profile/sort/across-pages` may fetch. */
const PAGE_BUDGET = 10;

/**
 * The most attributes `profile/sort/ordering` decides per endpoint: the first
 * that holds a NULL in its answers, or failing that two.
 */
const FIELDS_PER_ENDPOINT = 2;

/** The most candidates the other rules try per endpoint, when the first decide nothing. */
const TRIES_PER_ENDPOINT = 3;

/** The page-size parameters `profile/sort/across-pages` can set, in the order it prefers them. */
const SIZE_KEYS = ["page[limit]", "page[size]"] as const;

const budgetSpent = (limit: number): string => `the rule's ${limit}-request budget ran out`;

/**
 * A sort key read off one resource's JSON representation (S-KEY-1): NULL for
 * an absent member or `null`, a JSON scalar as itself, and anything else —
 * an object, an array — as a value this profile defines no order on (S-KEY-2).
 */
type Key =
  | { readonly kind: "null" }
  | { readonly kind: "string"; readonly value: string }
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "unordered" };

const NULL: Key = { kind: "null" };

/** A resource object's `attributes`, or none when it carries no such record. */
const attributesOf = (resource: Schema.Json): Readonly<Record<string, unknown>> =>
  isRecord(resource) && isRecord(resource["attributes"]) ? resource["attributes"] : {};

const keyOf = (resource: Schema.Json, field: string): Key => {
  const value = attributesOf(resource)[field];
  if (Predicate.isNullish(value)) return NULL;
  if (Predicate.isString(value)) return { kind: "string", value };
  if (Predicate.isNumber(value)) return { kind: "number", value };
  if (Predicate.isBoolean(value)) return { kind: "boolean", value };
  return { kind: "unordered" };
};

const codePoints = (text: string): ReadonlyArray<number> =>
  Arr.map(Arr.fromIterable(text), (char) => char.codePointAt(0) ?? 0);

/** Code-point order (F-ORD-2), which JavaScript's `<` on strings — UTF-16 code units — is not. */
const compareCodePoints = (left: string, right: string): number => {
  const a = codePoints(left);
  const b = codePoints(right);
  return Option.getOrElse(
    Arr.findFirst(
      Arr.zipWith(a, b, (x, y) => x - y),
      (difference) => difference !== 0,
    ),
    () => a.length - b.length,
  );
};

const compareNumbers = (left: number, right: number): number =>
  left === right ? 0 : left < right ? -1 : 1;

/** A number or boolean key as the number it orders as (`false` < `true`). */
const numeric = (key: Key): number =>
  key.kind === "number" ? key.value : key.kind === "boolean" ? Number(key.value) : 0;

/**
 * The ascending order S-ORD-1 and S-ORD-3 define, on two keys of one JSON
 * type or NULL: negative, zero or positive. NULL follows every value and ties
 * with NULL (S-ORD-4); `-0` ties with `0`. Keys of two different JSON types
 * are never compared: {@link typeProblem} sets such an attribute aside first.
 */
const compare = (left: Key, right: Key): number => {
  const nulls = Number(left.kind === "null") - Number(right.kind === "null");
  if (nulls !== 0 || left.kind === "null") return nulls;
  return left.kind === "string" && right.kind === "string"
    ? compareCodePoints(left.value, right.value)
    : compareNumbers(numeric(left), numeric(right));
};

const render = (key: Key): string => {
  if (key.kind === "null") return "NULL";
  if (key.kind === "string") return `"${key.value}"`;
  if (key.kind === "unordered") return "a non-scalar value";
  return `${key.value}`;
};

/** The primary data of a resource collection answer, when it is one. */
const collectionOf = (observation: Observation): Option.Option<ReadonlyArray<Schema.Json>> => {
  const data = isRecord(observation.body) ? observation.body["data"] : undefined;
  return Array.isArray(data) ? Option.some(data) : Option.none();
};

/** The primary data of a 2xx resource collection answer, when it is one. */
const servedCollection = (observation: Observation): Option.Option<ReadonlyArray<Schema.Json>> =>
  Option.filter(collectionOf(observation), () => succeeded(observation));

/** What an answer that is not a 2xx resource collection answered, for a note. */
const notACollection = (observation: Observation): string =>
  `${statusOf(observation)}${succeeded(observation) ? ", not a resource collection" : ""}`;

/**
 * Why `keys` have no order, when they have none: a non-scalar value among
 * them, or values of more than one JSON type besides NULL (S-KEY-2).
 */
const typeProblem = (keys: ReadonlyArray<Key>): Option.Option<string> => {
  const kinds = Arr.dedupe(Arr.flatMap(keys, (key) => (key.kind === "null" ? [] : [key.kind])));
  if (Arr.contains(kinds, "unordered"))
    return Option.some("holds a non-scalar value, which has no order (S-KEY-2)");
  if (kinds.length > 1)
    return Option.some(
      `holds values of more than one JSON type (${kinds.join(", ")}), which have no order (S-KEY-2)`,
    );
  return Option.none();
};

/** The keys of `keys` that differ under {@link compare}, each once. */
const distinctKeys = (keys: ReadonlyArray<Key>): ReadonlyArray<Key> =>
  Arr.dedupeWith(keys, (left, right) => compare(left, right) === 0);

/**
 * Why `keys` cannot show an order, when they cannot: they can when they hold
 * two distinct keys at least, NULL counting as one, all of one JSON scalar
 * type besides NULL.
 */
const undiscriminating = (keys: ReadonlyArray<Key>): Option.Option<string> =>
  Option.orElse(typeProblem(keys), () => {
    const distinct = distinctKeys(keys);
    if (distinct.length >= 2) return Option.none();
    return Option.some(
      `shows ${Arr.isReadonlyArrayEmpty(distinct) ? "no value" : "one distinct value"}, which cannot show an order`,
    );
  });

const keysOf = (data: ReadonlyArray<Schema.Json>, field: string): ReadonlyArray<Key> =>
  Arr.map(data, (resource) => keyOf(resource, field));

/** The attribute names any resource of `data` carries, each once, in the order first seen. */
const namesOf = (data: ReadonlyArray<Schema.Json>): ReadonlyArray<string> =>
  Arr.dedupe(Arr.flatMap(data, (resource) => Rec.keys(attributesOf(resource))));

/** The attributes of `data` whose values are of one JSON scalar type besides NULL. */
const orderedNamesOf = (data: ReadonlyArray<Schema.Json>): ReadonlyArray<string> =>
  Arr.filter(namesOf(data), (name) => Option.isNone(typeProblem(keysOf(data, name))));

/**
 * The resources of `data` that tie on `field` (S-ORD-4), as groups of two or
 * more: equal under F-ORD-1, or both NULL.
 */
const tiesOf = (
  data: ReadonlyArray<Schema.Json>,
  field: string,
): ReadonlyArray<ReadonlyArray<Schema.Json>> =>
  Arr.filter(
    Arr.map(distinctKeys(keysOf(data, field)), (key) =>
      Arr.filter(data, (resource) => compare(keyOf(resource, field), key) === 0),
    ),
    (group) => group.length >= 2,
  );

/**
 * The attributes a baseline answer could decide the ordering rule on, those
 * holding a NULL first — so NULL placement is checked wherever the collection
 * shows one.
 */
const candidatesOf = (data: ReadonlyArray<Schema.Json>): ReadonlyArray<string> => {
  const usable = Arr.filter(namesOf(data), (name) =>
    Option.isNone(undiscriminating(keysOf(data, name))),
  );
  const holdsNull = (name: string) =>
    Arr.some(data, (resource) => keyOf(resource, name).kind === "null");
  return [...Arr.filter(usable, holdsNull), ...Arr.filter(usable, (name) => !holdsNull(name))];
};

type Direction = "ascending" | "descending";

const termFor = (field: string, direction: Direction): string =>
  direction === "ascending" ? field : `-${field}`;

/** One term of a `sort`: a field and its direction. */
interface Term {
  readonly field: string;
  readonly direction: Direction;
}

const sortOf = (terms: ReadonlyArray<Term>): string =>
  Arr.map(terms, ({ field, direction }) => termFor(field, direction)).join(",");

/** Each resource of `data` as its keys under `terms`, in order: the row `terms` sort it by. */
const rowsOf = (
  data: ReadonlyArray<Schema.Json>,
  terms: ReadonlyArray<Term>,
): ReadonlyArray<ReadonlyArray<Key>> =>
  Arr.map(data, (resource) => Arr.map(terms, ({ field }) => keyOf(resource, field)));

/** The order `terms` ask for on two rows, lexicographic over them (S-MULTI-1): negative, zero or positive. */
const compareBy =
  (terms: ReadonlyArray<Term>) =>
  (left: ReadonlyArray<Key>, right: ReadonlyArray<Key>): number =>
    Option.getOrElse(
      Arr.findFirst(
        Arr.zipWith(Arr.zip(left, right), terms, ([l, r], { direction }) =>
          direction === "ascending" ? compare(l, r) : -compare(l, r),
        ),
        (order) => order !== 0,
      ),
      () => 0,
    );

/** The resource of `data` at `at` as a finding names it: `type:id`, or its position. */
const labelAt = (data: ReadonlyArray<Schema.Json>, at: number): string =>
  Option.match(Option.filter(Arr.get(data, at), isRecord), {
    onNone: () => `/data/${at}`,
    onSome: (resource) => resourceLabel(resource),
  });

/** The first adjacent pair of `data` out of the order `direction` asks for, as a finding. */
const outOfOrder = (
  observation: Observation,
  data: ReadonlyArray<Schema.Json>,
  field: string,
  direction: Direction,
): Option.Option<Finding> => {
  const keys = keysOf(data, field);
  const sign = direction === "ascending" ? 1 : -1;
  const pairs = Arr.map(Arr.zip(keys, Arr.drop(keys, 1)), ([left, right], index) => ({
    left,
    right,
    index,
  }));
  const label = (at: number): string => labelAt(data, at);
  return Option.map(
    Arr.findFirst(pairs, ({ left, right }) => sign * compare(left, right) > 0),
    ({ left, right, index }) => {
      const nulls =
        left.kind === "null" || right.kind === "null"
          ? direction === "ascending"
            ? " — a NULL sorts after every value ascending (S-ORD-3)"
            : " — a NULL sorts before every value descending (S-ORD-3)"
          : "";
      return finding(rule, {
        detail: `\`?sort=${termFor(field, direction)}\` lists ${quote(label(index))} (${quote(render(left))}) before ${quote(label(index + 1))} (${quote(render(right))})${nulls}`,
        expected:
          direction === "ascending"
            ? `primary data in ascending order of \`${field}\` under F-ORD-1, NULLs last (S-ORD-1, S-ORD-3)`
            : `primary data in descending order of \`${field}\`, the exact reverse of ascending, NULLs first (S-ORD-2, S-ORD-3)`,
        observed: `\`${field}\` in the order served: ${quote(Arr.map(keys, render).join(", "))}`,
        probe: observation.probe,
      });
    },
  );
};

/** What one candidate's sorted requests decided. */
type Decision = Data.TaggedEnum<{
  Decided: { readonly findings: ReadonlyArray<Finding>; readonly sawNull: boolean };
  Refused: Record<never, never>;
  Undecided: { readonly why: string };
}>;

const Decision = Data.taggedEnum<Decision>();

/** A decision with no NULL to report on: every rule but the ordering rule's. */
const decided = (findings: ReadonlyArray<Finding>): Decision =>
  Decision.Decided({ findings, sawNull: false });

/** The requests a rule has sent so far, redirects followed included, against its limit. */
interface Budget {
  spent: number;
  readonly limit: number;
}

const exhausted = (budget: Budget): boolean => budget.spent >= budget.limit;

const requested = (ctx: Context, budget: Budget, url: string) =>
  Effect.map(
    ctx.request({ url, headers: jsonApiAccept, requests: budget.limit - budget.spent }),
    (observation) => {
      budget.spent += 1 + observation.redirects.length;
      return observation;
    },
  );

/** A sorted request's 2xx resource collection answer. */
interface Answer {
  readonly observation: Observation;
  readonly data: ReadonlyArray<Schema.Json>;
}

/**
 * One sorted request, as the rules read it: a 400 is the server refusing to
 * sort so (§Sorting), not a statement about order, and an answer that is not
 * a 2xx resource collection decides nothing; any other answer is the
 * collection to judge.
 */
const sortedAnswer = (
  ctx: Context,
  budget: Budget,
  url: string,
  term: string,
): Effect.Effect<Result.Result<Answer, Decision>> =>
  Effect.map(requested(ctx, budget, url), (observation) => {
    if (observation.status === 400) return Result.fail(Decision.Refused());
    return Option.match(servedCollection(observation), {
      onNone: () =>
        Result.fail(
          Decision.Undecided({ why: `\`?sort=${term}\` answered ${notACollection(observation)}` }),
        ),
      onSome: (data) => Result.succeed({ observation, data }),
    });
  });

/** {@link sortedAnswer}, its collection `judge`d. */
const sortedRequest = (
  ctx: Context,
  budget: Budget,
  url: string,
  term: string,
  judge: (observation: Observation, data: ReadonlyArray<Schema.Json>) => Decision,
) =>
  Effect.map(
    sortedAnswer(ctx, budget, url, term),
    Result.match({
      onFailure: (decision) => decision,
      onSuccess: ({ observation, data }) => judge(observation, data),
    }),
  );

/** One sorted request of the ordering rule: the keys it lists, its finding if any, or why it decides nothing. */
const probe = (ctx: Context, budget: Budget, path: string, field: string, direction: Direction) => {
  const term = termFor(field, direction);
  return sortedRequest(
    ctx,
    budget,
    withQuery(path, [["sort", term]]),
    term,
    (observation, data) => {
      const keys = keysOf(data, field);
      return Option.match(undiscriminating(keys), {
        onSome: (why) => Decision.Undecided({ why: `\`?sort=${term}\` ${why}` }),
        onNone: () =>
          Decision.Decided({
            findings: Option.toArray(outOfOrder(observation, data, field, direction)),
            sawNull: Arr.some(keys, (key) => key.kind === "null"),
          }),
      });
    },
  );
};

/**
 * Two requests for one candidate, the second sent only when the first was
 * decided and the budget allows: both findings when both decide, else the
 * first's finding when it made one, else what stopped the second. A finding
 * the first request made stands even when the second then decides nothing.
 */
const both = (budget: Budget, first: Effect.Effect<Decision>, second: Effect.Effect<Decision>) =>
  Effect.gen(function* () {
    const one = yield* first;
    if (!Decision.$is("Decided")(one)) return one;
    if (exhausted(budget)) {
      return Arr.isReadonlyArrayNonEmpty(one.findings)
        ? one
        : Decision.Undecided({ why: budgetSpent(budget.limit) });
    }
    const two = yield* second;
    if (Decision.$is("Decided")(two)) {
      return Decision.Decided({
        findings: [...one.findings, ...two.findings],
        sawNull: one.sawNull || two.sawNull,
      });
    }
    return Arr.isReadonlyArrayNonEmpty(one.findings) ? one : two;
  });

/**
 * Asks for `path` sorted by `field` both ways, and holds each answer to its
 * order.
 */
const decideOrder = (ctx: Context, budget: Budget, path: string, field: string) =>
  both(
    budget,
    probe(ctx, budget, path, field, "ascending"),
    probe(ctx, budget, path, field, "descending"),
  );

// ---------------------------------------------------------------------------
// The shared walk over endpoints and candidates
// ---------------------------------------------------------------------------

/** An endpoint a rule probes, and the URL it resolved to. */
interface At {
  readonly endpoint: Discovered;
  readonly path: string;
}

/**
 * One sort rule's shape: which endpoints it probes, what it reads off an
 * endpoint's baseline answer to try, and how it decides one of those.
 */
interface Suite<A> {
  readonly rule: Rule;
  readonly limit: number;
  /** Whether an endpoint declaring `sort` is one this rule probes, beyond that. */
  readonly applies: (endpoint: Discovered) => boolean;
  /** What the endpoints this rule probes declare, for the skip that finds none. */
  readonly declares: string;
  /** What this rule tries, read off a baseline answer's primary data, best first. */
  readonly candidates: (data: ReadonlyArray<Schema.Json>) => ReadonlyArray<A>;
  /** Why a baseline answer of `count` resources offers nothing to try. */
  readonly nothingToTry: (count: number) => string;
  /** A candidate as a note names it. */
  readonly name: (candidate: A) => string;
  /** Whether `tally` has decided enough of one endpoint. */
  readonly enough: (tally: Tally) => boolean;
  readonly decide: (
    ctx: Context,
    budget: Budget,
    at: At,
    data: ReadonlyArray<Schema.Json>,
    candidate: A,
  ) => Effect.Effect<Decision>;
  /** What the skip that decides nothing anywhere says could not be observed. */
  readonly unobserved: string;
  /** Notes from what the endpoints decided, beside the rule's own. */
  readonly notes: (probed: ReadonlyArray<Probed>) => ReadonlyArray<string>;
}

/** The endpoints `suite` applies to (S-SCOPE-1): a list or related endpoint that declares `sort`. */
const sortable = <A>(ctx: Context, suite: Suite<A>) => {
  const applies = Arr.filter(
    ctx.endpoints,
    (endpoint) =>
      (endpoint.role === "collection" || endpoint.role === "related") &&
      endpoint.queryKeys.includes("sort") &&
      suite.applies(endpoint),
  );
  const resolutions = Arr.map(applies, (endpoint) => ({
    endpoint,
    resolution: resolvePath(endpoint, ctx.options),
  }));
  return {
    resolved: Arr.flatMap(resolutions, ({ endpoint, resolution }) =>
      resolution._tag === "Resolved" ? [{ endpoint, path: resolution.path }] : [],
    ),
    unresolved: Arr.flatMap(resolutions, ({ resolution }) =>
      resolution._tag === "Unresolved" ? [resolution.reason] : [],
    ),
  };
};

/** What a rule decided on one endpoint. */
interface Probed {
  readonly decided: number;
  readonly sawNull: boolean;
  readonly findings: ReadonlyArray<Finding>;
  /** Why nothing was decided there, when nothing was. */
  readonly undecided: Option.Option<string>;
}

/** What the candidates tried on one endpoint decided, before it is summed up. */
interface Tally {
  decided: number;
  sawNull: boolean;
  readonly findings: Array<Finding>;
  readonly refused: Array<string>;
  readonly notDecided: Array<string>;
}

const record = (tally: Tally, name: string, decision: Decision): void =>
  Decision.$match(decision, {
    Refused: () => {
      tally.refused.push(name);
    },
    Undecided: ({ why }) => {
      tally.notDecided.push(`${name}: ${why}`);
    },
    Decided: (outcome) => {
      tally.decided += 1;
      tally.sawNull ||= outcome.sawNull;
      tally.findings.push(...outcome.findings);
    },
  });

/** Tries `candidates` in turn until `suite.enough` of them are decided or the budget runs out. */
const tallyOf = <A>(
  ctx: Context,
  suite: Suite<A>,
  budget: Budget,
  at: At,
  data: ReadonlyArray<Schema.Json>,
  candidates: ReadonlyArray<A>,
) =>
  Effect.gen(function* () {
    const tally: Tally = {
      decided: 0,
      sawNull: false,
      findings: [],
      refused: [],
      notDecided: [],
    };
    // `findFirst` walks `candidates` in order and stops at the first `true`:
    // the early exit once the tally has enough or the budget is spent.
    yield* Effect.findFirst(candidates, (candidate) => {
      if (suite.enough(tally)) return Effect.succeed(true);
      if (exhausted(budget)) {
        tally.notDecided.push(budgetSpent(budget.limit));
        return Effect.succeed(true);
      }
      return Effect.map(suite.decide(ctx, budget, at, data, candidate), (outcome) => {
        record(tally, suite.name(candidate), outcome);
        return false;
      });
    });
    return tally;
  });

/** Why an endpoint `tally` decided nothing on was not decided. */
const whyNot = (tally: Tally): string =>
  [
    ...(Arr.isReadonlyArrayEmpty(tally.refused)
      ? []
      : [`refused \`sort\` by ${listed(tally.refused)} with a 400 (not sortable there)`]),
    ...tally.notDecided,
  ].join("; ");

/** Fetches the collection at `path` and decides what `suite` tries on it. */
const probeEndpoint = <A>(ctx: Context, suite: Suite<A>, budget: Budget, at: At) =>
  Effect.gen(function* () {
    const { path } = at;
    const nothing = (why: string): Probed => ({
      decided: 0,
      sawNull: false,
      findings: [],
      undecided: Option.some(`${path}: ${why}`),
    });
    if (exhausted(budget)) return nothing(`not probed, ${budgetSpent(budget.limit)}`);
    const baseline = yield* requested(ctx, budget, path);
    const collection = servedCollection(baseline);
    if (Option.isNone(collection)) return nothing(`answered ${notACollection(baseline)}`);
    const candidates = suite.candidates(collection.value);
    if (Arr.isReadonlyArrayEmpty(candidates)) {
      return nothing(suite.nothingToTry(collection.value.length));
    }
    const tally = yield* tallyOf(ctx, suite, budget, at, collection.value, candidates);
    if (tally.decided === 0) return nothing(whyNot(tally));
    const probed: Probed = {
      decided: tally.decided,
      sawNull: tally.sawNull,
      findings: tally.findings,
      undecided: Option.none(),
    };
    return probed;
  });

const runSuite = <A>(suite: Suite<A>): RuleImpl => ({
  rule: suite.rule,
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = sortable(ctx, suite);
      if (Arr.isReadonlyArrayEmpty(resolved)) {
        return skip(
          suite.rule,
          Arr.isReadonlyArrayEmpty(unresolved)
            ? `no list or related endpoint in this api declares ${suite.declares}`
            : `no list or related endpoint declaring ${suite.declares} with a resolvable URL: ${unresolved.join("; ")}`,
        );
      }
      const budget: Budget = { spent: 0, limit: suite.limit };
      // One endpoint at a time: every endpoint draws on the one request budget.
      const probed = yield* Effect.forEach(
        resolved,
        (at) => probeEndpoint(ctx, suite, budget, at),
        { concurrency: 1 },
      );
      const undecided = Arr.getSomes(Arr.map(probed, ({ undecided }) => undecided));
      if (!Arr.some(probed, ({ decided }) => decided > 0)) {
        return skip(suite.rule, `${suite.unobserved}: ${undecided.join("; ")}`);
      }
      const notes = [
        ...suite.notes(probed),
        ...(Arr.isReadonlyArrayEmpty(undecided) ? [] : [`not decided: ${undecided.join("; ")}`]),
        ...Option.toArray(Option.fromUndefinedOr(coverageNote(unresolved))),
      ];
      return settle(
        suite.rule,
        budget.spent,
        Arr.flatMap(probed, ({ findings }) => findings),
        Arr.isReadonlyArrayEmpty(notes) ? undefined : notes.join("; "),
      );
    }),
});

/** The start of a note on a baseline answer of `count` resources, no two of which show something. */
const noTwoOf = (count: number): string =>
  count < 2
    ? `it lists ${counted(count, "resource")}, so no two of them`
    : `no two of its ${count} resources`;

const noTwoValues = (count: number): string =>
  `no attribute shows two distinct values across its ${counted(count, "resource")}, so no order can be observed`;

const sortOrdering = runSuite<string>({
  rule,
  limit: REQUEST_BUDGET,
  applies: () => true,
  declares: "`sort`",
  candidates: candidatesOf,
  nothingToTry: noTwoValues,
  name: (field) => `\`${field}\``,
  enough: (tally) => tally.decided >= FIELDS_PER_ENDPOINT || (tally.decided > 0 && tally.sawNull),
  decide: (ctx, budget, at, _data, field) => decideOrder(ctx, budget, at.path, field),
  unobserved: "no attribute's order could be observed",
  notes: (probed) =>
    Arr.some(probed, ({ sawNull }) => sawNull)
      ? []
      : ["NULL placement (S-ORD-3) not observed: no attribute decided held a NULL in its answers"],
});

// ---------------------------------------------------------------------------
// S-MULTI-1: several fields
// ---------------------------------------------------------------------------

/** Two attributes for a two-term `sort`: `first` ties two resources at least, which `second` tells apart. */
interface Pair {
  readonly first: string;
  readonly second: string;
}

/** Whether some resources of `data` tie on `first` and differ on `second`. */
const splits = (data: ReadonlyArray<Schema.Json>, { first, second }: Pair): boolean =>
  Arr.some(tiesOf(data, first), (group) => distinctKeys(keysOf(group, second)).length >= 2);

/**
 * The pairs a baseline answer could decide S-MULTI-1 on: a first attribute
 * two resources tie on, and a second that tells some tied resources apart.
 * Those whose first attribute also shows two distinct values come first, so
 * an answer ordered by the second term alone can show it too.
 */
const pairsOf = (data: ReadonlyArray<Schema.Json>): ReadonlyArray<Pair> => {
  const names = orderedNamesOf(data);
  const pairs = Arr.flatMap(names, (first) =>
    Arr.flatMap(names, (second): ReadonlyArray<Pair> => {
      const pair = { first, second };
      return first !== second && splits(data, pair) ? [pair] : [];
    }),
  );
  const ranged = ({ first }: Pair) => distinctKeys(keysOf(data, first)).length >= 2;
  return Arr.take(
    [...Arr.filter(pairs, ranged), ...Arr.filter(pairs, (pair) => !ranged(pair))],
    TRIES_PER_ENDPOINT,
  );
};

/** The first adjacent pair of `data` out of the lexicographic order of `terms`, as a finding. */
const outOfLexicographicOrder = (
  observation: Observation,
  data: ReadonlyArray<Schema.Json>,
  terms: ReadonlyArray<Term>,
): Option.Option<Finding> => {
  const order = compareBy(terms);
  const fields = Arr.map(terms, ({ field }) => field);
  const rows = rowsOf(data, terms);
  const values = (row: ReadonlyArray<Key>): string => `(${Arr.map(row, render).join(", ")})`;
  const sort = sortOf(terms);
  const pairs = Arr.map(Arr.zip(rows, Arr.drop(rows, 1)), ([left, right], index) => ({
    left,
    right,
    index,
  }));
  const spelled = Arr.map(
    terms,
    ({ field, direction }) =>
      `\`${field}\` ${direction === "ascending" ? "ascending" : "descending"}`,
  );
  return Option.map(
    Arr.findFirst(pairs, ({ left, right }) => order(left, right) > 0),
    ({ left, right, index }) =>
      finding(multiRule, {
        detail: `\`?sort=${sort}\` lists ${quote(labelAt(data, index))} ${quote(values(left))} before ${quote(labelAt(data, index + 1))} ${quote(values(right))}`,
        expected: `primary data ordered by ${spelled.join(", then by ")}, each later term breaking only the ties the terms before it left (S-MULTI-1)`,
        observed: `${fields.map((field) => `\`${field}\``).join(", ")} in the order served: ${quote(Arr.map(rows, values).join(", "))}`,
        probe: observation.probe,
      }),
  );
};

/** One `?sort=a,b` request for S-MULTI-1, each term in the direction given. */
const multiProbe = (ctx: Context, budget: Budget, path: string, terms: readonly [Term, Term]) => {
  const sort = sortOf(terms);
  const [first, second] = terms;
  return sortedRequest(
    ctx,
    budget,
    withQuery(path, [["sort", sort]]),
    sort,
    (observation, data) => {
      const problem = Option.orElse(
        Option.map(typeProblem(keysOf(data, first.field)), (why) => `\`${first.field}\` ${why}`),
        () =>
          Option.map(
            typeProblem(keysOf(data, second.field)),
            (why) => `\`${second.field}\` ${why}`,
          ),
      );
      if (Option.isSome(problem))
        return Decision.Undecided({ why: `\`?sort=${sort}\`: ${problem.value}` });
      if (!splits(data, { first: first.field, second: second.field })) {
        return Decision.Undecided({
          why: `\`?sort=${sort}\` lists no two resources that tie on \`${first.field}\` and differ on \`${second.field}\``,
        });
      }
      return decided(Option.toArray(outOfLexicographicOrder(observation, data, terms)));
    },
  );
};

/**
 * Asks for `path` sorted `?sort=a,-b` and `?sort=-a,b`: whichever order the
 * server breaks `a`'s ties in when it ignores the second term, one of the two
 * contradicts it.
 */
const decideMulti = (ctx: Context, budget: Budget, path: string, { first, second }: Pair) =>
  both(
    budget,
    multiProbe(ctx, budget, path, [
      { field: first, direction: "ascending" },
      { field: second, direction: "descending" },
    ]),
    multiProbe(ctx, budget, path, [
      { field: first, direction: "descending" },
      { field: second, direction: "ascending" },
    ]),
  );

const sortMultiField = runSuite<Pair>({
  rule: multiRule,
  limit: PAIR_BUDGET,
  applies: () => true,
  declares: "`sort`",
  candidates: pairsOf,
  nothingToTry: (count) =>
    `${noTwoOf(count)} tie on one attribute and differ on another, so no second term can be observed`,
  name: ({ first, second }) => `\`${first},${second}\``,
  enough: (tally) => tally.decided > 0,
  decide: (ctx, budget, at, _data, pair) => decideMulti(ctx, budget, at.path, pair),
  unobserved: "no two-term order could be observed",
  notes: () => [],
});

// ---------------------------------------------------------------------------
// S-TIE-1: the `id` tiebreak
// ---------------------------------------------------------------------------

/** The attributes a baseline answer could decide S-TIE-1 on: those two resources tie on. */
const tiedNamesOf = (data: ReadonlyArray<Schema.Json>): ReadonlyArray<string> =>
  Arr.take(
    Arr.filter(orderedNamesOf(data), (name) => Arr.isReadonlyArrayNonEmpty(tiesOf(data, name))),
    TRIES_PER_ENDPOINT,
  );

/** Each resource of an answer by the identity the kit compares on, with its position and label. */
const positionsOf = (
  data: ReadonlyArray<Schema.Json>,
): HashMap.HashMap<string, { readonly at: number; readonly label: string }> =>
  HashMap.fromIterable(
    Arr.flatMap(data, (resource, at) => {
      const key = isRecord(resource) ? identity(resource) : undefined;
      return key === undefined ? [] : [[key, { at, label: labelAt(data, at) }] as const];
    }),
  );

/** Two resources that tie on the sort field, in the order one answer lists them. */
interface TiedPair {
  readonly before: string;
  readonly after: string;
  readonly key: Key;
}

/** Every pair of identified resources tying on `field` in `data`, in the order listed. */
const tiedPairsOf = (data: ReadonlyArray<Schema.Json>, field: string): ReadonlyArray<TiedPair> =>
  Arr.flatMap(tiesOf(data, field), (group) => {
    const keys = Arr.flatMap(group, (resource) => {
      const key = isRecord(resource) ? identity(resource) : undefined;
      return key === undefined ? [] : [key];
    });
    const key = Option.match(Arr.head(group), {
      onNone: () => NULL,
      onSome: (resource) => keyOf(resource, field),
    });
    return Arr.flatMap(keys, (before, i) =>
      Arr.map(Arr.drop(keys, i + 1), (after) => ({ before, after, key })),
    );
  });

/**
 * Asks for `path` sorted by `field` both ways. A fixed `id` tiebreak, applied
 * after the last term whatever its direction, lists every pair that ties on
 * `field` in the same relative order in both answers (S-TIE-2); one that
 * breaks ties by whatever order the store returns, or reverses the whole
 * answer for `-f`, does not.
 */
const decideTie = (ctx: Context, budget: Budget, path: string, field: string) =>
  Effect.gen(function* () {
    const first = yield* sortedAnswer(ctx, budget, withQuery(path, [["sort", field]]), field);
    if (Result.isFailure(first)) return first.failure;
    const ascending = first.success.data;
    const unfit = Option.orElse(
      Option.map(typeProblem(keysOf(ascending, field)), (why) => `\`?sort=${field}\` ${why}`),
      () =>
        Arr.isReadonlyArrayEmpty(tiedPairsOf(ascending, field))
          ? Option.some(`\`?sort=${field}\` lists no two identified resources that tie on it`)
          : Option.none(),
    );
    if (Option.isSome(unfit)) return Decision.Undecided({ why: unfit.value });
    if (exhausted(budget)) return Decision.Undecided({ why: budgetSpent(budget.limit) });
    const term = termFor(field, "descending");
    return yield* sortedRequest(
      ctx,
      budget,
      withQuery(path, [["sort", term]]),
      term,
      (observation, data) => {
        const positions = positionsOf(data);
        const positionOf = (id: string): number =>
          Option.getOrElse(
            Option.map(HashMap.get(positions, id), ({ at }) => at),
            () => 0,
          );
        const compared = Arr.filter(
          tiedPairsOf(ascending, field),
          ({ before, after }) => HashMap.has(positions, before) && HashMap.has(positions, after),
        );
        if (Arr.isReadonlyArrayEmpty(compared)) {
          return Decision.Undecided({
            why: `\`?sort=${term}\` lists no pair of the resources \`?sort=${field}\` listed tied`,
          });
        }
        const swapped = Arr.filter(
          compared,
          ({ before, after }) => positionOf(before) > positionOf(after),
        );
        return decided(
          Option.toArray(
            Option.map(Arr.head(swapped), ({ before, after, key }) => {
              const name = (id: string) =>
                quote(
                  Option.getOrElse(
                    Option.map(HashMap.get(positions, id), ({ label }) => label),
                    () => id,
                  ),
                );
              return finding(tieRule, {
                detail: `\`?sort=${field}\` lists ${name(before)} before ${name(after)} and \`?sort=${term}\` lists ${name(after)} before ${name(before)}, though the two tie on \`${field}\` (${quote(render(key))})`,
                expected: `resources tying on \`${field}\` in one fixed order of \`id\`, the same under \`?sort=${field}\` and \`?sort=${term}\` (S-TIE-1, S-TIE-2)`,
                observed: `${swapped.length} of the ${counted(compared.length, "tied pair")} both answers list in the other order: ${listed(Arr.map(swapped, ({ before, after }) => `${name(before)} / ${name(after)}`))}`,
                probe: observation.probe,
              });
            }),
          ),
        );
      },
    );
  });

const sortIdTiebreak = runSuite<string>({
  rule: tieRule,
  limit: PAIR_BUDGET,
  applies: () => true,
  declares: "`sort`",
  candidates: tiedNamesOf,
  nothingToTry: (count) => `${noTwoOf(count)} tie on an attribute, so no tiebreak can be observed`,
  name: (field) => `\`${field}\``,
  enough: (tally) => tally.decided > 0,
  decide: (ctx, budget, at, _data, field) => decideTie(ctx, budget, at.path, field),
  unobserved: "no tie could be observed",
  notes: () => [],
});

// ---------------------------------------------------------------------------
// S-PAGE-1: the order across pages
// ---------------------------------------------------------------------------

/** The page-size parameter an endpoint declares that the kit can set, if any. */
const sizeKeyOf = (endpoint: Discovered): Option.Option<string> =>
  Arr.findFirst(SIZE_KEYS, (key) => endpoint.queryKeys.includes(key));

/** One page of a sorted walk: the URL it was fetched from and the resources it lists. */
interface Page {
  readonly url: string;
  readonly data: ReadonlyArray<Schema.Json>;
  readonly observation: Observation;
}

/** How a walk ended short of a page without `next`, when it did. */
type Walked = { readonly pages: ReadonlyArray<Page>; readonly cut: Option.Option<string> };

/**
 * Follows `next` from `first`, collecting each page of resources, until a
 * page omits it — or until the walk can go no further: a `next` that is no
 * link, leads off the origin or back to a page already visited, an answer
 * that is not a page or says nothing, the page budget or the request budget.
 */
const walkSorted = (
  ctx: Context,
  budget: Budget,
  first: Target,
  firstPage: Page,
): Effect.Effect<Walked> => {
  const step = (
    pages: Arr.NonEmptyReadonlyArray<Page>,
    from: Target,
    visited: HashSet.HashSet<string>,
  ): Effect.Effect<Walked> => {
    const at = pages.length;
    const stop = (why: string): Effect.Effect<Walked> =>
      Effect.succeed({ pages, cut: Option.some(why) });
    const body = Arr.lastNonEmpty(pages).observation.body;
    const next = linkIn(isRecord(body) ? body["links"] : undefined, "next");
    if (Link.$is("Unavailable")(next)) return Effect.succeed({ pages, cut: Option.none() });
    if (!Link.$is("Href")(next)) return stop(`page ${at}'s \`next\` is not a link`);
    const to = stepTo(next.href, from, ctx.options.baseUrl);
    if (!Step.$is("Follow")(to)) return stop(`page ${at}'s \`next\` is not followed`);
    if (HashSet.has(visited, to.target.href)) return stop(`page ${at}'s \`next\` leads back`);
    if (at >= PAGE_BUDGET) return stop(`the walk's ${PAGE_BUDGET}-page budget ran out`);
    if (exhausted(budget)) return stop(budgetSpent(budget.limit));
    return Effect.flatMap(requested(ctx, budget, to.target.url), (observation) => {
      const data = servedCollection(observation);
      if (unanswered(observation) || Option.isNone(data) || Arr.isReadonlyArrayEmpty(data.value)) {
        return stop(`page ${at + 1} answered ${notACollection(observation)}`);
      }
      return step(
        Arr.append(pages, { url: to.target.url, data: data.value, observation }),
        answeredFrom(to.target, observation),
        HashSet.add(visited, to.target.href),
      );
    });
  };
  return step([firstPage], answeredFrom(first, firstPage.observation), HashSet.make(first.href));
};

/**
 * The first page boundary of `pages` the ascending order of `field` breaks:
 * a resource on one page that sorts after a resource on the next.
 */
const brokenBoundary = (
  pages: ReadonlyArray<Page>,
  field: string,
  sort: string,
): Option.Option<Finding> => {
  const extreme = (page: Page, sign: 1 | -1) =>
    Arr.reduce(
      Arr.map(keysOf(page.data, field), (key, at) => ({ at, key })),
      Option.none<{ readonly at: number; readonly key: Key }>(),
      (best, entry) =>
        Option.isSome(best) && sign * compare(entry.key, best.value.key) <= 0
          ? best
          : Option.some(entry),
    );
  const boundaries = Arr.map(Arr.zip(pages, Arr.drop(pages, 1)), ([before, after], index) => ({
    before,
    after,
    index,
  }));
  return Arr.findFirst(boundaries, ({ before, after, index }) =>
    Option.flatMap(Option.all([extreme(before, 1), extreme(after, -1)]), ([latest, earliest]) =>
      compare(latest.key, earliest.key) > 0
        ? Option.some(
            finding(pageRule, {
              detail: `page ${index + 1} of \`?sort=${sort}\` (${quote(before.url)}) lists ${quote(labelAt(before.data, latest.at))} (${quote(render(latest.key))}), which sorts after ${quote(labelAt(after.data, earliest.at))} (${quote(render(earliest.key))}) on page ${index + 2} (${quote(after.url)})`,
              expected: `every resource on a page after every resource on the page before it, in ascending order of \`${field}\` over the whole collection (S-PAGE-1)`,
              observed: `\`${field}\` page by page: ${quote(Arr.map(pages, (page) => `[${Arr.map(keysOf(page.data, field), render).join(", ")}]`).join(" "))}`,
              probe: after.observation.probe,
            }),
          )
        : Option.none(),
    ),
  );
};

/**
 * Asks for `path` sorted by `field` at a page size that cuts the baseline in
 * two at least, walks its `next` links, and holds each page boundary to the
 * order. A walk cut short still decides on the pages it fetched, two at
 * least; its pages are not held to the order within them, which is
 * `profile/sort/ordering`'s to check.
 */
const decidePages =
  (sizeKey: string) =>
  (ctx: Context, budget: Budget, path: string, data: ReadonlyArray<Schema.Json>, field: string) => {
    const size = Math.max(1, Math.floor(data.length / 2));
    const url = withQuery(path, [
      ["sort", field],
      [sizeKey, `${size}`],
    ]);
    const sort = `${field}&${sizeKey}=${size}`;
    return Effect.gen(function* () {
      const target = own(url, ctx.options.baseUrl);
      if (Option.isNone(target)) {
        return Decision.Undecided({ why: `${url} is not a URL the kit can request` });
      }
      const first = yield* sortedAnswer(ctx, budget, url, sort);
      if (Result.isFailure(first)) return first.failure;
      const { pages, cut } = yield* walkSorted(ctx, budget, target.value, {
        url,
        ...first.success,
      });
      if (pages.length < 2) {
        return Decision.Undecided({
          why: Option.getOrElse(
            Option.map(cut, (why) => `\`?sort=${sort}\` reached one page: ${why}`),
            () => `\`?sort=${sort}\` answered one page, so no page boundary can be observed`,
          ),
        });
      }
      const keys = Arr.flatMap(pages, (page) => keysOf(page.data, field));
      return Option.match(undiscriminating(keys), {
        onSome: (why) => Decision.Undecided({ why: `\`?sort=${sort}\` ${why}` }),
        onNone: () => decided(Option.toArray(brokenBoundary(pages, field, sort))),
      });
    });
  };

const sortAcrossPages = runSuite<string>({
  rule: pageRule,
  limit: PAGE_REQUEST_BUDGET,
  applies: (endpoint) => Option.isSome(sizeKeyOf(endpoint)),
  declares: "`sort` and `page[limit]` or `page[size]`",
  candidates: (data) => Arr.take(candidatesOf(data), TRIES_PER_ENDPOINT),
  nothingToTry: noTwoValues,
  name: (field) => `\`${field}\``,
  enough: (tally) => tally.decided > 0,
  decide: (ctx, budget, at, data, field) =>
    decidePages(Option.getOrElse(sizeKeyOf(at.endpoint), () => SIZE_KEYS[0]))(
      ctx,
      budget,
      at.path,
      data,
      field,
    ),
  unobserved: "no order across pages could be observed",
  notes: () => [],
});

/**
 * The sort suite, in report order.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [
  sortOrdering,
  sortMultiField,
  sortIdTiebreak,
  sortAcrossPages,
];
