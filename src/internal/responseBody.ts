/**
 * Reading back a response the router has already encoded.
 *
 * Three middlewares look at the bytes an endpoint produced rather than at the
 * value its handler returned: `Idempotency.layer` records them for replay,
 * `Middleware.CreatedLocationLive` derives a 201's `Location` from the
 * document's `self` link (#236), and `Middleware.SchemaErrorsLive` re-checks
 * full linkage on the document as encoded (#250). All need the same answer to
 * "what text is this body", and all must treat a body they cannot read as
 * "leave it alone".
 */
import * as Formatter from "effect/Formatter";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { isRecord, unlinkedIncluded } from "./linkage.js";

/**
 * The response text of a body whose bytes are already settled — everything the
 * package's own endpoints emit. `undefined` means "this response cannot be
 * reproduced byte for byte" (a stream, a form, a raw value the platform will
 * serialise later).
 */
export const bodyText = (response: HttpServerResponse.HttpServerResponse): string | undefined => {
  const body = response.body;
  return Match.value(body).pipe(
    Match.tag("Empty", () => ""),
    Match.tag("Uint8Array", (body) => new TextDecoder().decode(body.body)),
    Match.tag("Raw", (body) => (Predicate.isString(body.body) ? body.body : undefined)),
    Match.orElse(() => undefined),
  );
};

/** A link member, spelled as a URL string or as a link object. */
const Link = Schema.Union([Schema.String, Schema.Struct({ href: Schema.String })]);

/** Anything carrying `links.self`: a resource object, or the top-level document. */
const SelfLinked = Schema.Struct({ links: Schema.Struct({ self: Link }) });

/** The body text, parsed once; both lookups below read the parsed value. */
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** The created resource's own `data.links.self`. */
const decodeResourceSelf = Schema.decodeUnknownOption(Schema.Struct({ data: SelfLinked }));

/** The document's top-level `links.self`. */
const decodeDocumentSelf = Schema.decodeUnknownOption(SelfLinked);

/** The URL of a link, whichever way it is spelled. */
const href = (link: typeof Link.Type): string => (Predicate.isString(link) ? link : link.href);

// `Location` is a URI-reference (RFC 9110 §10.2.2), and RFC 3986 spells one in
// visible US-ASCII only: no space, no tab, no CR or LF (which the platform
// would throw writing), no byte above 0x7E. A link outside that is not a
// `Location`, so the header is omitted rather than sent malformed.
const URI_REFERENCE = /^[\x21-\x7e]+$/;

/**
 * The `Location` a JSON:API document names for the resource it carries: the
 * primary resource's `data.links.self`, else the document's own `links.self`,
 * copied verbatim. `None` when the text is not JSON, neither link is present
 * as a string or a link object with a string `href`, or the link is not a
 * URI-reference.
 */
const documentLocation = (text: string): Option.Option<string> =>
  Option.flatMap(parseJson(text), (document) =>
    decodeResourceSelf(document).pipe(
      Option.map(({ data }) => data.links.self),
      Option.orElse(() => Option.map(decodeDocumentSelf(document), ({ links }) => links.self)),
      Option.map(href),
      Option.filter((location) => URI_REFERENCE.test(location)),
    ),
  );

/**
 * A 201 with its `Location` derived from its body's `self` link (see
 * {@link documentLocation}). Any other status, a response that already
 * carries `Location`, an unreadable body, and a body naming no usable link
 * all pass through unchanged.
 */
export const withCreatedLocation = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  if (response.status !== 201 || response.headers["location"] !== undefined) return response;
  return Option.fromUndefinedOr(bodyText(response)).pipe(
    Option.flatMap(documentLocation),
    Option.match({
      onNone: () => response,
      onSome: (location) => HttpServerResponse.setHeader(response, "location", location),
    }),
  );
};

// One member of a label: a string as itself, anything else through
// `Formatter.format`, since parsed JSON can put an object with its own
// `toString` member there and `String` would throw on it.
const part = <A>(value: A): string => (Predicate.isString(value) ? value : Formatter.format(value));

// A member as `type:id` (or `type:lid`) for the violation message, as the
// document builders name one.
const label = (member: {
  readonly type?: unknown;
  readonly id?: unknown;
  readonly lid?: unknown;
}): string => `${part(member.type)}:${part(member.id ?? member.lid)}`;

/**
 * The `included` members of a 2xx response's encoded document that its primary
 * data cannot reach through resource linkage (`Linkage.unlinkedIncluded`, the
 * walk the conformance kit's `spec/document/full-linkage` rule makes), as
 * `type:id` labels in document order. Empty for any other status, a body that
 * cannot be read or is not a JSON object, and a document with no `included`.
 *
 * It reads what the wire carries: encoding through the endpoint's schema drops
 * a relationship the resource does not declare, so a member linked only
 * through one is reported here although the builders' check passed it.
 */
export const unlinkedOnWire = (
  response: HttpServerResponse.HttpServerResponse,
): ReadonlyArray<string> => {
  if (response.status < 200 || response.status >= 300) return [];
  const text = bodyText(response);
  // Cheap pre-filter: a document with no `included` member can't violate it,
  // so most responses are never parsed a second time.
  if (text === undefined || !text.includes('"included"')) return [];
  return Option.match(parseJson(text), {
    onNone: () => [],
    onSome: (document) => (isRecord(document) ? unlinkedIncluded(document).map(label) : []),
  });
};
