/**
 * The filter profile's evaluation rule: what a filtered collection must hold,
 * judged by the kit's own oracle (`./semantics.ts`) over the collection the
 * server serves unfiltered (#161).
 *
 * No fixture is needed, because the unfiltered collection is the known set:
 * `docs/filter-grammar.md` §6.1 F-EVAL-4 reads `value(resource, field)` from
 * the resource's JSON representation and §6.2 F-ORD-1 defines comparison on
 * it, which is exactly what came back over the wire. So the rule fetches the
 * collection, builds filter trees over attributes it carries, evaluates each
 * tree over each resource with the §6.3 fold, and compares that match set with
 * the one the filtered request answers, on `(type, id)` — naming the resources
 * wrongly included and wrongly excluded.
 *
 * The happy path proves little: a server evaluating two-valued passes it. The
 * trees the rule sends are the ones that tell three-valued from two-valued
 * evaluation, so each needs an attribute that is NULL on some resources of the
 * sample and not on others — `ne` over NULL (F-CMP-1), `gte` in the domain
 * of the field's JSON type (F-CMP-2, F-ORD-1), `nin` over NULL (F-IN-2 /
 * F-IN-3), `isnull` (F-ISNULL-1 / F-ISNULL-2), excluded middle (F-CONS-1) —
 * plus the empty groups (F-AND-2), which need no field at all. A sample that
 * cannot discriminate says so rather than passing. A filter the server refuses
 * (a 400: the attribute may not be filterable, or not with that operator)
 * decides nothing here; the profile's rejection rules judge refusals.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type * as Filter from "../../Filter.js";
import { PROFILE_URI } from "../../Filter.js";
import {
  type Context,
  finding,
  type Finding,
  identity,
  isRecord,
  type Observation,
  parseMediaType,
  probeable,
  resourceLabel,
  resourcesOf,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  statusOf,
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
  Step,
  stepTo,
  type Target,
} from "./crawl.js";
import { isJson, type Json, matches, NULL, type Null, type Row } from "./semantics.js";

const rule: Rule = {
  id: "profile/filter/evaluation",
  tier: "profile",
  section: "filter-grammar/v1 §6 Semantics",
  reference:
    "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md#6-semantics",
  level: "MUST",
  requirement:
    "A filtered collection MUST hold exactly the resources whose filter tree evaluates to TRUE under §6, read from each resource's JSON representation: every comparison against NULL is UNKNOWN (F-CMP-1), `nin` is the negation of `in` (F-IN-2, F-IN-3), `isnull` is total (F-ISNULL-1, F-ISNULL-2), `Or(x, Not(x))` misses the NULLs (F-CONS-1), `And([])` matches every resource and `Or([])` none (F-AND-2), and FALSE and UNKNOWN both exclude (F-EVAL-3).",
};

/** The pages one walk of a collection may fetch before it is left undecided. */
const PAGE_BUDGET = 20;

/** The requests one run of the rule may make, over every collection it judges. */
const REQUEST_BUDGET = 200;

/** The attributes tried per collection before its NULL cases are left undecided. */
const FIELD_CAP = 3;

/** A resource object a document carries, as the kit reads it. */
type ResourceObject = ReturnType<typeof resourcesOf>[number]["resource"];

/** A filter tree whose literals are JSON scalars, as the rule builds them. */
type Tree = Filter.Ast<{ readonly [field: string]: Json }>;

// ---------------------------------------------------------------------------
// Walking a collection
// ---------------------------------------------------------------------------

/** How a walk of a collection ended. */
type Walked = Data.TaggedEnum<{
  /** Every page, walked: its primary resources, and the first page's answer. */
  Walked: { readonly first: Observation; readonly resources: ReadonlyArray<ResourceObject> };
  /** The first page was not a 200. */
  Refused: { readonly observation: Observation };
  /** The walk stopped short, so the collection is not known whole. */
  Undecided: { readonly why: string };
}>;
const Walked = Data.taggedEnum<Walked>();

