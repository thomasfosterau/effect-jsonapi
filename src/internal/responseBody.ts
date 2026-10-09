/**
 * Reading back a response the router has already encoded.
 *
 * Two middlewares look at the bytes an endpoint produced rather than at the
 * value its handler returned: `Idempotency.layer` records them for replay, and
 * `Middleware.CreatedLocationLive` derives a 201's `Location` from the
 * document's `self` link (#236). Both need the same answer to "what text is
 * this body", and both must treat a body they cannot read as "leave it alone".
 */
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

/**
 * The response text of a body whose bytes are already settled — everything the
 * package's own endpoints emit. `undefined` means "this response cannot be
 * reproduced byte for byte" (a stream, a form, a raw value the platform will
 * serialise later).
 */
export const bodyText = (response: HttpServerResponse.HttpServerResponse): string | undefined => {
  const body = response.body;
  switch (body._tag) {
    case "Empty":
      return "";
    case "Uint8Array":
      return new TextDecoder().decode(body.body);
    case "Raw":
      return Predicate.isString(body.body) ? body.body : undefined;
    default:
      return undefined;
  }
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
