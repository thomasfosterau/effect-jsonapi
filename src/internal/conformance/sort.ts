/**
 * The profile's sort-order rule: `docs/filter-grammar.md` §10, checked from
 * the wire.
 *
 * Read-only and fixture-free. For each list or related endpoint that declares
 * `sort`, the kit fetches the collection once, picks the attributes whose
 * values in that answer could show an order at all (two distinct values, NULL
 * counting as one), and asks for the collection sorted by each, ascending and
 * descending. Each answer's primary data is held to S-ORD-1 to S-ORD-3: in
 * F-ORD-1's order of the attribute's JSON value, NULLs (an absent member or
 * `null`) last ascending and first descending. An attribute the server
 * refuses to sort by (a 400) is passed over for the next; one whose answers
 * hold fewer than two distinct values, or values of more than one JSON type
 * (S-KEY-2), decides nothing.
 *
 * Three follow-up rules cover the rest of §10 on the same endpoints (#427):
 * several fields (S-MULTI-1), the `id` tiebreak (S-TIE-1, a SHOULD) and the
 * order across pages (S-PAGE-1).
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import {
  type Context,
  coverageNote,
  finding,
  type Finding,
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
  Link,
  linkIn,
  listed,
  own,
  quote,
  Step,
  stepTo,
  type Target,
} from "./crawl.js";

const rule: Rule = {
  id: "profile/sort/ordering",
  tier: "profile",
  section: "filter-grammar/v1 §10 Sort order",
  reference:
    "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md#10-sort-order",
  level: "MUST",
  requirement:
    "`?sort=f` MUST list a collection's primary data in ascending order of `f`'s JSON value — F-ORD-1's order for that JSON type: numeric, code-point, `false` < `true` — with every NULL (an absent member or `null`) after every value, and `?sort=-f` MUST list it in exactly the reverse order, NULLs first (S-ORD-1 to S-ORD-3).",
};

/** The requests one run of the rule may make, over every endpoint it probes. */
const REQUEST_BUDGET = 60;

/**
 * The most attributes decided per endpoint: the first that holds a NULL in
 * its answers, or failing that two.
 */
const FIELDS_PER_ENDPOINT = 2;

const BUDGET_SPENT = `the rule's ${REQUEST_BUDGET}-request budget ran out`;

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
const attributesOf = (resource: unknown): Readonly<Record<string, unknown>> =>
  isRecord(resource) && isRecord(resource["attributes"]) ? resource["attributes"] : {};