/** Where a walk is: the page it fetches next, the pages and resources so far. */
interface Position {
  readonly target: Target;
  readonly visited: ReadonlyArray<string>;
  readonly resources: ReadonlyArray<ResourceObject>;
  readonly first: Option.Option<Observation>;
}

/** The primary resources of a collection document, when it is one. */
const primaryOf = (observation: Observation): Option.Option<ReadonlyArray<ResourceObject>> =>
  isRecord(observation.body) && Array.isArray(observation.body["data"])
    ? Option.some(
        Arr.filterMap(resourcesOf(observation.body), ({ pointer, resource }) =>
          pointer.startsWith("/data/") ? Result.succeed(resource) : Result.failVoid,
        ),
      )
    : Option.none();

/**
 * Where the `next` link on a page leads: nowhere on the last page, or why the
 * walk cannot follow it.
 */
const nextOf = (
  baseUrl: string,
  at: Position,
  observation: Observation,
): Result.Result<Option.Option<Target>, string> => {
  const on = `the \`next\` link on ${at.target.url}`;
  const next = linkIn(isRecord(observation.body) ? observation.body["links"] : undefined, "next");
  if (Link.$is("Unavailable")(next)) return Result.succeed(Option.none());
  if (!Link.$is("Href")(next)) return Result.fail(`${on} is not a link`);
  const step = stepTo(next.href, at.target, baseUrl);
  if (!Step.$is("Follow")(step)) return Result.fail(`${on} is not one the kit follows`);
  return Arr.contains(at.visited, step.target.href)
    ? Result.fail(`${on} leads back to a page already walked`)
    : Result.succeed(Option.some(step.target));
};

/**
 * What one page does to a walk: the position after it, or how the walk ends
 * there.
 */
const arrive = (
  baseUrl: string,
  url: string,
  at: Position,
  observation: Observation,
): Result.Result<Position, Walked> => {
  const page = Arr.length(at.visited);
  if (observation.status !== 200) {
    return Result.fail(
      Option.isNone(at.first)
        ? Walked.Refused({ observation })
        : Walked.Undecided({ why: `page ${page} of ${url} answered ${statusOf(observation)}` }),
    );
  }
  const data = primaryOf(observation);
  if (Option.isNone(data))
    return Result.fail(
      Walked.Undecided({ why: `${at.target.url} answered no collection document` }),
    );
  const first = Option.getOrElse(at.first, () => observation);
  const resources = Arr.appendAll(at.resources, data.value);
  return Result.match(nextOf(baseUrl, at, observation), {
    onFailure: (why) => Result.fail(Walked.Undecided({ why })),
    onSuccess: Option.match({
      onNone: () => Result.fail(Walked.Walked({ first, resources })),
      onSome: (target): Result.Result<Position, Walked> =>
        page >= PAGE_BUDGET
          ? Result.fail(Walked.Undecided({ why: `${url} has more than ${PAGE_BUDGET} pages` }))
          : Result.succeed({
              target,
              visited: Arr.append(at.visited, target.href),
              resources,
              first: Option.some(first),
            }),
    }),
  });
};

/**
 * Every primary resource of the collection at `url`, its `next` links followed
 * from the first page: a filtered collection is compared whole, never one page
 * of it. A first page that is not a 200 is `Refused`; anything that stops the
 * walk short — the budget, a lost or failed page, a `next` that leaves the
 * origin or leads back — leaves it undecided.
 */
const walk = (io: Io, baseUrl: string, url: string): Effect.Effect<Walked> => {
  const from = (at: Position): Effect.Effect<Walked> =>
    Effect.flatMap(io.fetch(at.target), (fetched) =>
      Option.match(fetched, {
        onNone: () =>
          Effect.succeed(
            Walked.Undecided({ why: `the rule's budget of ${REQUEST_BUDGET} requests ran out` }),
          ),
        onSome: (observation) =>
          Result.match(arrive(baseUrl, url, at, observation), {
            onFailure: Effect.succeed,
            onSuccess: from,
          }),
      }),
    );
  return Option.match(own(url, baseUrl), {
    onNone: () => Effect.succeed(Walked.Undecided({ why: `${url} does not parse as a URL` })),
    onSome: (target) =>
      from({ target, visited: [target.href], resources: [], first: Option.none() }),
  });
};

