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
 * sample and not on others — `ne` over NULL (F-CMP-1), `lt` / `lte` / `gt` /
 * `gte` in the domain of the field's JSON type (F-CMP-2, F-ORD-1), `nin` over
 * NULL (F-IN-2 / F-IN-3), `isnull` (F-ISNULL-1 / F-ISNULL-2), excluded middle
 * (F-CONS-1) — plus the empty groups (F-AND-2), which need no field at all.
 * Beside them (#433): the ordering operators on an attribute the sample never
 * shows NULL, with a pivot that splits it (F-CMP-2, F-ORD-1) and `isnull=true`
 * as the constant F-ISNULL-4 makes it; a to-one relationship field, valued by
 * the related id its linkage shows (F-EVAL-4, F-ORD-5); and a filter beside a
 * sparse fieldset that leaves the filtered field out (F-EVAL-6). And the §6.5
 * corollaries (#458): De Morgan, `Not(In)` and `Not(Not(x))` as trees of their
 * own (F-CONS-2 to F-CONS-4), one of them again in a second spelling of its
 * canonical form (F-CONS-7), a filter beside `include` whose `included` must
 * hold what the matched primary data links to (F-CONS-6), and on every
 * filter sent alone, each answered resource held to its unfiltered
 * representation and an empty result to a 200 collection document (F-CONS-5).
 * A sample that cannot discriminate one of these says so rather than passing. A filter the
 * server refuses (a 400: the field may not be filterable, or not with that
 * operator) decides nothing here; the profile's rejection rules judge refusals.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as HashSet from "effect/HashSet";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Order from "effect/Order";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import type * as Filter from "../../Filter.js";
import { PROFILE_URI } from "../../Filter.js";
import {
  type Context,
  describe,
  type Discovered,
  finding,
  type Finding,
  identity,
  isJsonArray,
  isJsonObject,
  type Body,
  objectIn,
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
  topLevel,
  withQuery,
} from "./core.js";
import {
  budgeted,
  counted,
  type Io,
  Link,
  documentLink,
  listed,
  own,
  quote,
  Step,
  stepTo,
  type Target,
} from "./crawl.js";
import { compare, isJson, type Json, matches, NULL, type Null, type Row } from "./semantics.js";

const rule: Rule = {
  id: "profile/filter/evaluation",
  tier: "profile",
  section: "filter-grammar/v1 §6 Semantics",
  reference:
    "https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/filter-grammar.md#6-semantics",
  level: "MUST",
  requirement:
    "A filtered collection MUST hold exactly the resources whose filter tree evaluates to TRUE under §6, read from each resource's complete JSON representation whatever sparse fieldset the request names (F-EVAL-6), a to-one relationship valued by its related id (F-EVAL-4, F-ORD-5): every comparison against NULL is UNKNOWN (F-CMP-1), `lt` / `lte` / `gt` / `gte` order a value in the domain of its JSON type (F-CMP-2, F-ORD-1), `nin` is the negation of `in` (F-IN-2, F-IN-3), `isnull` is total (F-ISNULL-1, F-ISNULL-2, F-ISNULL-4), `Or(x, Not(x))` misses the NULLs (F-CONS-1), De Morgan holds both ways (F-CONS-2), `Not(In)` is `nin` (F-CONS-3), `Not(Not(x))` is `x` (F-CONS-4), a filter changes a response's membership and never its shape — an empty result a 200 collection, each resource as served unfiltered (F-CONS-5, F-ERR-2) — and never `included` (F-CONS-6), two spellings of one canonical form match alike (F-CONS-7), `And([])` matches every resource and `Or([])` none (F-AND-2), and FALSE and UNKNOWN both exclude (F-EVAL-3).",
};

/** The pages one walk of a collection may fetch before it is left undecided. */
const PAGE_BUDGET = 20;

/** The requests one run of the rule may make, over every collection it judges. */
const REQUEST_BUDGET = 200;

/** The fields one family of trees tries, per collection, before it is left undecided. */
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
  /** Every page, walked: its primary and included resources, and the first page's answer. */
  Walked: {
    readonly first: Observation;
    readonly resources: ReadonlyArray<ResourceObject>;
    readonly included: ReadonlyArray<ResourceObject>;
  };
  /** The first page was not a 200. */
  Refused: { readonly observation: Observation };
  /** The first page was a 200 carrying no collection document. */
  NotACollection: { readonly observation: Observation };
  /** The walk stopped short, so the collection is not known whole. */
  Undecided: { readonly why: string };
}>;
const Walked = Data.taggedEnum<Walked>();

/** Where a walk is: the page it fetches next, the pages and resources so far. */
interface Position {
  readonly target: Target;
  readonly visited: ReadonlyArray<string>;
  readonly resources: ReadonlyArray<ResourceObject>;
  readonly included: ReadonlyArray<ResourceObject>;
  readonly first: Option.Option<Observation>;
}

/** The resources a document carries under `member`'s pointer prefix. */
const locatedUnder = (body: Body, prefix: string): ReadonlyArray<ResourceObject> =>
  Arr.filterMap(resourcesOf(body), ({ pointer, resource }) =>
    pointer.startsWith(prefix) ? Result.succeed(resource) : Result.failVoid,
  );

/** The primary resources of a collection document, when it is one. */
const primaryOf = (observation: Observation): Option.Option<ReadonlyArray<ResourceObject>> =>
  Option.exists(topLevel(observation.body, "data"), isJsonArray)
    ? Option.some(locatedUnder(observation.body, "/data/"))
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
  const next = documentLink(observation.body, "next");
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
      Option.isNone(at.first)
        ? Walked.NotACollection({ observation })
        : Walked.Undecided({ why: `${at.target.url} answered no collection document` }),
    );
  const first = Option.getOrElse(at.first, () => observation);
  const resources = Arr.appendAll(at.resources, data.value);
  const included = Arr.appendAll(at.included, locatedUnder(observation.body, "/included/"));
  return Result.match(nextOf(baseUrl, at, observation), {
    onFailure: (why) => Result.fail(Walked.Undecided({ why })),
    onSuccess: Option.match({
      onNone: () => Result.fail(Walked.Walked({ first, resources, included })),
      onSome: (target): Result.Result<Position, Walked> =>
        page >= PAGE_BUDGET
          ? Result.fail(Walked.Undecided({ why: `${url} has more than ${PAGE_BUDGET} pages` }))
          : Result.succeed({
              target,
              visited: Arr.append(at.visited, target.href),
              resources,
              included,
              first: Option.some(first),
            }),
    }),
  });
};

