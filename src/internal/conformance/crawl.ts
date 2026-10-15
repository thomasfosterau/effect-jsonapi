/**
 * The plumbing the rules that follow a server's own links share: reading a
 * link off a document, resolving it against the document that carries it,
 * refusing one that leads to another origin, quoting a server value safely,
 * telling a response that says nothing from one that does, and a budgeted,
 * caching transport.
 *
 * Shared by the pagination walk (`./pagination.ts`) and the link
 * dereferencing rules (`./links.ts`), so the two cannot drift apart on what
 * the kit will request on a server's say-so.
 *
 * @since 0.17.0
 * @internal
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Formatter from "effect/Formatter";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { type Context, isRecord, jsonApiAccept, type Observation } from "./core.js";

// ---------------------------------------------------------------------------
// Quoting server values
// ---------------------------------------------------------------------------

/** The longest server value a finding quotes, in UTF-16 code units. */
const QUOTE_LIMIT = 200;

/** The most items a finding lists by name. */
const LIST_LIMIT = 10;

/**
 * A server value as a finding quotes it: a string as itself, anything else
 * through `Formatter.format` (a JSON value can be `{"toString":1}`, which
 * `String` throws on), cut to {@link QUOTE_LIMIT}.
 *
 * @internal
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- quotes whatever JSON a server put where a link belongs; it has no schema to parse it by
export const quote = (value: unknown): string => {
  const text = Predicate.isString(value) ? value : Formatter.format(value);
  if (text.length <= QUOTE_LIMIT) return text;
  // Never split a surrogate pair: a high surrogate the cut would leave last goes too.
  const end = QUOTE_LIMIT - 1;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
};

/**
 * Labels as one line, the first {@link LIST_LIMIT} by name and the rest counted.
 *
 * @internal
 */
export const listed = (labels: ReadonlyArray<string>): string =>
  labels.length > LIST_LIMIT
    ? `${labels.slice(0, LIST_LIMIT).join(", ")} and ${labels.length - LIST_LIMIT} more`
    : labels.join(", ");

// ---------------------------------------------------------------------------
// Links and where they lead
// ---------------------------------------------------------------------------

/**
 * A URL the kit can request: as sent, and as the absolute href it compares on.
 *
 * @internal
 */
export interface Target {
  readonly url: string;
  readonly href: string;
}

/**
 * A link as a document carries it: absent or `null`, a URI-reference (a string,
 * or a link object's `href`), or something that is not a link at all.
 *
 * @internal
 */
export type Link =
  | { readonly _tag: "Unavailable" }
  | { readonly _tag: "Href"; readonly href: string }
  | { readonly _tag: "Malformed"; readonly value: unknown };

/** @internal */
export const Link = Data.taggedEnum<Link>();

/**
 * The member `name` of a links object, as a {@link Link}: JSON:API 1.1
 * §Links — "a link **MUST** be represented as either: a string whose value is a
 * URI-reference …, a link object or `null` if the link does not exist".
 *
 * @internal
 */
// oxlint-disable-next-line effect/no-unknown-parameters -- reads whatever JSON a server put where a links object belongs; it has no schema to parse it by
export const linkIn = (links: unknown, name: string): Link => {
  const value = isRecord(links) ? links[name] : undefined;
  if (Predicate.isNullish(value)) return Link.Unavailable();
  if (Predicate.isString(value)) return Link.Href({ href: value });
  const href = isRecord(value) ? value["href"] : undefined;
  return Predicate.isString(href) ? Link.Href({ href }) : Link.Malformed({ value });
};

/**
 * Where a link leads, or why the kit does not follow it.
 *
 * @internal
 */
export type Step =
  | { readonly _tag: "Follow"; readonly target: Target }
  | { readonly _tag: "Unparseable"; readonly href: string }
  | {
      readonly _tag: "Offsite";
      /** Where it leads, as a finding names it: "another origin, https://…", or a URL with no origin. */
      readonly to: string;
    };

/** @internal */
export const Step = Data.taggedEnum<Step>();

/**
 * The URL a run sends for an absolute href: relative to the run's base URL
 * when it lies under it, so the report reads as the other rules' do, and
 * absolute otherwise.
 */
const targetOf = (href: string, baseUrl: string): Target => {
  const base = baseUrl.replace(/\/$/, "");
  return { url: href.startsWith(`${base}/`) ? href.slice(base.length) : href, href };
};

/**
 * A URL a rule built — an endpoint's path, with or without a query — as a
 * target, or none when it does not parse.
 *
 * @internal
 */