// ---------------------------------------------------------------------------
// What the sample can discriminate
// ---------------------------------------------------------------------------

/** A resource of the unfiltered collection, as the oracle reads it. */
interface Candidate {
  readonly key: string;
  readonly label: string;
  readonly row: Row;
  /** Every attribute member it carries. */
  readonly members: ReadonlyArray<string>;
  /** The members whose value is neither a JSON scalar nor `null` (§2.3: not filterable). */
  readonly composite: ReadonlyArray<string>;
}

/** A resource's attributes as §6.1 F-EVAL-4 reads them: `null` is NULL. */
const candidateOf = (resource: ResourceObject): Option.Option<Candidate> =>
  Option.map(Option.fromUndefinedOr(identity(resource)), (key) => {
    const attributes = isRecord(resource["attributes"]) ? resource["attributes"] : {};
    return {
      key,
      label: resourceLabel(resource),
      row: Rec.filterMap(attributes, (value): Result.Result<Json | Null, void> =>
        value === null
          ? Result.succeed(NULL)
          : isJson(value)
            ? Result.succeed(value)
            : Result.failVoid,
      ),
      members: Rec.keys(attributes),
      composite: Rec.keys(Rec.filter(attributes, (value) => value !== null && !isJson(value))),
    };
  });

/**
 * A literal as the wire spells it (§2.3), or none when the kit cannot spell it
 * in the grammar: a number the strict decimal grammar (§6.6) does not admit in
 * its JavaScript spelling (`1e21`).
 */
const spell = (value: Json): Option.Option<string> => {
  if (Predicate.isString(value)) return Option.some(value.replace(/[\\,]/g, (c) => `\\${c}`));
  const text = String(value);
  return Predicate.isBoolean(value) || /^-?\d+(\.\d+)?$/.test(text)
    ? Option.some(text)
    : Option.none();
};

/**
 * An attribute the sample can discriminate three-valued evaluation on: NULL
 * (or absent, F-EVAL-5) on at least one candidate and a JSON scalar on another,
 * every non-NULL value of one JSON type — the domain F-ORD-1 compares in,
 * inferred from what the server answered — and up to two literals to filter
 * by, each one the sample carries.
 */
interface Discriminating {
  readonly field: string;
  readonly literals: Arr.NonEmptyReadonlyArray<Json>;
}

/** The JSON type of a non-NULL value: F-ORD-1's domain. */
const domainOf = (value: Json): string =>
  Predicate.isString(value) ? "string" : Predicate.isNumber(value) ? "number" : "boolean";

const discriminatingOn =
  (candidates: ReadonlyArray<Candidate>) =>
  (field: string): Option.Option<Discriminating> => {
    if (Arr.some(candidates, ({ composite }) => Arr.contains(composite, field)))
      return Option.none();
    const present = Arr.filterMap(candidates, ({ row }) => {
      const value = row[field];
      return value === undefined || value === NULL ? Result.failVoid : Result.succeed(value);
    });
    const domains = Arr.dedupe(Arr.map(present, domainOf));
    const literals = Arr.take(
      Arr.filter(Arr.dedupe(present), (value) => Option.isSome(spell(value))),
      2,
    );
    return Arr.length(present) < Arr.length(candidates) &&
      Arr.length(domains) === 1 &&
      Arr.isReadonlyArrayNonEmpty(literals)
      ? Option.some({ field, literals })
      : Option.none();
  };

const discriminating = (candidates: ReadonlyArray<Candidate>): ReadonlyArray<Discriminating> =>
  Arr.getSomes(
    Arr.map(
      Arr.dedupe(Arr.flatMap(candidates, ({ members }) => members)),
      discriminatingOn(candidates),
    ),
  );