/**
 * Every primary resource of the collection at `url`, its `next` links followed
 * from the first page: a filtered collection is compared whole, never one page
 * of it. A first page that is not a 200 is `Refused`, and a 200 that is no
 * collection document `NotACollection`; anything that stops the
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
      from({ target, visited: [target.href], resources: [], included: [], first: Option.none() }),
  });
};

// ---------------------------------------------------------------------------
// What the sample can discriminate
// ---------------------------------------------------------------------------

/** A resource of the unfiltered collection, as the oracle reads it. */
interface Candidate {
  readonly key: string;
  readonly type: string;
  readonly label: string;
  /** The resource object the unfiltered collection served (F-CONS-5 compares against it). */
  readonly resource: ResourceObject;
  /** Its attributes, and the to-one relationships whose linkage it shows. */
  readonly row: Row;
  /** Every attribute member it carries. */
  readonly members: ReadonlyArray<string>;
  /** The members whose value is neither a JSON scalar nor `null` (§2.3: not filterable). */
  readonly composite: ReadonlyArray<string>;
  /** The relationships whose `data` is a resource identifier or `null`: to-one linkage. */
  readonly toOne: ReadonlyArray<string>;
}

/**
 * A relationship's value as §6.1 F-EVAL-4 reads it — the related id, a JSON
 * string, or NULL for empty linkage (`data: null`) — or none when the
 * relationship shows no to-one linkage (links only, or a to-many array), so the
 * kit cannot know its value.
 */
const linkageOf = (relationship: ResourceObject): Option.Option<Json | Null> => {
  if (!("data" in relationship)) return Option.none();
  const data = relationship["data"];
  if (data === null) return Option.some(NULL);
  return isJsonObject(data) && Predicate.isString(data["id"])
    ? Option.some(data["id"])
    : Option.none();
};

/**
 * A resource's attributes as §6.1 F-EVAL-4 reads them, `null` as NULL, beside
 * its to-one relationships, each valued by the related id. A relationship
 * named like an attribute (which JSON:API forbids) is left out.
 */