const keyOf = (resource: unknown, field: string): Key => {
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
 * with NULL; `-0` ties with `0`. Keys of two different JSON types are never
 * compared: `undiscriminating` sets such an attribute aside first.
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
const collectionOf = (observation: Observation): Option.Option<ReadonlyArray<unknown>> => {
  const data = isRecord(observation.body) ? observation.body["data"] : undefined;
  return Array.isArray(data) ? Option.some(data) : Option.none();
};

/** What an answer that is not a 2xx resource collection answered, for a note. */
const notACollection = (observation: Observation): string =>
  `${statusOf(observation)}${succeeded(observation) ? ", not a resource collection" : ""}`;

/**
 * Why `keys` cannot show an order, when they cannot: they can when they hold
 * two distinct keys at least, NULL counting as one, all of one JSON scalar
 * type besides NULL.
 */
const undiscriminating = (keys: ReadonlyArray<Key>): Option.Option<string> => {
  const kinds = Arr.dedupe(Arr.flatMap(keys, (key) => (key.kind === "null" ? [] : [key.kind])));
  if (Arr.contains(kinds, "unordered"))
    return Option.some("holds a non-scalar value, which has no order (S-KEY-2)");
  if (kinds.length > 1)
    return Option.some(
      `holds values of more than one JSON type (${kinds.join(", ")}), which have no order (S-KEY-2)`,
    );
  const distinct = Arr.dedupeWith(keys, (left, right) => compare(left, right) === 0);
  if (distinct.length >= 2) return Option.none();
  return Option.some(
    `shows ${Arr.isReadonlyArrayEmpty(distinct) ? "no value" : "one distinct value"}, which cannot show an order`,
  );
};

/**
 * The attributes a baseline answer could decide the rule on, those holding a
 * NULL first — so NULL placement is checked wherever the collection shows one.
 */
const candidatesOf = (data: ReadonlyArray<unknown>): ReadonlyArray<string> => {
  const names = Arr.dedupe(Arr.flatMap(data, (resource) => Rec.keys(attributesOf(resource))));
  const usable = Arr.filter(names, (name) =>
    Option.isNone(undiscriminating(Arr.map(data, (resource) => keyOf(resource, name)))),
  );
  const holdsNull = (name: string) =>
    Arr.some(data, (resource) => keyOf(resource, name).kind === "null");
  return [...Arr.filter(usable, holdsNull), ...Arr.filter(usable, (name) => !holdsNull(name))];
};

type Direction = "ascending" | "descending";

const termFor = (field: string, direction: Direction): string =>
  direction === "ascending" ? field : `-${field}`;

/** The first adjacent pair of `data` out of the order `direction` asks for, as a finding. */
const outOfOrder = (
  observation: Observation,
  data: ReadonlyArray<unknown>,
  field: string,
  direction: Direction,
): Option.Option<Finding> => {
  const keys = Arr.map(data, (resource) => keyOf(resource, field));
  const sign = direction === "ascending" ? 1 : -1;
  const pairs = Arr.map(Arr.zip(keys, Arr.drop(keys, 1)), ([left, right], index) => ({
    left,
    right,
    index,
  }));
  const label = (at: number): string =>
    Option.match(Arr.get(data, at), {
      onNone: () => `/data/${at}`,
      onSome: (resource) => (isRecord(resource) ? resourceLabel(resource) : `/data/${at}`),
    });
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

/** What one attribute's two sorted requests decided. */
type Decision = Data.TaggedEnum<{
  Decided: { readonly findings: ReadonlyArray<Finding>; readonly sawNull: boolean };
  Refused: {};
  Undecided: { readonly why: string };
}>;

const Decision = Data.taggedEnum<Decision>();

/** The requests the rule has sent so far, redirects followed included. */
interface Budget {
  spent: number;
}

const exhausted = (budget: Budget): boolean => budget.spent >= REQUEST_BUDGET;

const requested = (ctx: Context, budget: Budget, url: string) =>
  Effect.map(
    ctx.request({ url, headers: jsonApiAccept, requests: REQUEST_BUDGET - budget.spent }),
    (observation) => {
      budget.spent += 1 + observation.redirects.length;
      return observation;
    },
  );

/** One sorted request: the keys it lists, its finding if any, or why it decides nothing. */
const probe = (ctx: Context, budget: Budget, path: string, field: string, direction: Direction) =>
  Effect.map(
    requested(ctx, budget, withQuery(path, [["sort", termFor(field, direction)]])),
    (observation) => {
      // A 400 is the server refusing to sort by this attribute (§Sorting), not
      // a statement about order: the next attribute is tried instead.
      if (observation.status === 400) return Decision.Refused();
      const term = `\`?sort=${termFor(field, direction)}\``;
      return Option.match(
        Option.filter(collectionOf(observation), () => succeeded(observation)),
        {
          onNone: () =>
            Decision.Undecided({ why: `${term} answered ${notACollection(observation)}` }),
          onSome: (data) => {
            const keys = Arr.map(data, (resource) => keyOf(resource, field));
            return Option.match(undiscriminating(keys), {
              onSome: (why) => Decision.Undecided({ why: `${term} ${why}` }),
              onNone: () =>
                Decision.Decided({
                  findings: Option.toArray(outOfOrder(observation, data, field, direction)),
                  sawNull: Arr.some(keys, (key) => key.kind === "null"),
                }),
            });
          },
        },
      );
    },
  );

/**
 * Asks for `path` sorted by `field` both ways, and holds each answer to its
 * order. A finding the ascending answer made stands even when the descending
 * request then decides nothing.
 */
const decide = (ctx: Context, budget: Budget, path: string, field: string) =>
  Effect.gen(function* () {
    const ascending = yield* probe(ctx, budget, path, field, "ascending");
    if (!Decision.$is("Decided")(ascending)) return ascending;
    if (exhausted(budget)) {
      return Arr.isReadonlyArrayNonEmpty(ascending.findings)
        ? ascending
        : Decision.Undecided({ why: BUDGET_SPENT });
    }
    const descending = yield* probe(ctx, budget, path, field, "descending");
    if (Decision.$is("Decided")(descending)) {
      return Decision.Decided({
        findings: [...ascending.findings, ...descending.findings],
        sawNull: ascending.sawNull || descending.sawNull,
      });
    }
    return Arr.isReadonlyArrayNonEmpty(ascending.findings) ? ascending : descending;
  });

/** The endpoints the rule applies to (S-SCOPE-1): a list or related endpoint that declares `sort`. */
const sortable = (ctx: Context) => {
  const applies = Arr.filter(
    ctx.endpoints,
    (endpoint) =>
      (endpoint.role === "collection" || endpoint.role === "related") &&
      endpoint.queryKeys.includes("sort"),
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

/** What the rule decided on one endpoint. */
interface Probed {
  readonly decided: number;
  readonly sawNull: boolean;
  readonly findings: ReadonlyArray<Finding>;
  /** Why nothing was decided there, when nothing was. */
  readonly undecided: Option.Option<string>;
}

/** What the attributes tried on one endpoint decided, before it is summed up. */
interface Tally {
  decided: number;
  sawNull: boolean;
  readonly findings: Array<Finding>;
  readonly refused: Array<string>;
  readonly notDecided: Array<string>;
}

/** Whether `tally` has decided enough of an endpoint: one NULL-holding attribute, or two. */
const enough = (tally: Tally): boolean =>
  tally.decided >= FIELDS_PER_ENDPOINT || (tally.decided > 0 && tally.sawNull);

const record = (tally: Tally, field: string, decision: Decision): void =>
  Decision.$match(decision, {
    Refused: () => {
      tally.refused.push(`\`${field}\``);
    },
    Undecided: ({ why }) => {
      tally.notDecided.push(`\`${field}\`: ${why}`);
    },
    Decided: (outcome) => {
      tally.decided += 1;
      tally.sawNull ||= outcome.sawNull;
      tally.findings.push(...outcome.findings);
    },
  });

/** Tries `candidates` in turn until {@link enough} of them are decided or the budget runs out. */
const tallyFields = (
  ctx: Context,
  budget: Budget,
  path: string,
  candidates: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const tally: Tally = { decided: 0, sawNull: false, findings: [], refused: [], notDecided: [] };
    for (const field of candidates) {
      if (enough(tally)) break;
      if (exhausted(budget)) {
        tally.notDecided.push(BUDGET_SPENT);
        break;
      }
      record(tally, field, yield* decide(ctx, budget, path, field));
    }
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

/** Decides up to {@link FIELDS_PER_ENDPOINT} attributes of the collection at `path`. */
const probeEndpoint = (ctx: Context, budget: Budget, path: string) =>
  Effect.gen(function* () {
    const nothing = (why: string): Probed => ({
      decided: 0,
      sawNull: false,
      findings: [],
      undecided: Option.some(`${path}: ${why}`),
    });
    if (exhausted(budget)) return nothing(`not probed, ${BUDGET_SPENT}`);
    const baseline = yield* requested(ctx, budget, path);
    const collection = Option.filter(collectionOf(baseline), () => succeeded(baseline));
    if (Option.isNone(collection)) return nothing(`answered ${notACollection(baseline)}`);
    const candidates = candidatesOf(collection.value);
    if (Arr.isReadonlyArrayEmpty(candidates)) {
      const count = collection.value.length;
      return nothing(
        `no attribute shows two distinct values across its ${count} resource${count === 1 ? "" : "s"}, so no order can be observed`,
      );
    }
    const tally = yield* tallyFields(ctx, budget, path, candidates);
    if (tally.decided === 0) return nothing(whyNot(tally));
    const probed: Probed = {
      decided: tally.decided,
      sawNull: tally.sawNull,
      findings: tally.findings,
      undecided: Option.none(),
    };
    return probed;
  });

const sortOrdering: RuleImpl = {
  rule,
  run: (ctx) =>
    Effect.gen(function* () {
      const { resolved, unresolved } = sortable(ctx);
      if (Arr.isReadonlyArrayEmpty(resolved)) {
        return skip(
          rule,
          Arr.isReadonlyArrayEmpty(unresolved)
            ? "no list or related endpoint in this api declares `sort`"
            : `no list or related endpoint declaring \`sort\` with a resolvable URL: ${unresolved.join("; ")}`,
        );
      }
      const budget: Budget = { spent: 0 };
      // One endpoint at a time: every endpoint draws on the one request budget.
      const probed = yield* Effect.forEach(
        resolved,
        ({ path }) => probeEndpoint(ctx, budget, path),
        { concurrency: 1 },
      );
      const undecided = Arr.getSomes(Arr.map(probed, ({ undecided }) => undecided));
      if (!Arr.some(probed, ({ decided }) => decided > 0)) {
        return skip(rule, `no attribute's order could be observed: ${undecided.join("; ")}`);
      }
      const notes = [
        ...(Arr.some(probed, ({ sawNull }) => sawNull)
          ? []
          : [
              "NULL placement (S-ORD-3) not observed: no attribute decided held a NULL in its answers",
            ]),
        ...(Arr.isReadonlyArrayEmpty(undecided) ? [] : [`not decided: ${undecided.join("; ")}`]),
        ...Option.toArray(Option.fromUndefinedOr(coverageNote(unresolved))),
      ];
      return settle(
        rule,
        budget.spent,
        Arr.flatMap(probed, ({ findings }) => findings),
        Arr.isReadonlyArrayEmpty(notes) ? undefined : notes.join("; "),
      );
    }),
};

// ---------------------------------------------------------------------------
// The follow-up rules: several fields, the `id` tiebreak, order across pages
// ---------------------------------------------------------------------------

const REFERENCE =
  "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md";

/** One term of a `sort`: a field and its direction. */
interface Term {
  readonly field: string;
  readonly direction: Direction;
}

const sortValue = (terms: ReadonlyArray<Term>): string =>
  Arr.map(terms, ({ field, direction }) => termFor(field, direction)).join(",");

/** The order `terms` put two resources in (S-MULTI-1): the first term that does not tie decides. */
const compareBy =
  (terms: ReadonlyArray<Term>) =>
  // oxlint-disable-next-line effect/no-unknown-parameters -- compares primary-data elements as the server sent them; `keyOf` reads each, with no schema to parse it by
  (left: unknown, right: unknown): number =>
    Option.getOrElse(
      Arr.findFirst(
        Arr.map(
          terms,
          ({ field, direction }) =>
            (direction === "ascending" ? 1 : -1) * compare(keyOf(left, field), keyOf(right, field)),
        ),
        (order) => order !== 0,
      ),
      () => 0,
    );

// oxlint-disable-next-line effect/no-unknown-parameters -- compares primary-data elements as the server sent them; `keyOf` reads each, with no schema to parse it by
const ties = (field: string) => (left: unknown, right: unknown) =>
  compare(keyOf(left, field), keyOf(right, field)) === 0;

/** `data` as listed, cut into runs of adjacent resources that tie on `field`. */
const runsIn = (
  data: ReadonlyArray<unknown>,
  field: string,
): ReadonlyArray<ReadonlyArray<unknown>> =>
  Arr.isReadonlyArrayNonEmpty(data) ? Arr.groupWith(data, ties(field)) : [];

/** The groups of resources in `data` that tie on `field` (S-ORD-4), however they are listed. */
const tieGroups = (
  data: ReadonlyArray<unknown>,
  field: string,
): ReadonlyArray<ReadonlyArray<unknown>> =>
  runsIn(
    Arr.sort(
      data,
      Order.make<unknown>((left, right) => {
        const order = compare(keyOf(left, field), keyOf(right, field));
        return order < 0 ? -1 : order > 0 ? 1 : 0;
      }),
    ),
    field,
  );

/** The runs of adjacent resources in `data` as listed that tie on `field`, two or more long. */
const tiedRuns = (
  data: ReadonlyArray<unknown>,
  field: string,
): ReadonlyArray<ReadonlyArray<unknown>> =>
  Arr.filter(runsIn(data, field), (run) => run.length > 1);

/** A resource as a finding names it. */
// oxlint-disable-next-line effect/no-unknown-parameters -- names a primary-data element as the server sent it, record or not
const labelOf = (resource: unknown, at: number): string =>
  isRecord(resource) ? resourceLabel(resource) : `/data/${at}`;

/** What one sortable endpoint decided for a follow-up rule. */
interface Verdict {
  readonly findings: ReadonlyArray<Finding>;
  /** Why nothing was decided there, when nothing was. */
  readonly undecided: Option.Option<string>;
}

const decided = (findings: ReadonlyArray<Finding>): Verdict => ({
  findings,
  undecided: Option.none(),
});

const undecided = (path: string, why: string): Verdict => ({
  findings: [],
  undecided: Option.some(`${path}: ${why}`),
});

/** A sorted (or plain) request's answer as a resource collection, or why it is not one. */
const answerOf = (observation: Observation, request: string) =>
  Option.match(
    Option.filter(collectionOf(observation), () => succeeded(observation)),
    {
      onNone: () =>
        Result.fail(
          observation.status === 400
            ? `refused ${request} with a 400`
            : `${request} answered ${notACollection(observation)}`,
        ),
      onSome: (data) => Result.succeed(data),
    },
  );

/** Why the answer's `fields` cannot show an order, when one of them cannot (S-KEY-2). */
const unorderable = (
  data: ReadonlyArray<unknown>,
  fields: ReadonlyArray<string>,
): Option.Option<string> =>
  Arr.findFirst(fields, (field) =>
    Option.map(
      Option.filter(
        undiscriminating(Arr.map(data, (resource) => keyOf(resource, field))),
        (why) => !why.startsWith("shows"),
      ),
      (why) => `\`${field}\` ${why}`,
    ),
  );

/** A sortable endpoint's collection as it answers with no `sort`, or why it decides nothing. */
const baselineOf = (ctx: Context, budget: Budget, path: string) =>
  Effect.map(requested(ctx, budget, path), (observation) =>
    Result.mapError(answerOf(observation, `\`${path}\``), (why) =>
      // `answerOf` names the request; the baseline is the endpoint itself.
      why.replace(`\`${path}\` answered`, "answered"),
    ),
  );

/**
 * Runs a follow-up rule over every sortable endpoint whose URL resolves and
 * that `applies` keeps, one at a time on one request budget, and settles it:
 * skipped when no endpoint decided anything, naming why for each.
 */
const runFollowUp = (
  ctx: Context,
  self: Rule,
  options: {
    readonly applies?: (endpoint: (typeof ctx.endpoints)[number]) => boolean;
    readonly inapplicable?: string;
    /** Decides one endpoint, given the collection it answered with no `sort`. */
    readonly probe: (
      budget: Budget,
      path: string,
      data: ReadonlyArray<unknown>,
      endpoint: (typeof ctx.endpoints)[number],
    ) => Effect.Effect<Verdict>;
  },
) =>
  Effect.gen(function* () {
    const { resolved, unresolved } = sortable(ctx);
    const applying = Arr.filter(resolved, ({ endpoint }) => options.applies?.(endpoint) ?? true);
    const inapplicable =
      options.inapplicable ?? "no list or related endpoint in this api declares `sort`";
    if (Arr.isReadonlyArrayEmpty(applying)) {
      return skip(
        self,
        Arr.isReadonlyArrayEmpty(unresolved)
          ? inapplicable
          : `${inapplicable}, or none with a resolvable URL: ${unresolved.join("; ")}`,
      );
    }
    const budget: Budget = { spent: 0 };
    const verdicts = yield* Effect.forEach(
      applying,
      ({ endpoint, path }) =>
        exhausted(budget)
          ? Effect.succeed(undecided(path, `not probed, ${BUDGET_SPENT}`))
          : Effect.flatMap(baselineOf(ctx, budget, path), (baseline) =>
              Result.match(baseline, {
                onFailure: (why) => Effect.succeed(undecided(path, why)),
                onSuccess: (data) => options.probe(budget, path, data, endpoint),
              }),
            ),
      { concurrency: 1 },
    );
    const notDecided = Arr.getSomes(Arr.map(verdicts, ({ undecided: why }) => why));
    if (notDecided.length === verdicts.length) {
      return skip(self, `nothing could be decided: ${notDecided.join("; ")}`);
    }
    const notes = [
      ...(Arr.isReadonlyArrayEmpty(notDecided) ? [] : [`not decided: ${notDecided.join("; ")}`]),
      ...Option.toArray(Option.fromUndefinedOr(coverageNote(unresolved))),
    ];
    return settle(
      self,
      budget.spent,
      Arr.flatMap(verdicts, ({ findings }) => findings),
      Arr.isReadonlyArrayEmpty(notes) ? undefined : notes.join("; "),
    );
  });

/** Runs `probe` ascending and then descending, one at a time, while the budget lasts. */
const eachDirection = <A>(
  budget: Budget,
  probe: (direction: Direction) => Effect.Effect<Result.Result<A, string>>,
) =>
  Effect.forEach(
    ["ascending", "descending"] as const,
    (direction) =>
      exhausted(budget) ? Effect.succeed(Result.fail<string>(BUDGET_SPENT)) : probe(direction),
    { concurrency: 1 },
  );

/**
 * Runs `probe` ascending and then descending, within the budget, and sums
 * the two up: the findings either made, decided when at least one direction
 * decided, or why neither did.
 */
const bothDirections = (
  budget: Budget,
  path: string,
  probe: (direction: Direction) => Effect.Effect<Result.Result<ReadonlyArray<Finding>, string>>,
) =>
  Effect.map(eachDirection(budget, probe), (outcomes): Verdict => {
    const findings = Arr.flatMap(outcomes, (outcome) => Result.getOrElse(outcome, () => []));
    const reasons = Arr.flatMap(outcomes, (outcome) =>
      Result.isFailure(outcome) ? [outcome.failure] : [],
    );
    return Arr.isReadonlyArrayNonEmpty(findings) || reasons.length < outcomes.length
      ? decided(findings)
      : undecided(path, Arr.dedupe(reasons).join("; "));
  });

// --- S-MULTI-1 -------------------------------------------------------------

const multiRule: Rule = {
  id: "profile/sort/multi-field",
  tier: "profile",
  section: "filter-grammar/v1 §10.4 Several fields",
  reference: `${REFERENCE}#104-several-fields`,
  level: "MUST",
  requirement:
    "`?sort=f₁,f₂` MUST order the primary data by `f₁`, and the resources that tie on `f₁` by `f₂`, each term in its own direction (S-MULTI-1).",
};

/** Whether some tie on `first` in `data` holds two distinct values of `second`. */
const secondDecides = (data: ReadonlyArray<unknown>, first: string, second: string): boolean =>
  Arr.some(
    tieGroups(data, first),
    (group) =>
      Arr.dedupeWith(
        Arr.map(group, (resource): Key => keyOf(resource, second)),
        (left: Key, right: Key) => compare(left, right) === 0,
      ).length > 1,
  );

/** The first two attributes of `candidates` where a tie on one shows two values of the other. */
const pairOf = (
  data: ReadonlyArray<unknown>,
  candidates: ReadonlyArray<string>,
): Option.Option<readonly [string, string]> =>
  Arr.findFirst(
    Arr.flatMap(candidates, (first) =>
      Arr.map(
        Arr.filter(candidates, (second) => second !== first),
        (second) => [first, second] as const,
      ),
    ),
    ([first, second]) => secondDecides(data, first, second),
  );

const describeTerms = (terms: ReadonlyArray<Term>): string =>
  Arr.map(terms, ({ field, direction }) => `\`${field}\` ${direction}`).join(", then ");

// oxlint-disable-next-line effect/no-unknown-parameters -- reads a primary-data element as the server sent it, through `keyOf`
const renderTuple = (resource: unknown, terms: ReadonlyArray<Term>): string =>
  `(${Arr.map(terms, ({ field }) => render(keyOf(resource, field))).join(", ")})`;

/** The first adjacent pair of `data` out of the order `terms` ask for, as a finding. */
const outOfOrderBy = (
  observation: Observation,
  data: ReadonlyArray<unknown>,
  terms: ReadonlyArray<Term>,
): Option.Option<Finding> =>
  Option.map(
    Arr.findFirst(Arr.range(0, data.length - 2), (index) =>
      data.length > 1 ? compareBy(terms)(data[index], data[index + 1]) > 0 : false,
    ),
    (index) =>
      finding(multiRule, {
        detail: `\`?sort=${sortValue(terms)}\` lists ${quote(labelOf(data[index], index))} ${quote(renderTuple(data[index], terms))} before ${quote(labelOf(data[index + 1], index + 1))} ${quote(renderTuple(data[index + 1], terms))}`,
        expected: `primary data ordered by ${describeTerms(terms)}, each later field ordering only the resources the fields before it tie on (S-MULTI-1)`,
        observed: `${Arr.map(terms, ({ field }) => `\`${field}\``).join(", ")} in the order served: ${quote(Arr.map(data, (resource) => renderTuple(resource, terms)).join(", "))}`,
        probe: observation.probe,
      }),
  );

/** One multi-field request: its finding if any, or why it decides nothing. */
const multiProbe = (
  ctx: Context,
  budget: Budget,
  path: string,
  [first, second]: readonly [string, string],
  direction: Direction,
) => {
  const terms: ReadonlyArray<Term> = [
    { field: first, direction: "ascending" },
    { field: second, direction },
  ];
  return Effect.map(
    requested(ctx, budget, withQuery(path, [["sort", sortValue(terms)]])),
    (observation): Result.Result<ReadonlyArray<Finding>, string> => {
      const request = `\`?sort=${sortValue(terms)}\``;
      return Result.flatMap(answerOf(observation, request), (data) =>
        Option.match(unorderable(data, [first, second]), {
          onSome: (why) => Result.fail(`${request}: ${why}`),
          onNone: () =>
            secondDecides(data, first, second)
              ? Result.succeed(Option.toArray(outOfOrderBy(observation, data, terms)))
              : Result.fail(
                  `${request} shows no tie on \`${first}\` holding two values of \`${second}\``,
                ),
        }),
      );
    },
  );
};

const multiField: RuleImpl = {
  rule: multiRule,
  run: (ctx) =>
    runFollowUp(ctx, multiRule, {
      probe: (budget, path, data) =>
        Effect.gen(function* () {
          const pair = pairOf(data, candidatesOf(data));
          if (Option.isNone(pair)) {
            return undecided(
              path,
              `no attribute ties across its ${data.length} resource(s) where another shows two values, so a second sort field cannot be observed`,
            );
          }
          // Both directions of the second term: whatever fixed order a server
          // falls back on for a tie, one of the two disagrees with it.
          return yield* bothDirections(budget, path, (direction) =>
            multiProbe(ctx, budget, path, pair.value, direction),
          );
        }),
    }),
};

// --- S-TIE-1 ---------------------------------------------------------------

const tieRule: Rule = {
  id: "profile/sort/id-tiebreak",
  tier: "profile",
  section: "filter-grammar/v1 §10.5 Ties and stability",
  reference: `${REFERENCE}#105-ties-and-stability`,
  level: "SHOULD",
  requirement:
    "A server SHOULD break every tie left after the last sort field by `id`, in one fixed order on `id` — ascending code-point order recommended, or numeric for integer ids — the same on every request (S-TIE-1, S-TIE-2).",
};

/** A tied run as the ids it lists, in order, and where it was seen. */
interface Run {
  readonly request: string;
  readonly ids: ReadonlyArray<string>;
  readonly labels: ReadonlyArray<string>;
  readonly value: string;
  readonly observation: Observation;
}

const INTEGER = /^-?(0|[1-9][0-9]*)$/;

/** The fixed orders on `id` S-TIE-2 allows, each as a comparator, either way round. */
const idOrders = (
  ids: ReadonlyArray<string>,
): ReadonlyArray<(left: string, right: string) => number> => {
  const numeric = Arr.every(ids, (id) => INTEGER.test(id));
  const orders: ReadonlyArray<(left: string, right: string) => number> = [
    compareCodePoints,
    ...(numeric
      ? [(left: string, right: string) => compareNumbers(Number(left), Number(right))]
      : []),
  ];
  return Arr.flatMap(orders, (order) => [
    order,
    (left: string, right: string) => order(right, left),
  ]);
};

const inOrder = (ids: ReadonlyArray<string>, order: (left: string, right: string) => number) =>
  Arr.every(Arr.zip(ids, Arr.drop(ids, 1)), ([left, right]) => order(left, right) < 0);

/** The tied runs with a string `id` on every resource an answer lists. */
const runsOf = (
  observation: Observation,
  data: ReadonlyArray<unknown>,
  field: string,
  request: string,
): ReadonlyArray<Run> =>
  Arr.flatMap(tiedRuns(data, field), (run) => {
    const ids = Arr.flatMap(run, (resource) =>
      isRecord(resource) && Predicate.isString(resource["id"]) ? [resource["id"]] : [],
    );
    return ids.length === run.length
      ? [
          {
            request,
            ids,
            labels: Arr.map(run, (resource, at) => labelOf(resource, at)),
            value: render(keyOf(run[0], field)),
            observation,
          },
        ]
      : [];
  });

const idTiebreak: RuleImpl = {
  rule: tieRule,
  run: (ctx) =>
    runFollowUp(ctx, tieRule, {
      probe: (budget, path, data) =>
        Effect.gen(function* () {
          const field = Arr.findFirst(candidatesOf(data), (name) =>
            Arr.some(tieGroups(data, name), (group) => group.length > 1),
          );
          if (Option.isNone(field)) {
            return undecided(
              path,
              `no attribute ties two of its ${data.length} resource(s), so no tiebreak can be observed`,
            );
          }
          const outcomes = yield* eachDirection(budget, (direction) => {
            const term = termFor(field.value, direction);
            const request = `\`?sort=${term}\``;
            return Effect.map(
              requested(ctx, budget, withQuery(path, [["sort", term]])),
              (observation) =>
                Result.map(answerOf(observation, request), (answer) =>
                  runsOf(observation, answer, field.value, request),
                ),
            );
          });
          const runs = Arr.flatMap(outcomes, (outcome) => Result.getOrElse(outcome, () => []));
          const reasons = Arr.flatMap(outcomes, (outcome) =>
            Result.isFailure(outcome) ? [outcome.failure] : [],
          );
          if (!Arr.isReadonlyArrayNonEmpty(runs)) {
            return undecided(
              path,
              Arr.isReadonlyArrayEmpty(reasons)
                ? `no two resources tying on \`${field.value}\` were listed together`
                : reasons.join("; "),
            );
          }
          const fixed = Arr.some(idOrders(Arr.flatMap(runs, ({ ids }) => ids)), (order) =>
            Arr.every(runs, ({ ids }) => inOrder(ids, order)),
          );
          if (fixed) return decided([]);
          const first = Option.getOrElse(
            Arr.findFirst(runs, ({ ids }) => !inOrder(ids, compareCodePoints)),
            () => Arr.headNonEmpty(runs),
          );
          return decided([
            finding(tieRule, {
              detail: `${path}: the resources that tie on \`${field.value}\` are not listed in one fixed order on \`id\` across ${Arr.dedupe(Arr.map(runs, ({ request }) => request)).join(" and ")}`,
              expected:
                "every tie broken by `id` in one fixed order, the same on every request — ascending code-point order recommended, or numeric for integer ids (S-TIE-1, S-TIE-2)",
              observed: Arr.map(
                runs,
                ({ request, labels, value }) =>
                  `${request} lists ${labels.join(", ")} (\`${field.value}\` ${value})`,
              ).join("; "),
              probe: first.observation.probe,
            }),
          ]);
        }),
    }),
};

// --- S-PAGE-1 --------------------------------------------------------------

const pageRule: Rule = {
  id: "profile/sort/across-pages",
  tier: "profile",
  section: "filter-grammar/v1 §10.6 With `filter` and `page`",
  reference: `${REFERENCE}#106-with-filter-and-page`,
  level: "MUST",
  requirement:
    "The order `?sort=f` asks for MUST be a property of the whole collection, applied before `page` cuts it into pages: every resource on a page follows every resource on the page before it (S-PAGE-1).",
};

/** The page-size parameters the kit can set, in the order it prefers them. */
const SIZE_KEYS = ["page[limit]", "page[size]"] as const;

const sizeKeyOf = (queryKeys: ReadonlyArray<string>): Option.Option<string> =>
  Arr.findFirst(SIZE_KEYS, (key) => queryKeys.includes(key));

/** The first adjacent pair of the two pages, read as one sequence, out of order, as a finding. */
const outOfOrderAcross = (
  observation: Observation,
  pages: readonly [ReadonlyArray<unknown>, ReadonlyArray<unknown>],
  field: string,
  direction: Direction,
  request: string,
): Option.Option<Finding> => {
  const sequence = [...pages[0], ...pages[1]];
  const sign = direction === "ascending" ? 1 : -1;
  const pageOf = (index: number) => (index < pages[0].length ? 1 : 2);
  const at = (index: number) => {
    const resource = sequence[index];
    return `${quote(labelOf(resource, index))} (${quote(render(keyOf(resource, field)))}) on page ${pageOf(index)}`;
  };
  const values = (page: ReadonlyArray<unknown>) =>
    Arr.map(page, (resource) => render(keyOf(resource, field))).join(", ");
  return Option.map(
    Arr.findFirst(
      Arr.range(0, sequence.length - 2),
      (index) =>
        sequence.length > 1 &&
        sign * compare(keyOf(sequence[index], field), keyOf(sequence[index + 1], field)) > 0,
    ),
    (index) =>
      finding(pageRule, {
        detail: `${request} and its \`next\` list ${at(index)} before ${at(index + 1)}`,
        expected: `one ${direction} order of \`${field}\` across the pages, every resource on page 2 after every resource on page 1 (S-PAGE-1)`,
        observed: `\`${field}\` page by page: ${quote(values(pages[0]))} | ${quote(values(pages[1]))}`,
        probe: observation.probe,
      }),
  );
};

/**
 * Where a sorted first page's `next` leads, or why the kit goes no further:
 * no `next` (a server that ignored the page size, or a collection on one
 * page), or one the kit does not follow.
 */
const nextOf = (
  ctx: Context,
  target: Target,
  observation: Observation,
  page: ReadonlyArray<unknown>,
  { request, size }: { readonly request: string; readonly size: number },
): Result.Result<Target, string> => {
  const next = linkIn(isRecord(observation.body) ? observation.body["links"] : undefined, "next");
  if (!Link.$is("Href")(next)) {
    return Result.fail(
      page.length > size
        ? `${request} answered ${page.length} resources, ignoring the page size, with no \`next\``
        : `${request} answered one page with no \`next\` to follow`,
    );
  }
  const step = stepTo(next.href, answeredFrom(target, observation), ctx.options.baseUrl);
  return Step.$is("Follow")(step)
    ? Result.succeed(step.target)
    : Result.fail(`${request}'s \`next\` (${quote(next.href)}) is not a link the kit follows`);
};

/** Fetches a sorted first page and the page its `next` names, and holds the two to one order. */
const pageProbe = (
  ctx: Context,
  budget: Budget,
  path: string,
  page: { readonly key: string; readonly size: number },
  field: string,
  direction: Direction,
) =>
  Effect.gen(function* () {
    const query: ReadonlyArray<readonly [string, string]> = [
      ["sort", termFor(field, direction)],
      [page.key, String(page.size)],
    ];
    const url = withQuery(path, query);
    const request = `\`?${Arr.map(query, ([name, value]) => `${name}=${value}`).join("&")}\``;
    const target = Option.getOrUndefined(own(url, ctx.options.baseUrl));
    if (target === undefined) return Result.fail(`${request} has no URL the kit can request`);
    const first = yield* requested(ctx, budget, url);
    const page1 = answerOf(first, request);
    if (Result.isFailure(page1)) return Result.fail(page1.failure);
    const next = nextOf(ctx, target, first, page1.success, { request, size: page.size });
    if (Result.isFailure(next)) return Result.fail(next.failure);
    if (exhausted(budget)) return Result.fail(BUDGET_SPENT);
    const second = yield* requested(ctx, budget, next.success.url);
    const page2 = Result.filterOrFail(
      answerOf(second, `${request}'s \`next\``),
      Arr.isReadonlyArrayNonEmpty,
      () => `${request}'s \`next\` answered an empty page`,
    );
    if (Result.isFailure(page2)) return Result.fail(page2.failure);
    const pages = [page1.success, page2.success] as const;
    return Option.match(unorderable([...pages[0], ...pages[1]], [field]), {
      onSome: (why) => Result.fail(`${request} and its \`next\`: ${why}`),
      onNone: () =>
        Result.succeed(Option.toArray(outOfOrderAcross(second, pages, field, direction, request))),
    });
  });

const acrossPages: RuleImpl = {
  rule: pageRule,
  run: (ctx) =>
    runFollowUp(ctx, pageRule, {
      applies: (endpoint) => Option.isSome(sizeKeyOf(endpoint.queryKeys)),
      inapplicable:
        "no list or related endpoint in this api declares `sort` and `page[limit]` or `page[size]`",
      probe: (budget, path, data, endpoint) =>
        Effect.gen(function* () {
          const field = Arr.head(candidatesOf(data));
          if (Option.isNone(field) || data.length < 2) {
            return undecided(
              path,
              `no attribute shows two distinct values across its ${data.length} resource(s), so no order can be observed`,
            );
          }
          // Two pages at least, from the collection as it first answered.
          const size = Math.ceil(data.length / 2);
          const sizeKey = Option.getOrElse(sizeKeyOf(endpoint.queryKeys), () => "page[limit]");
          return yield* bothDirections(budget, path, (direction) =>
            pageProbe(ctx, budget, path, { key: sizeKey, size }, field.value, direction),
          );
        }),
    }),
};

/**
 * The sort-order suite, in report order.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [sortOrdering, multiField, idTiebreak, acrossPages];
