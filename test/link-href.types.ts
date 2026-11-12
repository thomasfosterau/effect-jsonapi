/**
 * Type-level tests for `Document.href`: the acceptance test for issue #110 —
 * a consumer must be able to get a wire string out of a built document
 * without re-declaring the resource's schema.
 *
 * A resource's decoded `links` stay `string | URL | LinkObject` (the
 * permissive default `Document.Link` union is unchanged — see
 * `Document.Url`'s own doc comment for why: JSON:API links are
 * URI-*references*, so a relative one cannot become a real `URL`). `href`
 * narrows that union to the wire string by inspection, so no resource
 * redeclaration is needed to read a link as a string.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every binding is exported so an
 * unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Document, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
});

declare const article: typeof Article.Type;

// ---------------------------------------------------------------------------
// The pain `href` fixes: a resource's own link member is a 3-way union
// ---------------------------------------------------------------------------

// Negative control: without `href`, the raw decoded member is *not* already a
// plain string — a consumer touching it directly must narrow it themselves.
// @ts-expect-error -- `article.links?.self` is `string | URL | LinkObject` when present, not `string`
const rawSelf: Option.Option<string> = Option.fromUndefinedOr(article.links?.self);

// ---------------------------------------------------------------------------
// The fix: `Document.href` gets a wire string without redeclaring `Article`
// ---------------------------------------------------------------------------

const self: Option.Option<string> = Option.map(
  Option.fromUndefinedOr(article.links?.self),
  Document.href,
);

// `href` genuinely narrows to `string` — it never leaves the result as a `URL`.
// @ts-expect-error -- `Document.href` returns `string`, never `URL`
const selfAsUrl: Option.Option<URL> = Option.map(
  Option.fromUndefinedOr(article.links?.self),
  Document.href,
);

// A present link narrows to a bare `string`.
declare const presentLink: Document.Link;
const presentHref: string = Document.href(presentLink);
// @ts-expect-error -- a definite `Link` never yields `undefined`
const presentHrefWiden: undefined = Document.href(presentLink);

// An absent link is not a `Link`: it goes through `Option` instead.
// @ts-expect-error -- `href` no longer accepts `undefined`
Document.href(article.links?.self);

// `href` only accepts what a `Link` can be — not arbitrary input.
// @ts-expect-error -- `42` is not a `Link`
Document.href(42);

export { presentHref, presentHrefWiden, rawSelf, self, selfAsUrl };
