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
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
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
import { listed, quote } from "./crawl.js";

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
    // `findFirst` walks `candidates` in order and stops at the first `true`:
    // the early exit once the tally has enough or the budget is spent.
    yield* Effect.findFirst(candidates, (field) => {
      if (enough(tally)) return Effect.succeed(true);
      if (exhausted(budget)) {
        tally.notDecided.push(BUDGET_SPENT);
        return Effect.succeed(true);
      }
      return Effect.map(decide(ctx, budget, path, field), (outcome) => {
        record(tally, field, outcome);
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

/**
 * The sort-order suite, in report order.
 *
 * @internal
 */
export const rules: ReadonlyArray<RuleImpl> = [sortOrdering];