// ---------------------------------------------------------------------------
// The trees, and their wire spelling
// ---------------------------------------------------------------------------

interface Probe {
  /** The §6 rules the tree discriminates. */
  readonly rules: string;
  readonly node: Tree;
}

const fieldProbes = ({ field, literals }: Discriminating): ReadonlyArray<Probe> => {
  const value = Arr.headNonEmpty(literals);
  const eq: Tree = { _tag: "Compare", op: "eq", field, value };
  return [
    { rules: "F-CMP-1", node: { _tag: "Compare", op: "ne", field, value } },
    { rules: "F-CMP-1 / F-CMP-2 / F-ORD-1", node: { _tag: "Compare", op: "gte", field, value } },
    {
      rules: "F-IN-2 / F-IN-3",
      node: { _tag: "NotIn", field, values: [value, ...Arr.tailNonEmpty(literals)] },
    },
    { rules: "F-ISNULL-1 / F-ISNULL-2", node: { _tag: "IsNull", field, negated: true } },
    { rules: "F-ISNULL-1 / F-ISNULL-2", node: { _tag: "IsNull", field, negated: false } },
    { rules: "F-CONS-1", node: { _tag: "Or", members: [eq, { _tag: "Not", member: eq }] } },
  ];
};

const groupProbes: ReadonlyArray<Probe> = [
  { rules: "F-AND-2", node: { _tag: "And", members: [] } },
  { rules: "F-AND-2", node: { _tag: "Or", members: [] } },
];

/** A literal on the wire; `discriminating` kept only literals `spell` can spell. */
const wire = (value: Json): string => Option.getOrElse(spell(value), () => String(value));

/** A condition: the field it reads, and its operator and value as the wire spells them. */
interface Condition {
  readonly field: string;
  readonly operator: string;
  readonly value: string;
}

/** A node as a condition, or none for a group. */
const conditionOf = (node: Tree): Option.Option<Condition> =>
  Match.valueTags(node, {
    Compare: ({ op, field, value }) => Option.some({ field, operator: op, value: wire(value) }),
    In: ({ field, values }) =>
      Option.some({ field, operator: "in", value: Arr.map(values, wire).join(",") }),
    NotIn: ({ field, values }) =>
      Option.some({ field, operator: "nin", value: Arr.map(values, wire).join(",") }),
    IsNull: ({ field, negated }) =>
      Option.some({ field, operator: "isnull", value: String(!negated) }),
    And: () => Option.none(),
    Or: () => Option.none(),
    Not: () => Option.none(),
  });

type Pairs = ReadonlyArray<readonly [string, string]>;

/** The members of a group node; none for a condition. */
const membersOf = (node: Tree): ReadonlyArray<Tree> =>
  Match.valueTags(node, {
    Compare: () => [],
    In: () => [],
    NotIn: () => [],
    IsNull: () => [],
    And: ({ members }) => members,
    Or: ({ members }) => members,
    Not: ({ member }) => [member],
  });

/** A group's `conjunction` (§2.4); none for a condition. */
const conjunctionOf = (node: Tree): string =>
  Match.valueTags(node, {
    Compare: () => "",
    In: () => "",
    NotIn: () => "",
    IsNull: () => "",
    And: () => "AND",
    Or: () => "OR",
    Not: () => "NOT",
  });

interface Emitted {
  readonly pairs: Pairs;
  readonly next: number;
}

/**
 * A node and its descendants in the group form (§2.4), its id `n<index>`
 * numbered in the order the tree is walked depth-first, and the index the
 * next node after them takes.
 */
