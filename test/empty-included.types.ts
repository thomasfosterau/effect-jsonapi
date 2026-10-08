/**
 * Type-level tests for the `included` member of the `Handlers` document
 * builders' return type (#232).
 *
 * `Handlers.data(r, { included: [] })` emits `included: []` on the wire, so the
 * return type must let a caller read `.included` back, even though a literal
 * `[]` infers the member type `never`. The member is optional in every
 * `DocumentValue`: `undefined` (or no option at all) omits it.
 *
 * This file is type-checked by the `typecheck` task and never executed.
 */
import { Schema } from "effect";
import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const person = Person.make({ id: Person.Id.make("9"), attributes: { name: "Dan" } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});
const article = Article.make({
  id: Article.Id.make("1"),
  attributes: { title: "Hi" },
  relationships: { author: { data: { type: "people", id: person.id } } },
});

// A literal `[]` infers `Included = never`; the member still reads back.
export const dataEmpty = Handlers.data(article, { included: [] });
export const dataEmptyIncluded: ReadonlyArray<unknown> | undefined = dataEmpty.included;

export const collectionEmpty = Handlers.collection([article], { included: [] });
export const collectionEmptyIncluded: ReadonlyArray<unknown> | undefined = collectionEmpty.included;

// No option at all: the member is optional and holds nothing.
export const dataBare = Handlers.data(article);
export const dataBareIncluded: ReadonlyArray<never> | undefined = dataBare.included;

// Negative control: the member is optional, never required.
// @ts-expect-error -- `included` may be absent, so it is not a plain array
export const dataEmptyRequired: ReadonlyArray<unknown> = dataEmpty.included;

// A non-empty `included` keeps its element type.
export const dataWithAuthor = Handlers.data(article, { included: [person] });
export const dataWithAuthorIncluded: ReadonlyArray<typeof person> | undefined =
  dataWithAuthor.included;