const candidateOf = (resource: ResourceObject): Option.Option<Candidate> =>
  Option.map(Option.fromUndefinedOr(identity(resource)), (key) => {
    const attributes = objectIn(resource["attributes"]);
    const relationships = Rec.filterMap(
      objectIn(resource["relationships"]),
      (relationship, name): Result.Result<Json | Null, void> =>
        name in attributes || !isJsonObject(relationship)
          ? Result.failVoid
          : Option.match(linkageOf(relationship), {
              onNone: () => Result.failVoid,
              onSome: Result.succeed,
            }),
    );
    return {
      key,
      type: Predicate.isString(resource["type"]) ? resource["type"] : "",
      label: resourceLabel(resource),
      resource,
      row: {
        ...Rec.filterMap(attributes, (value): Result.Result<Json | Null, void> =>
          value === null
            ? Result.succeed(NULL)
            : isJson(value)
              ? Result.succeed(value)
              : Result.failVoid,
        ),
        ...relationships,
      },
      members: Rec.keys(attributes),
      composite: Rec.keys(Rec.filter(attributes, (value) => value !== null && !isJson(value))),
      toOne: Rec.keys(relationships),
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
 * A field the sample can discriminate on: every non-NULL value of one JSON
 * type — the domain F-ORD-1 compares in, inferred from what the server
 * answered — up to two literals to filter by, each one the sample carries, and
 * a pivot among them that splits the sample for the ordering operators.
 *
 * - An attribute that is `nullable` is NULL (or absent, F-EVAL-5) on at least
 *   one candidate and a JSON scalar on another: the three-valued cases.
 * - An attribute that is not is a JSON scalar on every candidate, with two or
 *   more distinct values: the ordering operators' two-valued cases (F-CMP-2).
 * - A relationship is a to-one relationship every candidate shows linkage for
 *   (F-EVAL-4), with two or more distinct ids unless it is `nullable`.
 */
interface Discriminating {
  readonly field: string;
  readonly nullable: boolean;
  readonly literals: Arr.NonEmptyReadonlyArray<Json>;
  readonly pivot: Json;
}

/** The JSON type of a non-NULL value: F-ORD-1's domain. */
const domainOf = (value: Json): string =>
  Predicate.isString(value) ? "string" : Predicate.isNumber(value) ? "number" : "boolean";

/** F-ORD-1's order on two values of one JSON type. */
const jsonOrder: Order.Order<Json> = (a, b) => {
  const order = compare(a, b);
  return order < 0 ? -1 : order > 0 ? 1 : 0;
};

/** A field's non-NULL values across the candidates. */
const presentIn = (candidates: ReadonlyArray<Candidate>, field: string): ReadonlyArray<Json> =>
  Arr.filterMap(candidates, ({ row }) => {
    const value = row[field];
    return value === undefined || value === NULL ? Result.failVoid : Result.succeed(value);
  });

/**
 * The field as {@link Discriminating}, or none when its values do
 * not discriminate: of more than one JSON type, or none the kit can spell, or
 * never NULL with fewer than two distinct values.
 */
const discriminatingOf = (
  candidates: ReadonlyArray<Candidate>,
  field: string,
): Option.Option<Discriminating> => {
  const present = presentIn(candidates, field);
  const spellable = Arr.filter(Arr.dedupe(present), (value) => Option.isSome(spell(value)));
  const nullable = Arr.length(present) < Arr.length(candidates);
  if (
    Arr.length(Arr.dedupe(Arr.map(present, domainOf))) !== 1 ||
    !Arr.isReadonlyArrayNonEmpty(spellable) ||
    (!nullable && Arr.length(spellable) < 2)
  )
    return Option.none();
  // F-ORD-1's order; `compare` cannot throw, the values sharing one JSON type.
  const ordered = Arr.sort(spellable, jsonOrder);
  return Option.some({
    field,
    nullable,
    literals: [Arr.headNonEmpty(spellable), ...Arr.take(Arr.tailNonEmpty(spellable), 1)],
    pivot: ordered[Math.floor(Arr.length(ordered) / 2)] ?? Arr.headNonEmpty(spellable),
  });
};

/** Every attribute member some candidate carries, never one composite on any (§2.3). */
const attributeFields = (candidates: ReadonlyArray<Candidate>): ReadonlyArray<Discriminating> =>
  Arr.getSomes(
    Arr.map(
      Arr.filter(
        Arr.dedupe(Arr.flatMap(candidates, ({ members }) => members)),
        (field) => !Arr.some(candidates, ({ composite }) => Arr.contains(composite, field)),
      ),
      (field) => discriminatingOf(candidates, field),
    ),
  );

/**
 * Every to-one relationship each candidate shows linkage for (F-EVAL-4), those
 * with empty linkage on some candidates first: they decide the NULL cases too.
 */
const relationshipFields = (
  candidates: ReadonlyArray<Candidate>,
): ReadonlyArray<Discriminating> => {
  const fields = Arr.getSomes(
    Arr.map(
      Arr.filter(Arr.dedupe(Arr.flatMap(candidates, ({ toOne }) => toOne)), (field) =>
        Arr.every(candidates, ({ toOne }) => Arr.contains(toOne, field)),
      ),
      (field) => discriminatingOf(candidates, field),
    ),
  );
  return [
    ...Arr.filter(fields, (field) => field.nullable),
    ...Arr.filter(fields, (field) => !field.nullable),
  ];
};

// ---------------------------------------------------------------------------
// The trees, and their wire spelling
// ---------------------------------------------------------------------------

/** A sparse fieldset sent beside the filter: `fields[type]=names` (F-EVAL-6). */
interface Fieldset {
  readonly type: string;
  readonly names: string;
}

interface Probe {
  /** The §6 rules the tree discriminates. */
  readonly rules: string;
  readonly node: Tree;
  readonly fieldset: Option.Option<Fieldset>;
  /** A relationship sent as `include` beside the filter (F-CONS-6). */
  readonly include: Option.Option<string>;
  /**
   * Whether the tree is sent in a second spelling of its canonical form —
   * group ids renamed, keys in reverse order (F-CONS-7) — rather than the
   * kit's usual one.
   */
  readonly respelled: boolean;
}

const probe = (rules: string, node: Tree): Probe => ({
  rules,
  node,
  fieldset: Option.none(),
  include: Option.none(),
  respelled: false,
});

/** The NULL cases over an attribute NULL on some candidates and not on others. */
const nullableProbes = ({ field, literals, pivot }: Discriminating): ReadonlyArray<Probe> => {
  const value = Arr.headNonEmpty(literals);
  const eq: Tree = { _tag: "Compare", op: "eq", field, value };
  const ordering = "F-CMP-1 / F-CMP-2 / F-ORD-1";
  return [
    probe("F-CMP-1", { _tag: "Compare", op: "ne", field, value }),
    probe(ordering, { _tag: "Compare", op: "gte", field, value }),
    probe(ordering, { _tag: "Compare", op: "lt", field, value: pivot }),
    probe(ordering, { _tag: "Compare", op: "lte", field, value: pivot }),
    probe(ordering, { _tag: "Compare", op: "gt", field, value: pivot }),
    probe("F-IN-2 / F-IN-3", { _tag: "NotIn", field, values: literals }),
    probe("F-ISNULL-1 / F-ISNULL-2", { _tag: "IsNull", field, negated: true }),
    probe("F-ISNULL-1 / F-ISNULL-2", { _tag: "IsNull", field, negated: false }),
    probe("F-CONS-1", { _tag: "Or", members: [eq, { _tag: "Not", member: eq }] }),
  ];
};

/**
 * The ordering operators over an attribute never NULL in the sample, each at
 * a pivot that splits it, and `isnull=true`, which F-ISNULL-4 makes a constant.
 */
const totalProbes = ({ field, pivot }: Discriminating): ReadonlyArray<Probe> => {
  const ordering = "F-CMP-2 / F-ORD-1";
  return [
    probe(ordering, { _tag: "Compare", op: "lt", field, value: pivot }),
    probe(ordering, { _tag: "Compare", op: "lte", field, value: pivot }),
    probe(ordering, { _tag: "Compare", op: "gt", field, value: pivot }),
    probe(ordering, { _tag: "Compare", op: "gte", field, value: pivot }),
    probe("F-ISNULL-4", { _tag: "IsNull", field, negated: false }),
  ];
};

/**
 * Equality and membership over a to-one relationship, valued by the related
 * id (F-ORD-5 admits no ordering operator on one), and its NULL cases when its
 * linkage is empty on some candidates.
 */
const relationshipProbes = ({
  field,
  nullable,
  literals,
}: Discriminating): ReadonlyArray<Probe> => {
  const value = Arr.headNonEmpty(literals);
  const valued = "F-EVAL-4 / F-ORD-5";
  return [
    probe(valued, { _tag: "Compare", op: "eq", field, value }),
    probe(nullable ? `${valued} / F-CMP-1` : valued, { _tag: "Compare", op: "ne", field, value }),
    probe(nullable ? `${valued} / F-IN-2 / F-IN-3` : valued, {
      _tag: "NotIn",
      field,
      values: literals,
    }),
    ...(nullable
      ? [
          probe(`${valued} / F-ISNULL-1`, { _tag: "IsNull", field, negated: false }),
          probe(`${valued} / F-ISNULL-1`, { _tag: "IsNull", field, negated: true }),
        ]
      : []),
  ];
};

/**
 * The §6.5 corollaries over a field, each a tree the fold decides on its own
 * — so a server that gets one wrong fails that tree — with `a` an equality
 * that is UNKNOWN where the field is NULL and `b` the total `isnull`:
 *
 * - De Morgan both ways, each side sent (F-CONS-2);
 * - `Not(In)`, which must answer as `nin` does (F-CONS-3);
 * - `Not(Not(a))`, which must answer as `a` does (F-CONS-4);
 * - one of the De Morgan trees again, its members in the other order, in a
 *   second spelling of the same canonical form (F-CONS-7).
 */
const corollaryProbes = ({ field, literals }: Discriminating): ReadonlyArray<Probe> => {
  const a: Tree = { _tag: "Compare", op: "eq", field, value: Arr.headNonEmpty(literals) };
  const b: Tree = { _tag: "IsNull", field, negated: false };
  const not = (member: Tree): Tree => ({ _tag: "Not", member });
  return [
    probe("F-CONS-2", not({ _tag: "And", members: [a, b] })),
    probe("F-CONS-2", { _tag: "Or", members: [not(a), not(b)] }),
    probe("F-CONS-2", not({ _tag: "Or", members: [a, b] })),
    probe("F-CONS-2", { _tag: "And", members: [not(a), not(b)] }),
    probe("F-CONS-3", not({ _tag: "In", field, values: literals })),
    probe("F-CONS-4", not(not(a))),
    {
      ...probe("F-CONS-7", { _tag: "Or", members: [not(b), not(a)] }),
      respelled: true,
    },
  ];
};

const groupProbes: ReadonlyArray<Probe> = [
  probe("F-AND-2", { _tag: "And", members: [] }),
  probe("F-AND-2", { _tag: "Or", members: [] }),
];

/** A literal on the wire; `discriminatingOf` kept only literals `spell` can spell. */
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
 * A node and its descendants in the group form (§2.4), its id `<prefix><index>`
 * numbered in the order the tree is walked depth-first, and the index the
 * next node after them takes.
 */
const groupForm = (
  node: Tree,
  index: number,
  parent: Option.Option<string>,
  prefix: string,
): Emitted => {
  const id = `${prefix}${index}`;
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
          const emitted = groupForm(member, acc.next, Option.some(id), prefix);
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
    onNone: () => groupForm(root, 0, Option.none(), "n").pairs,
  });

/**
 * A second spelling of a tree's canonical form (§3, F-CONS-7): the group form
 * with every id renamed and every key in reverse order, so each member comes
 * before the group it names in `memberOf`.
 */
const respelledPairsOf = (root: Tree): Pairs =>
  Arr.reverse(groupForm(root, 0, Option.none(), "r").pairs);

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

/** A probe as a finding names it: its tree, its spelling, and what is sent beside it. */
const described = ({ node, fieldset, include, respelled }: Probe): string =>
  [
    show(node),
    ...(respelled ? ["respelled (group ids renamed, keys reversed)"] : []),
    ...Arr.fromOption(Option.map(fieldset, ({ type, names }) => `with fields[${type}]=${names}`)),
    ...Arr.fromOption(Option.map(include, (name) => `with include=${name}`)),
  ].join(" ");

/** A probe's query: its tree's `filter[…]` pairs, then its fieldset's and its `include`. */
const queryOf = ({ node, fieldset, include, respelled }: Probe): Pairs => [
  ...(respelled ? respelledPairsOf(node) : pairsOf(node)),
  ...Arr.fromOption(Option.map(fieldset, ({ type, names }) => [`fields[${type}]`, names] as const)),
  ...Arr.fromOption(Option.map(include, (name) => ["include", name] as const)),
];

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

/** A filtered answer's resources, each once, keyed. */
type Answered = ReturnType<typeof answeredOf>;

/** The candidates the fold says a probe's tree matches. */
const expectedOf = (candidates: ReadonlyArray<Candidate>, probe: Probe) =>
  Arr.filter(candidates, ({ row }) => matches(probe.node, row));

/** The finding for a match set that is not the oracle's, if it is not. */
const compared = (
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
  first: Observation,
  got: Answered,
): ReadonlyArray<Finding> => {
  const expected = expectedOf(candidates, probe);
  const wanted = HashSet.fromIterable(Arr.map(expected, ({ key }) => key));
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
      detail: `${probe.rules}: ${described(probe)} on ${path} answered the wrong resources`,
      expected: `${counted(Arr.length(expected), "resource")} of the ${counted(Arr.length(candidates), "resource")} the collection serves unfiltered: ${named(Arr.map(expected, ({ label }) => label))}`,
      observed: `wrongly included: ${named(included)}; wrongly excluded: ${named(excluded)}`,
      probe: first.probe,
    }),
  ];
};