const groupForm = (node: Tree, index: number, parent: Option.Option<string>): Emitted => {
  const id = `n${index}`;
  const memberOf = (kind: string): Pairs =>
    Arr.fromOption(
      Option.map(parent, (group) => [`filter[${id}][${kind}][memberOf]`, group] as const),
    );
  return Option.match(conditionOf(node), {
    onSome: ({ field, operator, value }): Emitted => ({
      pairs: [
        [`filter[${id}][condition][path]`, field],
        [`filter[${id}][condition][operator]`, operator],
        [`filter[${id}][condition][value]`, value],
        ...memberOf("condition"),
      ],
      next: index + 1,
    }),
    onNone: (): Emitted =>
      Arr.reduce(
        membersOf(node),
        {
          pairs: [[`filter[${id}][group][conjunction]`, conjunctionOf(node)], ...memberOf("group")],
          next: index + 1,
        },
        (acc: Emitted, member): Emitted => {
          const emitted = groupForm(member, acc.next, Option.some(id));
          return { pairs: [...acc.pairs, ...emitted.pairs], next: emitted.next };
        },
      ),
  });
};

/**
 * A tree's `filter[…]` pairs: a lone condition in shorthand
 * (`filter[f][op]=v`, §2.2), anything else in the group form (§2.4).
 */
const pairsOf = (root: Tree): Pairs =>
  Option.match(conditionOf(root), {
    onSome: ({ field, operator, value }): Pairs => [[`filter[${field}][${operator}]`, value]],
    onNone: () => groupForm(root, 0, Option.none()).pairs,
  });

/** A literal as a finding names it: a string quoted, so `"1"` is not `1`. */
const shown = (value: Json): string =>
  Predicate.isString(value) ? `"${quote(value)}"` : String(value);

/** A tree as a finding names it, in the AST's own vocabulary. */
const show = (node: Tree): string =>
  Match.valueTags(node, {
    Compare: ({ op, field, value }) => `${op}(${field}, ${shown(value)})`,
    In: ({ field, values }) => `In(${field}, [${Arr.map(values, shown).join(", ")}])`,
    NotIn: ({ field, values }) => `NotIn(${field}, [${Arr.map(values, shown).join(", ")}])`,
    IsNull: ({ field, negated }) => `IsNull(${field}, negated: ${String(negated)})`,
    And: ({ members }) => `And([${Arr.map(members, show).join(", ")}])`,
    Or: ({ members }) => `Or([${Arr.map(members, show).join(", ")}])`,
    Not: ({ member }) => `Not(${show(member)})`,
  });

/** The fields a tree reads. */
const fieldsOf = (node: Tree): ReadonlyArray<string> =>
  Option.match(conditionOf(node), {
    onSome: ({ field }) => [field],
    onNone: () => Arr.dedupe(Arr.flatMap(membersOf(node), fieldsOf)),
  });

// ---------------------------------------------------------------------------
// Judging one tree
// ---------------------------------------------------------------------------

/** What one tree decided. */
type Judged = Data.TaggedEnum<{
  Decided: { readonly findings: ReadonlyArray<Finding> };
  Undecided: { readonly why: string };
}>;
const Judged = Data.taggedEnum<Judged>();

/** Labels as one line, or `none`. */
const named = (labels: ReadonlyArray<string>): string =>
  Arr.isReadonlyArrayEmpty(labels) ? "none" : listed(labels);

/** What a tree read on a candidate's field, as a finding names it. */
const readOn = (candidate: Candidate, field: string): string => {
  const value = candidate.row[field];
  if (value === undefined) return `${field}: absent (NULL)`;
  return value === NULL ? `${field}: null (NULL)` : `${field}: ${shown(value)}`;
};

/** A candidate as a finding names it, with each value the tree read on it. */
const labelled = (candidate: Candidate, node: Tree): string => {
  const values = Arr.map(fieldsOf(node), (field) => readOn(candidate, field));
  return Arr.isReadonlyArrayEmpty(values)
    ? candidate.label
    : `${candidate.label} (${values.join(", ")})`;
};

/** The resources a filtered answer lists, each once, by the identity the kit compares on. */
const answeredOf = (answered: ReadonlyArray<ResourceObject>) =>
  Arr.dedupeWith(
    Arr.getSomes(
      Arr.map(answered, (resource) =>
        Option.map(Option.fromUndefinedOr(identity(resource)), (key) => ({ key, resource })),
      ),
    ),
    (a, b) => a.key === b.key,
  );

