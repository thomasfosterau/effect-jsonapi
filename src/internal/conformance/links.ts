/**
 * The link dereferencing rules: a resource object's `self` link, and a
 * relationship's `related` link, each followed and held to what it claims.
 *
 * Nothing in the type system ties a link *string* to the route that serves
 * it, so a link is the part of a JSON:API server most likely to drift quietly.
 * These rules collect the links the read endpoints' answers carry and `GET`
 * each: a resource's `self` must answer that resource as primary data; a
 * relationship's `related` must answer resource data at all (a MUST) and
 * should answer the resources its linkage names (graded SHOULD, since the
 * spec says so only in prose without a keyword).
 *
 * The crawl is the pagination walk's (`./crawl.ts`): a link resolves against
 * the document that carries it, one that leads to another origin is never
 * requested, every request is a `GET` under a per-run budget, and a server
 * error, a rate limit, a request timeout or a lost response leaves the link
 * not decided rather than failed. A crawl the budget cannot finish is not passed.
 *
 * @since 0.17.0
 * @internal
 */
import * as Arr from "effect/Array";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HashSet from "effect/HashSet";
import * as MutableHashSet from "effect/MutableHashSet";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import {
  type Context,
  coverageNote,
  describe,
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
  resourcesOf,
  type Role,
  type Rule,
  type RuleImpl,
  settle,
  skip,
  statusOf,
  succeeded,
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

const SPEC = "https://jsonapi.org/format/1.1";

/** The requests one run of a rule may make, the read endpoints' included. */
const REQUEST_BUDGET = 200;

/**
 * The findings one rule lists by name. A server whose every link is broken
 * would otherwise list one per link the budget allows; the rest are counted.
 */
const FINDING_LIMIT = 10;

/**
 * The roles of the endpoints whose answers the links are collected from:
 * every read endpoint whose primary data is resource objects. (A relationship
 * endpoint answers identifiers, which carry no links to follow.)
 */
const SOURCE_ROLES: ReadonlyArray<Role> = ["collection", "resource", "related"];

/** The id of the rule that holds a `related` link to answering at all. */
const RELATED_DEREFERENCES = "spec/links/related-dereferences";

// ---------------------------------------------------------------------------
// What a link claims
// ---------------------------------------------------------------------------

/**
 * A JSON object off the wire, as `isRecord` narrows one.
 */
// oxlint-disable-next-line effect/no-unsafe-dictionary-type -- the kit reads the server's document as it came, with no schema to parse it by: deciding whether it holds is the point
type JsonObject = Readonly<Record<string, unknown>>;

/** A resource as the kit compares and names it. */
interface Member {
  readonly key: string;
  readonly label: string;
}

/**
 * What following a link must answer: for a resource's `self`, that resource;
 * for a relationship's `related`, resource data of any identity (the MUST) or
 * what its linkage names — one resource, none (`null` linkage), or a set of
 * them, each side possibly only a page (the SHOULD). `Unidentified` is a claim
 * the kit cannot hold an answer to: a resource, or linkage, without a string
 * `type` and `id`. Like an answer it cannot identify, it leaves the link not
 * decided, on either rule, rather than weakening or skewing the comparison.
 */
type Claim =
  | { readonly _tag: "Resource"; readonly member: Member }
  | { readonly _tag: "ResourceData" }
  | { readonly _tag: "ToOne"; readonly member: Member }
  | { readonly _tag: "Empty" }
  | {
      readonly _tag: "ToMany";
      readonly members: ReadonlyArray<Member>;
      /** `true` when the relationship carries a `next` link: its linkage is one page. */
      readonly paged: boolean;
    }
  | { readonly _tag: "Unidentified"; readonly why: string };
const Claim = Data.taggedEnum<Claim>();

/** A link the kit found: which, where, and what following it must answer. */
interface Found {
  /** "the `self` link of articles:1 (in /articles, at /data/0)", for findings. */
  readonly where: string;
  /** What carries it, wherever it was found: "articles:1", or "articles:1's `author`". */
  readonly of: string;
  /** Which member of the links object: `self` or `related`. */
  readonly name: "self" | "related";
  readonly link: Link;
  readonly from: Target;
  readonly claim: Claim;
}

/** Why an item without a string `type` and `id` cannot be compared. */
const NO_IDENTITY = "a string `type` and `id`";

const memberOf = (resource: JsonObject): Option.Option<Member> =>
  Predicate.isString(resource["type"]) && Predicate.isString(resource["id"])
    ? Option.map(Option.fromUndefinedOr(identity(resource)), (key) => ({
        key,
        label: quote(resourceLabel(resource)),
      }))
    : Option.none();

/** The identity of each item of a JSON array, or how many items lack one. */
const membersOf = (items: ReadonlyArray<unknown>): Result.Result<ReadonlyArray<Member>, number> => {
  const members = Arr.filterMap(items, (item) =>
    isRecord(item) ? Result.fromOption(memberOf(item), () => undefined) : Result.fail(undefined),
  );
  return members.length === items.length
    ? Result.succeed(members)
    : Result.fail(items.length - members.length);
};

/** What a relationship object's linkage claims its `related` link answers. */
const claimOf = (relationship: JsonObject): Claim => {
  const data = relationship["data"];
  if (data === null) return Claim.Empty();
  const unidentified = (count: number) =>
    Claim.Unidentified({
      why: `— its linkage names ${counted(count, "item")} without ${NO_IDENTITY}, so there is nothing to hold the answer to`,
    });
  if (Array.isArray(data)) {
    return Result.match(membersOf(data), {
      onFailure: unidentified,
      onSuccess: (members) =>
        Claim.ToMany({ members, paged: Link.$is("Href")(linkIn(relationship["links"], "next")) }),
    });
  }
  return isRecord(data)
    ? Option.match(memberOf(data), {
        onNone: () => unidentified(1),
        onSome: (member) => Claim.ToOne({ member }),
      })
    : Claim.Unidentified({
        why: "— its linkage is neither `null`, a resource identifier nor an array of them, so there is nothing to hold the answer to",
      });
};

/** A document's resource objects, each named and with where it sits. */
// oxlint-disable-next-line effect/no-unknown-parameters -- reads whatever JSON a server answered; it has no schema to parse it by
const carriersIn = (body: unknown) =>
  Arr.map(resourcesOf(body), ({ pointer, resource }) => ({
    pointer,
    resource,
    label: quote(resourceLabel(resource)),
  }));

/** Every resource object's `self` link in a document. */
// oxlint-disable-next-line effect/no-unknown-parameters -- reads whatever JSON a server answered; it has no schema to parse it by
const selfLinks = (from: Target, body: unknown): ReadonlyArray<Found> =>
  Arr.map(carriersIn(body), ({ pointer, resource, label }) => ({
    where: `the \`self\` link of ${label} (in ${from.url}, at ${pointer})`,
    of: label,
    name: "self" as const,
    link: linkIn(resource["links"], "self"),
    from,
    claim: Option.match(memberOf(resource), {
      onNone: () =>
        Claim.Unidentified({
          why: "— the resource carrying it has no string `type` and `id` to hold the answer to",
        }),
      onSome: (member) => Claim.Resource({ member }),
    }),
  }));

/**
 * Every relationship's `related` link in a document, with what it claims.
 * `claim` sees only relationships that carry linkage (a `data` member) when
 * `linked` is set; otherwise every relationship, each claiming resource data.
 */
const relatedLinks =
  (linked: boolean) =>
  // oxlint-disable-next-line effect/no-unknown-parameters -- reads whatever JSON a server answered; it has no schema to parse it by
  (from: Target, body: unknown): ReadonlyArray<Found> =>
    Arr.flatMap(carriersIn(body), ({ pointer, resource, label }) => {
      const relationships = resource["relationships"];
      if (!isRecord(relationships)) return [];
      return Arr.filterMap(Rec.keys(relationships), (name) => {
        const relationship = relationships[name];
        if (!isRecord(relationship) || (linked && !("data" in relationship))) {
          return Result.fail(undefined);
        }
        const of = `${label}'s \`${quote(name)}\``;
        return Result.succeed({
          where: `the \`related\` link of ${of} (in ${from.url}, at ${pointer})`,
          of,
          name: "related" as const,
          link: linkIn(relationship["links"], "related"),
          from,
          claim: linked ? claimOf(relationship) : Claim.ResourceData(),
        });
      });
    });

// ---------------------------------------------------------------------------
// Following one link
// ---------------------------------------------------------------------------

/** What following one link showed: nothing wrong, a finding, or no verdict and why. */
type Verdict =
  | { readonly _tag: "Held" }
  | { readonly _tag: "Broken"; readonly finding: Finding }
  | { readonly _tag: "Undecided"; readonly why: string }
  | { readonly _tag: "Spent" };
const Verdict = Data.taggedEnum<Verdict>();

/**
 * How one rule judges what it found: the rule, and — for a rule that only
 * compares what a link answers — the rule that holds the link to answering at
 * all, which a broken link, a non-2xx or an answer that is not resource data is
 * left to rather than reported twice.
 */
interface Judging {
  readonly rule: Rule;
  readonly defersTo: Option.Option<string>;
}

/** A response's primary data as a finding names it. */
const primaryOf = (observation: Observation): string => {
  const body = observation.body;
  if (!isRecord(body) || !("data" in body)) return describe(observation);
  const data = body["data"];
  if (isRecord(data)) return quote(resourceLabel(data));
  return `\`data: ${quote(data)}\``;
};

/** The answer's primary data, `undefined` when it has none. */
// oxlint-disable-next-line effect/no-unknown-returns -- the server's primary data as it came, with no schema to parse it by: judging it is the point
const dataOf = (observation: Observation): unknown =>
  isRecord(observation.body) ? observation.body["data"] : undefined;

/** `true` when an answer's primary data is resource data: a resource object, an array of them, or `null`. */
const isResourceData = (observation: Observation): boolean => {
  const data = dataOf(observation);
  return data === null || isRecord(data) || (Array.isArray(data) && data.every(isRecord));
};

/** `true` when the related collection a response answers carries a `next` link: it is one page. */
const pagedAnswer = (observation: Observation): boolean =>
  isRecord(observation.body) && Link.$is("Href")(linkIn(observation.body["links"], "next"));

/** The labels of `members` whose identity `keys` lacks. */
const outside = (members: ReadonlyArray<Member>, keys: HashSet.HashSet<string>) =>
  Arr.dedupe(members.filter(({ key }) => !HashSet.has(keys, key)).map(({ label }) => label));

const keysOf = (members: ReadonlyArray<Member>): HashSet.HashSet<string> =>
  HashSet.fromIterable(members.map(({ key }) => key));

/** A finding against the link `found`, decided by `observation`. */
const broken = (
  rule: Rule,
  found: Found,
  observation: Option.Option<Observation>,
  args: { readonly detail: string; readonly expected: string; readonly observed: string },
): Verdict =>
  Verdict.Broken({
    finding: finding(rule, {
      detail: `${found.where} ${args.detail}`,
      expected: args.expected,
      observed: args.observed,
      probe: Option.getOrUndefined(Option.map(observation, ({ probe }) => probe)),
    }),
  });

/**
 * A finding the judging rule reports itself, or — when it defers — the link
 * left not decided, naming the rule that reports it.
 */
const brokenOrDeferred = (
  judging: Judging,
  found: Found,
  observation: Option.Option<Observation>,
  args: { readonly detail: string; readonly expected: string; readonly observed: string },
): Verdict =>
  Option.match(judging.defersTo, {
    onNone: () => broken(judging.rule, found, observation, args),
    onSome: (rule) =>
      Verdict.Undecided({
        why: `${found.where} ${args.detail}, which \`${rule}\` reports — there is no answer to compare with its linkage`,
      }),
  });

/** A to-many claim held against a 2xx answer of resource data. */
const judgeMany = (
  rule: Rule,
  found: Found,
  observation: Observation,
  claim: { readonly members: ReadonlyArray<Member>; readonly paged: boolean },
): Verdict => {
  const data = dataOf(observation);
  const expected = `the resources its linkage names, ${Arr.match(claim.members, {
    onEmpty: () => "none",
    onNonEmpty: (members) => listed(members.map(({ label }) => label)),
  })}`;
  if (!Array.isArray(data)) {
    return broken(rule, found, Option.some(observation), {
      detail: "answers no resource collection as primary data",
      expected,
      observed: primaryOf(observation),
    });
  }
  return Result.match(membersOf(data), {
    onFailure: (count) =>
      Verdict.Undecided({
        why: `${found.where} answers ${counted(count, "item")} the kit cannot identify (${NO_IDENTITY})`,
      }),
    onSuccess: (answered) => {
      const page = pagedAnswer(observation);
      if (page && claim.paged) {
        return Verdict.Undecided({
          why: `${found.where} — both its linkage and the collection it answers are pages, so neither can be held against the other`,
        });
      }
      // A page of the related collection need not list all the linkage
      // names; a page of linkage need not name all the collection lists.
      const missing = page ? [] : outside(claim.members, keysOf(answered));
      const extra = claim.paged ? [] : outside(answered, keysOf(claim.members));
      if (Arr.isReadonlyArrayNonEmpty(missing)) {
        return broken(rule, found, Option.some(observation), {
          detail: `answers without ${counted(missing.length, "resource")} its linkage names`,
          expected,
          observed: `missing: ${listed(missing)}`,
        });
      }
      return Arr.isReadonlyArrayNonEmpty(extra)
        ? broken(rule, found, Option.some(observation), {
            detail: `answers ${counted(extra.length, "resource")} its linkage does not name`,
            expected,
            observed: `not in the linkage: ${listed(extra)}`,
          })
        : Verdict.Held();
    },
  });
};

/** A 2xx answer held against what the link claims. */
const judgeAnswer = (judging: Judging, found: Found, observation: Observation): Verdict => {
  const { rule } = judging;
  const data = dataOf(observation);
  const one = (member: Member, detail: string): Verdict =>
    isRecord(data) && identity(data) === member.key
      ? Verdict.Held()
      : broken(rule, found, Option.some(observation), {
          detail,
          expected: `${member.label} as primary data`,
          observed: primaryOf(observation),
        });
  const resourceData = isResourceData(observation);
  if (!resourceData && !Claim.$is("Resource")(found.claim)) {
    return brokenOrDeferred(judging, found, Option.some(observation), {
      detail: "answers no related resource data as primary data",
      expected: "a resource object, an array of them or `null` as primary data",
      observed: describe(observation),
    });
  }
  return Claim.$match(found.claim, {
    Resource: ({ member }) => one(member, "answers a different resource as primary data"),
    ResourceData: () => Verdict.Held(),
    ToOne: ({ member }) =>
      one(member, "answers a different resource from the one its linkage names"),
    Empty: () =>
      data === null
        ? Verdict.Held()
        : broken(rule, found, Option.some(observation), {
            detail: "answers a resource where its linkage is `null`",
            expected: "`null` as primary data",
            observed: primaryOf(observation),
          }),
    ToMany: (claim) => judgeMany(rule, found, observation, claim),
    // Never reached: `resolve` decides an unidentified claim before any request.
    Unidentified: ({ why }) => Verdict.Undecided({ why: `${found.where} ${why}` }),
  });
};

/** The answer to a followed link held against what it claims. */
const judge = (judging: Judging, found: Found, observation: Observation): Verdict => {
  if (unanswered(observation)) {
    return Verdict.Undecided({
      why: `${found.where} got ${statusOf(observation)} — ${SAYS_NOTHING}`,
    });
  }
  if (observation.status === 401 || observation.status === 403) {
    return Verdict.Undecided({
      why: `${found.where} answered ${observation.status} — access control is outside JSON:API, so a link the kit may not follow is not a broken one`,
    });
  }
  if (!succeeded(observation)) {
    // The run just received this link from the server, so a 404 for it is the
    // server contradicting itself, not a resource that is legitimately gone.
    return brokenOrDeferred(judging, found, Option.some(observation), {
      detail: `answered ${observation.status}`,
      expected: Claim.$match(found.claim, {
        Resource: ({ member }) => `a 2xx response with ${member.label} as primary data`,
        ToOne: ({ member }) => `a 2xx response with ${member.label} as primary data`,
        Empty: () => "a 2xx response with `null` as primary data",
        ToMany: () => "a 2xx response with the related resources as primary data",
        ResourceData: () => "a 2xx response with the related resource data as primary data",
        Unidentified: () => "a 2xx response",
      }),
      observed: describe(observation),
    });
  }
  return judgeAnswer(judging, found, observation);
};

/** Follows one link and judges it, or says why it was not followed. */
const follow = (judging: Judging, io: Io, found: Found, to: Target): Effect.Effect<Verdict> =>
  Effect.map(io.fetch(to), (answer) =>
    Option.match(answer, {
      onNone: () => Verdict.Spent(),
      onSome: (observation) => judge(judging, found, observation),
    }),
  );

/**
 * Where a found link leads, or — when it is no link the kit can follow, makes
 * a claim the kit cannot hold an answer to, or leads off the run's origin —
 * the verdict on it, reached without a request.
 */
const resolve = (
  judging: Judging,
  found: Found,
  baseUrl: string,
): Result.Result<Target, Verdict> => {
  // oxlint-disable-next-line effect/no-unknown-parameters -- quotes whatever JSON a server put where a link belongs
  const notALink = (value: unknown): Verdict =>
    brokenOrDeferred(judging, found, Option.none(), {
      detail: "is not a link the kit can follow",
      expected: "a URI-reference, a link object with an `href`, or `null`",
      observed: `${found.name}: ${quote(value)}`,
    });
  if (Link.$is("Malformed")(found.link)) return Result.fail(notALink(found.link.value));
  // Never reached: `available` drops an absent or `null` link before the crawl.
  if (!Link.$is("Href")(found.link)) return Result.fail(Verdict.Held());
  if (Claim.$is("Unidentified")(found.claim)) {
    return Result.fail(Verdict.Undecided({ why: `${found.where} ${found.claim.why}` }));
  }
  const step = stepTo(found.link.href, found.from, baseUrl);
  return Step.$match(step, {
    Follow: ({ target }) => Result.succeed(target),
    Unparseable: ({ href }) => Result.fail(notALink(href)),
    Offsite: ({ to }) =>
      Result.fail(
        Verdict.Undecided({
          why: `${found.where} leads to ${to}, which the kit does not follow`,
        }),
      ),
  });
};

// ---------------------------------------------------------------------------
// The crawl
// ---------------------------------------------------------------------------

/** One read endpoint the links were collected from, and how it answered. */
interface Source {
  readonly url: string;
  readonly observation: Option.Option<Observation>;
  readonly target: Option.Option<Target>;
}

/**
 * Fetches every read endpoint whose URL resolves, under the rule's budget: a
 * source the budget leaves no request for comes back with no observation.
 */
const sources = (io: Io, ctx: Context, paths: ReadonlyArray<string>) =>
  Effect.forEach(
    paths,
    (path) => {
      const target = own(path, ctx.options.baseUrl);
      return Option.match(target, {
        onNone: () => Effect.succeed<Source>({ url: path, observation: Option.none(), target }),
        onSome: (resolved) =>
          Effect.map(io.fetch(resolved), (observation): Source => ({
            url: path,
            observation,
            target,
          })),
      });
    },
    { concurrency: 1 },
  );

/** `true` when a source's URL resolved but the budget left no request for it. */
const unsearched = ({ observation, target }: Source): boolean =>
  Option.isSome(target) && Option.isNone(observation);

/** A source as a skip reason names it: its URL, and its status when it did not answer 2xx. */
const searched = ({ url, observation }: Source): string =>
  Option.match(observation, {
    onNone: () => `${url}: not requested`,
    onSome: (answer) => (succeeded(answer) ? url : `${url}: ${statusOf(answer)}`),
  });

/** Everything one rule's crawl showed. */
interface Crawl {
  /** The first {@link FINDING_LIMIT} findings. */
  readonly findings: ReadonlyArray<Finding>;
  /** Findings past {@link FINDING_LIMIT}, counted rather than listed. */
  readonly unlisted: number;
  /** Links decided either way: held, or broken. */
  readonly decided: number;
  /** Links a request was answered for (or the run had already fetched). */
  readonly followed: number;
  readonly undecided: ReadonlyArray<string>;
  /** Links the budget left unfollowed, out of how many the crawl found. */
  readonly unfollowed: number;
  readonly total: number;
}

/**
 * Follows each found link once — a link the run has already fetched costs no
 * request — stopping at the budget: every link after the one it ran out on
 * is left unfollowed.
 */
const crawl = (
  judging: Judging,
  io: Io,
  baseUrl: string,
  found: ReadonlyArray<Found>,
): Effect.Effect<Crawl> =>
  Effect.reduce(
    found,
    (): Crawl => ({
      findings: [],
      unlisted: 0,
      decided: 0,
      followed: 0,
      undecided: [],
      unfollowed: 0,
      total: found.length,
    }),
    (state, link) => {
      if (state.unfollowed > 0)
        return Effect.succeed({ ...state, unfollowed: state.unfollowed + 1 });
      return Result.match(resolve(judging, link, baseUrl), {
        onFailure: (verdict) => Effect.succeed(tally(state, verdict)),
        onSuccess: (target) =>
          Effect.map(follow(judging, io, link, target), (verdict) =>
            Verdict.$is("Spent")(verdict)
              ? tally(state, verdict)
              : tally({ ...state, followed: state.followed + 1 }, verdict),
          ),
      });
    },
  );

/** A crawl with one more link's verdict counted. */
const tally = (state: Crawl, verdict: Verdict): Crawl =>
  Verdict.$match(verdict, {
    Held: () => ({ ...state, decided: state.decided + 1 }),
    Broken: ({ finding: broke }) =>
      state.findings.length < FINDING_LIMIT
        ? { ...state, findings: [...state.findings, broke], decided: state.decided + 1 }
        : { ...state, unlisted: state.unlisted + 1, decided: state.decided + 1 },
    Undecided: ({ why }) => ({ ...state, undecided: [...state.undecided, why] }),
    Spent: () => ({ ...state, unfollowed: 1 }),
  });

/** What a link claims, as the string two finds of the same link share. */
const claimKey = (claim: Claim): string =>
  Claim.$match(claim, {
    Resource: ({ member }) => `resource ${member.key}`,
    ResourceData: () => "data",
    ToOne: ({ member }) => `one ${member.key}`,
    Empty: () => "empty",
    ToMany: ({ members, paged }) => `many ${paged} ${members.map(({ key }) => key).join(" ")}`,
    Unidentified: ({ why }) => `unidentified ${why}`,
  });

/**
 * Where a link leads, as two finds of it share: an href as it resolves, so
 * `/articles/1` and its absolute spelling are one; anything else by what
 * carries it and what it holds, so the same resource's malformed link in two
 * answers is one.
 */
const destination = (link: Found): string =>
  Link.$match(link.link, {
    Href: ({ href }) =>
      URL.canParse(href, link.from.href)
        ? new URL(href, link.from.href).href
        : `${link.of} ${quote(href)}`,
    Malformed: ({ value }) => `${link.of} ${quote(value)}`,
    Unavailable: () => `${link.of} unavailable`,
  });

/** The same link, claiming the same thing, found again (in another answer, say) is followed once. */
const distinct = (found: ReadonlyArray<Found>): ReadonlyArray<Found> => {
  const seen = MutableHashSet.empty<string>();
  return found.filter((link) => {
    const key = `${link.name} ${destination(link)} ${claimKey(link.claim)}`;
    if (MutableHashSet.has(seen, key)) return false;
    MutableHashSet.add(seen, key);
    return true;
  });
};

/** Joins reasons, the first ten in full and the rest counted. */
const reasons = (whys: ReadonlyArray<string>): string =>
  whys.length > 10
    ? `${whys.slice(0, 10).join("; ")}; and ${whys.length - 10} more`
    : whys.join("; ");

/** The findings a failed rule lists: the first {@link FINDING_LIMIT}, then one counting the rest. */
const listedFindings = (rule: Rule, result: Crawl): ReadonlyArray<Finding> =>
  result.unlisted === 0
    ? result.findings
    : [
        ...result.findings,
        finding(rule, {
          detail: `${counted(result.unlisted, "more link")} broke the rule; only the first ${FINDING_LIMIT} are listed`,
          expected: "every link the rule follows to answer what it claims",
          observed: `${counted(result.unlisted, "further finding")}, not listed`,
          probe: undefined,
        }),
      ];

/**
 * Any finding fails the rule, budget or not. Otherwise a crawl the budget
 * could not finish — a read endpoint it could not search, or a link it could
 * not follow — is not passed; nor is one that decided no link. One that
 * decided some links passes, noting each it could not decide.
 */
const outcomeOf = (
  rule: Rule,
  result: Crawl,
  fetched: ReadonlyArray<Source>,
  probes: number,
  none: string,
  unresolved: ReadonlyArray<string>,
): Outcome => {
  if (Arr.isReadonlyArrayNonEmpty(result.findings)) {
    return settle(rule, probes, listedFindings(rule, result));
  }
  const left = fetched.filter(unsearched).length;
  if (left > 0) {
    return skip(
      rule,
      `the rule's budget of ${REQUEST_BUDGET} requests ran out with ${fetched.length - left} of ${counted(fetched.length, "read endpoint")} searched for links — a partial crawl is not passed`,
    );
  }
  if (result.unfollowed > 0) {
    return skip(
      rule,
      `the rule's budget of ${REQUEST_BUDGET} requests ran out with ${result.followed} of ${result.total} links followed — a partial crawl is not passed`,
    );
  }
  if (result.total === 0) return skip(rule, none);
  if (result.decided === 0) {
    return skip(rule, `no link could be followed to a verdict (${reasons(result.undecided)})`);
  }
  const notes = [
    ...(Arr.isReadonlyArrayEmpty(result.undecided)
      ? []
      : [`${counted(result.undecided.length, "link")} not decided: ${reasons(result.undecided)}`]),
    ...Option.toArray(Option.fromUndefinedOr(coverageNote(unresolved))),
  ];
  return pass(rule, probes, Arr.isReadonlyArrayEmpty(notes) ? undefined : notes.join("; "));
};

/** A rule that collects one kind of link from the read endpoints and follows each. */
const dereferencing = (
  judging: Judging,
  what: string,
  collect: (from: Target, body: Observation["body"]) => ReadonlyArray<Found>,
): RuleImpl => ({
  rule: judging.rule,
  run: (ctx) =>
    Effect.gen(function* () {
      const { rule } = judging;
      const { resolved, unresolved } = probeable(ctx, SOURCE_ROLES);
      const io = budgeted(ctx, REQUEST_BUDGET);
      const fetched = yield* sources(
        io,
        ctx,
        resolved.map(({ path }) => path),
      );
      const found = distinct(
        Arr.flatMap(fetched, ({ observation, target }) =>
          Option.match(Option.all([observation, target]), {
            onNone: () => [],
            onSome: ([answer, from]) =>
              succeeded(answer) ? collect(from, answer.body).filter(available) : [],
          }),
        ),
      );
      const none = Arr.isReadonlyArrayEmpty(fetched)
        ? noProbeReason("JSON:API endpoint answering resource objects", unresolved)
        : `no ${what} (searched ${fetched.map(searched).join(", ")})`;
      const result = yield* crawl(judging, io, ctx.options.baseUrl, found);
      return outcomeOf(rule, result, fetched, io.spent(), none, unresolved);
    }),
});

/** A link the document carries at all: absent or `null` is no link to follow. */
const available = ({ link }: Found): boolean => !Link.$is("Unavailable")(link);

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/**
 * A resource object's `self` link, followed: it must answer that resource.
 *
 * @internal
 */
export const resourceSelfDereferences: RuleImpl = dereferencing(
  {
    rule: {
      id: "spec/links/resource-self-dereferences",
      tier: "spec",
      section: "Resource Links",
      reference: `${SPEC}/#document-resource-object-links`,
      level: "MUST",
      requirement:
        "A resource object's `self` link identifies the resource it appears in: a server MUST respond to a `GET` request to it with a response that includes that resource — the same `type` and `id` — as the primary data.",
    },
    defersTo: Option.none(),
  },
  "resource object in what the read endpoints answered carries a `self` link",
  selfLinks,
);

/**
 * A relationship's `related` link, followed: it must answer resource data.
 *
 * @internal
 */
export const relatedDereferences: RuleImpl = dereferencing(
  {
    rule: {
      id: RELATED_DEREFERENCES,
      tier: "spec",
      section: "Fetching Resources",
      reference: `${SPEC}/#fetching-resources`,
      level: "MUST",
      requirement:
        "A server MUST support fetching resource data for every `related` link a relationship provides: a `GET` to it answers 2xx with a resource object, an array of them or `null` as primary data.",
    },
    defersTo: Option.none(),
  },
  "relationship in what the read endpoints answered carries a `related` link",
  relatedLinks(false),
);

/**
 * A relationship's `related` link, followed: it should answer the resources
 * its linkage names.
 *
 * @internal
 */
export const relatedMatchesLinkage: RuleImpl = dereferencing(
  {
    rule: {
      id: "spec/links/related-matches-linkage",
      tier: "spec",
      section: "Related Resource Links",
      reference: `${SPEC}/#document-resource-object-related-resource-links`,
      level: "SHOULD",
      requirement:
        "When a relationship carries both a `related` link and resource linkage, fetching the link SHOULD answer the resources the linkage names: the related resource object(s) are returned as the response's primary data — a page of them when the related collection is paginated, and a superset of a paginated linkage. The kit grades this SHOULD because the specification states it as definition, without a keyword.",
    },
    defersTo: Option.some(RELATED_DEREFERENCES),
  },
  "relationship in what the read endpoints answered carries both a `related` link and resource linkage",
  relatedLinks(true),
);