/** The members of a resource object F-CONS-5 holds to its unfiltered representation. */
const REPRESENTATION = ["attributes", "relationships", "links", "meta"] as const;

/**
 * F-CONS-5: the finding for answered resources whose representation is not
 * the one the collection serves unfiltered, if any. Only a probe that sends
 * the filter alone is held to it: a fieldset changes the representation by
 * design, and an `include` may add the linkage it follows.
 */
const representationChanged = (
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
  first: Observation,
  got: Answered,
): ReadonlyArray<Finding> => {
  if (Option.isSome(probe.fieldset) || Option.isSome(probe.include)) return [];
  const changed = Arr.filterMap(got, ({ key, resource }) =>
    Option.match(
      Arr.findFirst(candidates, (candidate) => candidate.key === key),
      {
        onNone: () => Result.failVoid,
        onSome: (candidate) => {
          const members = Arr.filter(
            REPRESENTATION,
            (member) => !Equal.equals(candidate.resource[member], resource[member]),
          );
          return Arr.isReadonlyArrayEmpty(members)
            ? Result.failVoid
            : Result.succeed(`${candidate.label} (${members.join(", ")})`);
        },
      },
    ),
  );
  if (Arr.isReadonlyArrayEmpty(changed)) return [];
  return [
    finding(rule, {
      detail: `F-CONS-5: ${described(probe)} on ${path} changed the representation of resources it answered`,
      expected:
        "each resource exactly as the collection serves it unfiltered: a filter changes a response's membership, never its shape",
      observed: `changed: ${listed(changed)}`,
      probe: first.probe,
    }),
  ];
};