/** The finding for a match set that is not the oracle's, if it is not. */
const compared = (
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
  first: Observation,
  answered: ReadonlyArray<ResourceObject>,
): ReadonlyArray<Finding> => {
  const expected = Arr.filter(candidates, ({ row }) => matches(probe.node, row));
  const wanted = HashSet.fromIterable(Arr.map(expected, ({ key }) => key));
  const got = answeredOf(answered);
  const gotKeys = HashSet.fromIterable(Arr.map(got, ({ key }) => key));
  const included = Arr.map(
    Arr.filter(got, ({ key }) => !HashSet.has(wanted, key)),
    ({ key, resource }) =>
      Option.match(
        Arr.findFirst(candidates, (candidate) => candidate.key === key),
        {
          onNone: () => `${resourceLabel(resource)} (not in the unfiltered collection)`,
          onSome: (candidate) => labelled(candidate, probe.node),
        },
      ),
  );
  const excluded = Arr.map(
    Arr.filter(expected, ({ key }) => !HashSet.has(gotKeys, key)),
    (candidate) => labelled(candidate, probe.node),
  );
  if (Arr.isReadonlyArrayEmpty(included) && Arr.isReadonlyArrayEmpty(excluded)) return [];
  return [
    finding(rule, {
      detail: `${probe.rules}: ${show(probe.node)} on ${path} answered the wrong resources`,
      expected: `${counted(Arr.length(expected), "resource")} of the ${counted(Arr.length(candidates), "resource")} the collection serves unfiltered: ${named(Arr.map(expected, ({ label }) => label))}`,
      observed: `wrongly included: ${named(included)}; wrongly excluded: ${named(excluded)}`,
      probe: first.probe,
    }),
  ];
};

const judge = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
): Effect.Effect<Judged> =>
  Effect.map(
    walk(io, ctx.options.baseUrl, withQuery(path, pairsOf(probe.node))),
    Walked.$match({
      Undecided: ({ why }) => Judged.Undecided({ why: `${probe.rules} on ${path}: ${why}` }),
      Refused: ({ observation }) =>
        Judged.Undecided({
          why: `${probe.rules} on ${path}: ${show(probe.node)} answered ${statusOf(observation)}`,
        }),
      Walked: ({ first, resources }) =>
        Judged.Decided({ findings: compared(path, candidates, probe, first, resources) }),
    }),
  );

const judgeAll = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probes: ReadonlyArray<Probe>,
): Effect.Effect<ReadonlyArray<Judged>> =>
  // One at a time: the trees share the rule's request budget and its cache.
  Effect.forEach(probes, (probe) => judge(io, ctx, path, candidates, probe), { concurrency: 1 });

/**
 * The NULL cases over each discriminating attribute in turn, stopping at the
 * first the server decides anything on: one that refuses every tree (an
 * attribute that is not filterable, say) gives way to the next.
 */
const judgeFields = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  fields: ReadonlyArray<Discriminating>,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Arr.matchLeft(fields, {
    onEmpty: () => Effect.succeed<ReadonlyArray<Judged>>([]),
    onNonEmpty: (field, rest) =>
      Effect.flatMap(
        judgeAll(io, ctx, path, candidates, fieldProbes(field)),
        (judged): Effect.Effect<ReadonlyArray<Judged>> =>
          Arr.some(judged, Judged.$is("Decided"))
            ? Effect.succeed(judged)
            : Effect.map(judgeFields(io, ctx, path, candidates, rest), (after) => [
                ...judged,
                ...after,
              ]),
      ),
  });

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** Whether an answer's media type names the filter profile (§5). */
const negotiated = (observation: Observation): boolean =>
  Option.exists(Option.fromUndefinedOr(observation.contentType), (header) =>
    Arr.contains(
      Arr.flatMap(parseMediaType(header).parameters, ([name, value]) =>
        name === "profile" ? value.split(" ") : [],
      ),
      PROFILE_URI,
    ),
  );

