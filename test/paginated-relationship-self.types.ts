/**
 * Type-level tests for `Handlers.paginatedRelationship`'s `self` option
 * (issue #381): omitted or a string, the value's `links.self` is a `string`,
 * exactly as before the option existed; `false`, the value has no `self`
 * member; anything else is rejected.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions. Every binding is exported so an
 * unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import { Schema } from "effect";
import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
});
const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString },
  relationships: { articles: Relationship.paginated(() => Article) },
});

// ---------------------------------------------------------------------------
// Default: `links.self` is a required string — existing callers see no change
// ---------------------------------------------------------------------------

const byDefault = Handlers.paginatedRelationship("people", "9", "articles");
const defaultSelf: string = byDefault.links.self;
const explicitUndefined = Handlers.paginatedRelationship("people", "9", "articles", {
  self: undefined,
});
const explicitUndefinedSelf: string = explicitUndefined.links.self;

// ---------------------------------------------------------------------------
// A custom path: `links.self` is still a required string
// ---------------------------------------------------------------------------

const custom = Handlers.paginatedRelationship("people", "9", "articles", { self: "/custom" });
const customSelf: string = custom.links.self;

// ---------------------------------------------------------------------------
// `self: false`: no `self` member
// ---------------------------------------------------------------------------

const optedOut = Handlers.paginatedRelationship("people", "9", "articles", { self: false });
// @ts-expect-error -- `self: false` leaves `self` out of the value's `links`
const optedOutSelf: string = optedOut.links.self;
const optedOutRelated: string = optedOut.links.related;

// A `self` only known at runtime gives the union of both shapes.
const maybe = (declared: boolean): string | false => (declared ? "/custom" : false);
const either = Handlers.paginatedRelationship("people", "9", "articles", { self: maybe(true) });
// @ts-expect-error -- the value might carry no `self`
const eitherSelf: string = either.links.self;
const eitherRelated: string = either.links.related;

// ---------------------------------------------------------------------------
// Only a string, `false` or `undefined` is accepted
// ---------------------------------------------------------------------------

// @ts-expect-error -- `true` is not an option: omit `self` for the default link
const selfTrue = Handlers.paginatedRelationship("people", "9", "articles", { self: true });
// @ts-expect-error -- `self` is a path string, not a number
const selfNumber = Handlers.paginatedRelationship("people", "9", "articles", { self: 1 });

// ---------------------------------------------------------------------------
// Every shape is a valid paginated relationship object
// ---------------------------------------------------------------------------

const id = Person.Id.make("9");
const people = [byDefault, custom, optedOut, either].map((articles) =>
  Person.make({ id, attributes: { name: "Dan" }, relationships: { articles } }),
);

export {
  byDefault,
  customSelf,
  defaultSelf,
  either,
  eitherRelated,
  eitherSelf,
  explicitUndefinedSelf,
  optedOutRelated,
  optedOutSelf,
  people,
  selfNumber,
  selfTrue,
};