/** The resource identifiers a resource's relationship `name` shows linkage to. */
const linkedThrough = (resource: ResourceObject, name: string): ReadonlyArray<ResourceObject> => {
  const relationships = resource["relationships"];
  const relationship = isJsonObject(relationships) ? relationships[name] : null;
  const data = isJsonObject(relationship) ? relationship["data"] : null;
  return Arr.filter(isJsonArray(data) ? data : [data], isJsonObject);
};

/**
 * F-CONS-6: the finding for resources the answered primary data links to
 * through the probe's `include` that neither `included` nor the primary data
 * carries, if any — a filter constrains the primary data, never `included`.
 */
const unincluded = (
  path: string,
  probe: Probe,
  first: Observation,
  got: Answered,
  included: ReadonlyArray<ResourceObject>,
): ReadonlyArray<Finding> =>
  Arr.flatMap(Arr.fromOption(probe.include), (name) => {
    const carried = HashSet.fromIterable([
      ...Arr.map(got, ({ key }) => key),
      ...Arr.getSomes(Arr.map(included, (resource) => Option.fromUndefinedOr(identity(resource)))),
    ]);
    const missing = Arr.dedupe(
      Arr.filterMap(
        Arr.flatMap(got, ({ resource }) => linkedThrough(resource, name)),
        (linked) => {
          const key = identity(linked);
          return key === undefined || HashSet.has(carried, key)
            ? Result.failVoid
            : Result.succeed(resourceLabel(linked));
        },
      ),
    );
    return Arr.isReadonlyArrayEmpty(missing)
      ? []
      : [
          finding(rule, {
            detail: `F-CONS-6: ${described(probe)} on ${path} left out of \`included\` resources its primary data links to`,
            expected: `every resource the primary data links to through \`${name}\`, in \`included\`: a filter constrains the primary data, never \`included\``,
            observed: `missing from \`included\`: ${listed(missing)}`,
            probe: first.probe,
          }),
        ];
  });

