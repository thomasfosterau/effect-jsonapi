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

/** The created resource's own `data.links.self`. */
const decodeResourceSelf = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ data: SelfLinked })),
);

/** The document's top-level `links.self`. */
const decodeDocumentSelf = Schema.decodeUnknownOption(Schema.fromJsonString(SelfLinked));

/** The URL of a link, whichever way it is spelled. */
const href = (link: typeof Link.Type): string => (Predicate.isString(link) ? link : link.href);

// RFC 9110 §5.5 field-value: visible characters and obs-text, with spaces and
// tabs only inside. Anything else — a CR or LF above all — is not a header
// value, and the platform would throw writing it.
const FIELD_VALUE = /^[\x21-\x7e\x80-\xff](?:[\t\x20-\x7e\x80-\xff]*[\x21-\x7e\x80-\xff])?$/;

/**
 * The `Location` a JSON:API document names for the resource it carries: the
 * primary resource's `data.links.self`, else the document's own `links.self`,
 * copied verbatim. `None` when the text is not JSON, neither link is present
 * as a string or a link object with a string `href`, or the link is not a
 * valid header value.
 */
const documentLocation = (text: string): Option.Option<string> =>
  decodeResourceSelf(text).pipe(
    Option.map(({ data }) => data.links.self),
    Option.orElse(() => Option.map(decodeDocumentSelf(text), ({ links }) => links.self)),
    Option.map(href),
    Option.filter((location) => FIELD_VALUE.test(location)),
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