const undecided = (why: string): ReadonlyArray<Judged> => [Judged.Undecided({ why })];

/** Every tree judged on one collection, given its unfiltered walk. */
const judgeWalked = (
  io: Io,
  ctx: Context,
  path: string,
  first: Observation,
  resources: ReadonlyArray<ResourceObject>,
): Effect.Effect<ReadonlyArray<Judged>> => {
  if (!negotiated(first))
    return Effect.succeed(
      undecided(
        `${path} does not advertise the filter profile on its media type, so it has not negotiated §6 (\`profile/filter/advertises-profile-uri\` reports that)`,
      ),
    );
  const candidates = Arr.getSomes(Arr.map(resources, candidateOf));
  if (Arr.length(candidates) < Arr.length(resources))
    return Effect.succeed(undecided(`${path} serves resources without a usable \`(type, id)\``));
  if (Arr.isReadonlyArrayEmpty(candidates))
    return Effect.succeed(
      undecided(`${path} serves no resources unfiltered, so no filter can discriminate`),
    );
  const fields = Arr.take(discriminating(candidates), FIELD_CAP);
  return Effect.flatMap(
    judgeAll(io, ctx, path, candidates, groupProbes),
    (groups): Effect.Effect<ReadonlyArray<Judged>> =>
      Arr.isReadonlyArrayEmpty(fields)
        ? Effect.succeed([
            ...groups,
            ...undecided(
              `F-CMP-1, F-IN-2 / F-IN-3, F-ISNULL-1 / F-ISNULL-2 and F-CONS-1 on ${path}: no attribute of the ${counted(Arr.length(candidates), "resource")} it serves is NULL on some and a JSON scalar of one type on others, so the sample cannot tell three-valued evaluation from two-valued`,
            ),
          ])
        : Effect.map(judgeFields(io, ctx, path, candidates, fields), (judged) => [
            ...groups,
            ...judged,
          ]),
  );
};

const judgeCollection = (
  io: Io,
  ctx: Context,
  path: string,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Effect.flatMap(
    walk(io, ctx.options.baseUrl, path),
    Walked.$match({
      Undecided: ({ why }) => Effect.succeed(undecided(`${path}: ${why}`)),
      Refused: ({ observation }) =>
        Effect.succeed(undecided(`${path} answered ${statusOf(observation)} unfiltered`)),
      Walked: ({ first, resources }) => judgeWalked(io, ctx, path, first, resources),
    }),
  );

/**
 * `profile/filter/evaluation`: each collection endpoint speaking the grammar
 * (`filter: true`) whose answers advertise the profile, judged by the §6 fold
 * over its own unfiltered collection.
 *
 * @internal
 */
export const evaluation: RuleImpl = {
  rule,
  run: (ctx) => {
    const targets = Arr.filter(
      probeable(ctx, ["collection"]).resolved,
      ({ endpoint }) => endpoint.filterGrammar,
    );
    if (Arr.isReadonlyArrayEmpty(targets))
      return Effect.succeed(
        skip(
          rule,
          "no collection endpoint declares the filter grammar (`filter: true`); endpoints using the per-key `filter: { … }` escape hatch do not implement the profile",
        ),
      );
    const io = budgeted(ctx, REQUEST_BUDGET);
    return Effect.map(
      Effect.forEach(targets, ({ path }) => judgeCollection(io, ctx, path), { concurrency: 1 }),
      (perCollection) => {
        const judged = Arr.flatten(perCollection);
        const decided = Arr.filter(judged, Judged.$is("Decided"));
        const why = Arr.map(Arr.filter(judged, Judged.$is("Undecided")), ({ why }) => why).join(
          "; ",
        );
        if (Arr.isReadonlyArrayEmpty(decided)) return skip(rule, `no filter was decided: ${why}`);
        return settle(
          rule,
          Arr.length(decided),
          Arr.flatMap(decided, ({ findings }) => findings),
          why === "" ? undefined : `not decided: ${why}`,
        );
      },
    );
  },
};