/**
 * F-CONS-5 / F-ERR-2: a first page that is not the collection document the
 * unfiltered request answered — a 200 that is no collection document, or a
 * 404 where the fold matches nothing — or none when the answer decides
 * nothing (a 400 refusal, say).
 */
const collectionMismatch = (
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
  observation: Observation,
  notACollection: boolean,
): Option.Option<Finding> =>
  notACollection ||
  (observation.status === 404 && Arr.isReadonlyArrayEmpty(expectedOf(candidates, probe)))
    ? Option.some(
        finding(rule, {
          detail: `F-CONS-5 / F-ERR-2: ${described(probe)} on ${path} did not answer a collection document`,
          expected:
            "200 with a collection document, as unfiltered — `data: []` when nothing matches: a filter changes a response's membership, never its shape",
          observed: describe(observation),
          probe: observation.probe,
        }),
      )
    : Option.none();

const judge = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  probe: Probe,
): Effect.Effect<Judged> =>
  Effect.map(
    walk(io, ctx.options.baseUrl, withQuery(path, queryOf(probe))),
    Walked.$match({
      Undecided: ({ why }) => Judged.Undecided({ why: `${probe.rules} on ${path}: ${why}` }),
      Refused: ({ observation }) =>
        Option.match(collectionMismatch(path, candidates, probe, observation, false), {
          onSome: (found) => Judged.Decided({ findings: [found] }),
          onNone: () =>
            Judged.Undecided({
              why: `${probe.rules} on ${path}: ${described(probe)} answered ${statusOf(observation)}`,
            }),
        }),
      NotACollection: ({ observation }) =>
        Judged.Decided({
          findings: Arr.fromOption(collectionMismatch(path, candidates, probe, observation, true)),
        }),
      Walked: ({ first, resources, included }) => {
        const got = answeredOf(resources);
        return Judged.Decided({
          findings: [
            ...compared(path, candidates, probe, first, got),
            ...representationChanged(path, candidates, probe, first, got),
            ...unincluded(path, probe, first, got, included),
          ],
        });
      },
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
 * One family of trees over each discriminating field in turn, stopping at the
 * first the server decides anything on: one that refuses every tree (a field
 * that is not filterable, say) gives way to the next.
 */
const judgeFields = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  fields: ReadonlyArray<Discriminating>,
  probesOf: (field: Discriminating) => ReadonlyArray<Probe>,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Arr.matchLeft(fields, {
    onEmpty: () => Effect.succeed<ReadonlyArray<Judged>>([]),
    onNonEmpty: (field, rest) =>
      Effect.flatMap(
        judgeAll(io, ctx, path, candidates, probesOf(field)),
        (judged): Effect.Effect<ReadonlyArray<Judged>> =>
          Arr.some(judged, Judged.$is("Decided"))
            ? Effect.succeed(judged)
            : Effect.map(judgeFields(io, ctx, path, candidates, rest, probesOf), (after) => [
                ...judged,
                ...after,
              ]),
      ),
  });

/** One family of trees: the fields it reads, and why it is undecided without one. */
interface Family {
  readonly fields: ReadonlyArray<Discriminating>;
  readonly probesOf: (field: Discriminating) => ReadonlyArray<Probe>;
  readonly none: string;
}

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

/**
 * The F-EVAL-6 probe over a field: `eq` on its first literal, beside a sparse
 * fieldset naming another field the sample carries and leaving it out. None
 * when the sample carries no other field to name.
 */
const sparseProbe =
  (candidates: ReadonlyArray<Candidate>, type: string) =>
  ({ field, literals }: Discriminating): Option.Option<Probe> =>
    Option.map(
      Arr.findFirst(
        Arr.dedupe(Arr.flatMap(candidates, ({ members, toOne }) => [...members, ...toOne])),
        (name) => name !== field,
      ),
      (names) => ({
        ...probe("F-EVAL-6", {
          _tag: "Compare",
          op: "eq",
          field,
          value: Arr.headNonEmpty(literals),
        }),
        fieldset: Option.some({ type, names }),
      }),
    );

/**
 * The F-EVAL-6 family: a fieldset is sent only for the one type the
 * collection serves, and only when the endpoint declares `fields[TYPE]` for it
 * — an undeclared one is a 400 (#261), which would decide nothing.
 */
const sparseFamily = (
  endpoint: Discovered,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  fields: ReadonlyArray<Discriminating>,
): Family => {
  const types = Arr.dedupe(Arr.map(candidates, ({ type }) => type));
  const type = Arr.length(types) === 1 ? Arr.head(types) : Option.none<string>();
  const declared = Option.filter(
    type,
    (name) =>
      Arr.contains(endpoint.queryKeys, `fields[${name}]`) ||
      Arr.contains(endpoint.queryPrefixes, "fields["),
  );
  const none = `F-EVAL-6 on ${path}: ${Option.match(declared, {
    onSome: () => "no discriminating field has another field beside it to request in its place",
    onNone: () =>
      Option.match(type, {
        onSome: (name) => `it declares no \`fields[${name}]\`, so no sparse fieldset can be sent`,
        onNone: () => `it serves more than one type, so no one sparse fieldset applies`,
      }),
  })}`;
  return Option.match(declared, {
    onNone: () => ({ fields: [], probesOf: () => [], none }),
    onSome: (name) => {
      const probeOf = sparseProbe(candidates, name);
      return {
        fields: Arr.filter(fields, (field) => Option.isSome(probeOf(field))),
        probesOf: (field) => Arr.fromOption(probeOf(field)),
        none,
      };
    },
  });
};

/** The relationships some candidate shows linkage through, in the order they first appear. */
const linkedRelationships = (candidates: ReadonlyArray<Candidate>): ReadonlyArray<string> =>
  Arr.filter(
    Arr.dedupe(
      Arr.flatMap(candidates, ({ resource }) => Rec.keys(objectIn(resource["relationships"]))),
    ),
    (name) =>
      Arr.some(candidates, ({ resource }) =>
        Arr.isReadonlyArrayNonEmpty(linkedThrough(resource, name)),
      ),
  );

/**
 * The F-CONS-6 family: `eq` on a field beside `include` of the first
 * relationship the sample shows linkage through, on a field whose `eq` matches
 * a resource that links through it — sent only when the endpoint declares
 * `include`, since an undeclared one is a 400, which would decide nothing.
 */
const includeFamily = (
  endpoint: Discovered,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  fields: ReadonlyArray<Discriminating>,
): Family => {
  const declared = Arr.contains(endpoint.queryKeys, "include");
  const relationship = declared ? Arr.head(linkedRelationships(candidates)) : Option.none<string>();
  const none = `F-CONS-6 on ${path}: ${
    declared
      ? "no discriminating field matches a resource that shows linkage to include"
      : "it declares no `include`, so no included resource can be asked for"
  }`;
  return Option.match(relationship, {
    onNone: () => ({ fields: [], probesOf: () => [], none }),
    onSome: (name) => {
      const probeOf = ({ field, literals }: Discriminating): Probe => ({
        ...probe("F-CONS-6", {
          _tag: "Compare",
          op: "eq",
          field,
          value: Arr.headNonEmpty(literals),
        }),
        include: Option.some(name),
      });
      return {
        fields: Arr.filter(fields, (field) =>
          Arr.some(expectedOf(candidates, probeOf(field)), ({ resource }) =>
            Arr.isReadonlyArrayNonEmpty(linkedThrough(resource, name)),
          ),
        ),
        probesOf: (field) => [probeOf(field)],
        none,
      };
    },
  });
};

/** Every family judged in turn, each one's undecided reason kept when it has no field. */
const judgeFamilies = (
  io: Io,
  ctx: Context,
  path: string,
  candidates: ReadonlyArray<Candidate>,
  families: ReadonlyArray<Family>,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Effect.map(
    Effect.forEach(
      families,
      ({ fields, probesOf, none }) =>
        Arr.isReadonlyArrayEmpty(fields)
          ? Effect.succeed(undecided(none))
          : judgeFields(io, ctx, path, candidates, Arr.take(fields, FIELD_CAP), probesOf),
      { concurrency: 1 },
    ),
    Arr.flatten,
  );

/** Every tree judged on one collection, given its unfiltered walk. */
const judgeWalked = (
  io: Io,
  ctx: Context,
  endpoint: Discovered,
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
  const served = counted(Arr.length(candidates), "resource");
  const attributes = attributeFields(candidates);
  const nullable = Arr.filter(attributes, (field) => field.nullable);
  const total = Arr.filter(attributes, (field) => !field.nullable);
  const relationships = relationshipFields(candidates);
  const families: ReadonlyArray<Family> = [
    {
      fields: nullable,
      probesOf: nullableProbes,
      none: `F-CMP-1, F-IN-2 / F-IN-3, F-ISNULL-1 / F-ISNULL-2 and F-CONS-1 on ${path}: no attribute of the ${served} it serves is NULL on some and a JSON scalar of one type on others, so the sample cannot tell three-valued evaluation from two-valued`,
    },
    {
      fields: total,
      probesOf: totalProbes,
      none: `F-CMP-2 / F-ORD-1 and F-ISNULL-4 over an attribute never NULL on ${path}: no attribute of the ${served} it serves is a JSON scalar of one type on every one, with two or more values`,
    },
    {
      fields: relationships,
      probesOf: relationshipProbes,
      none: `F-EVAL-4 / F-ORD-5 on ${path}: no to-one relationship shows its linkage on every one of the ${served} it serves, with two or more ids or an empty linkage among them`,
    },
    {
      // The fields that decide three-valued evaluation first: a corollary over
      // a field never NULL holds under two-valued evaluation too.
      fields: [
        ...nullable,
        ...Arr.filter(relationships, (field) => field.nullable),
        ...total,
        ...Arr.filter(relationships, (field) => !field.nullable),
      ],
      probesOf: corollaryProbes,
      none: `F-CONS-2 to F-CONS-4 and F-CONS-7 on ${path}: no attribute or to-one relationship of the ${served} it serves has a value to filter by`,
    },
    sparseFamily(endpoint, path, candidates, [...nullable, ...total, ...relationships]),
    includeFamily(endpoint, path, candidates, [...nullable, ...total, ...relationships]),
  ];
  return Effect.flatMap(judgeAll(io, ctx, path, candidates, groupProbes), (groups) =>
    Effect.map(judgeFamilies(io, ctx, path, candidates, families), (judged) => [
      ...groups,
      ...judged,
    ]),
  );
};

const judgeCollection = (
  io: Io,
  ctx: Context,
  endpoint: Discovered,
  path: string,
): Effect.Effect<ReadonlyArray<Judged>> =>
  Effect.flatMap(
    walk(io, ctx.options.baseUrl, path),
    Walked.$match({
      Undecided: ({ why }) => Effect.succeed(undecided(`${path}: ${why}`)),
      Refused: ({ observation }) =>
        Effect.succeed(undecided(`${path} answered ${statusOf(observation)} unfiltered`)),
      NotACollection: () => Effect.succeed(undecided(`${path} answered no collection document`)),
      Walked: ({ first, resources }) => judgeWalked(io, ctx, endpoint, path, first, resources),
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
      Effect.forEach(targets, ({ endpoint, path }) => judgeCollection(io, ctx, endpoint, path), {
        concurrency: 1,
      }),
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