export const own = (url: string, baseUrl: string): Option.Option<Target> => {
  const absolute = url.startsWith("http") ? url : `${baseUrl.replace(/\/$/, "")}${url}`;
  return URL.canParse(absolute)
    ? Option.some({ url, href: new URL(absolute).href })
    : Option.none();
};

/**
 * Where a URL off the run's origin leads, as a finding names it. A URL whose
 * scheme gives it no origin of its own (`javascript:`, `data:`, `mailto:`)
 * serialises its origin as `"null"`, which names nothing, so it is named by
 * its scheme instead.
 */
const offsite = (url: URL): string =>
  url.origin === "null"
    ? `a \`${quote(url.protocol)}\` URL (no origin)`
    : `another origin, ${quote(url.origin)}`;

/**
 * Where a link found on `from` leads. A link is resolved against the document
 * it was found on, as a browser would; one that leads off the run's origin is
 * not followed, so a server cannot point the kit at another host.
 *
 * @internal
 */
export const stepTo = (href: string, from: Target, baseUrl: string): Step => {
  if (!URL.canParse(href, from.href)) return Step.Unparseable({ href });
  const resolved = new URL(href, from.href);
  const origin = new URL(URL.canParse(baseUrl) ? baseUrl : from.href).origin;
  return resolved.origin === origin
    ? Step.Follow({ target: targetOf(resolved.href, baseUrl) })
    : Step.Offsite({ to: offsite(resolved) });
};

/**
 * The URL that answered a request for `target`: the target itself, or the
 * last redirect the kit followed to reach the answer. Its `url` stays the one
 * requested, as findings name it; its `href` is where the answer came from, so
 * a relative link in it resolves as a browser would resolve it.
 *
 * @internal
 */
export const answeredFrom = (target: Target, observation: Observation): Target =>
  Option.match(Option.fromUndefinedOr(observation.redirects.at(-1)), {
    onNone: () => target,
    onSome: (href) => ({ url: target.url, href }),
  });

// ---------------------------------------------------------------------------
// Responses that say nothing
// ---------------------------------------------------------------------------

/**
 * `true` when a response says nothing of the links: no response at all, a
 * rate limit (`429`), a request timeout (`408`, RFC 9110 §15.5.9: the server
 * "did not receive a complete request message within the time that it was
 * prepared to wait") or a server error. The kit does not decide on one.
 *
 * @internal
 */
export const unanswered = (observation: Observation): boolean =>
  observation.transportError !== undefined ||
  observation.status === 408 ||
  observation.status === 429 ||
  observation.status >= 500;

/**
 * Why an {@link unanswered} response decides nothing.
 *
 * @internal
 */
export const SAYS_NOTHING =
  "a server error, a rate limit, a request timeout or a lost response says nothing of the links";

// ---------------------------------------------------------------------------
// The budgeted transport
// ---------------------------------------------------------------------------

/**
 * A rule's requests, under its request budget, with each answer remembered
 * by href so a link to a URL the rule already fetched costs nothing. Each
 * redirect the kit follows (`Observation.redirects`) costs a request too.
 * `fetch` answers `None` once the budget is spent, or when it runs out partway
 * through a chain of redirects. Every request is a `GET` asking
 * for the JSON:API media type.
 *
 * @internal
 */
export interface Io {
  readonly fetch: (target: Target) => Effect.Effect<Option.Option<Observation>>;
  /** As `fetch`, but always asks the server again. */
  readonly refetch: (target: Target) => Effect.Effect<Option.Option<Observation>>;
  readonly spent: () => number;
}

/**
 * A fresh {@link Io} over the run's transport, allowed `budget` requests.
 *
 * @internal
 */
export const budgeted = (ctx: Context, budget: number): Io => {
  let spent = 0;
  const answers = MutableHashMap.empty<string, Observation>();
  const refetch = (target: Target): Effect.Effect<Option.Option<Observation>> =>
    Effect.suspend(() => {
      if (spent >= budget) return Effect.succeed(Option.none());
      return ctx
        .request({ url: target.url, headers: jsonApiAccept, requests: budget - spent })
        .pipe(
          Effect.map((observation) => {
            // Each redirect followed is a request of its own.
            spent += 1 + observation.redirects.length;
            if (Option.exists(observation.unfollowed, ({ reason }) => reason === "budget")) {
              return Option.none();
            }
            MutableHashMap.set(answers, target.href, observation);
            return Option.some(observation);
          }),
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

/**
 * `n thing(s)`, for a finding or a note.
 *
 * @internal
 */
export const counted = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;
