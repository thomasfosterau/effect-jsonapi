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
import * as Schema from "effect/Schema";
import { Handlers, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

/** Pins a value to an expected type without using it (`noUnusedLocals`). */
const assertType = <Expected>(_value: Expected): void => {};

// Whether two types are identical, not merely mutually assignable.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

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

// Each assertion pins the `included` member exactly: `Pick` fails to compile
// when the key is absent, and `Equals` tells an optional member from a required
// one and rejects `any`.

// A literal `[]` infers `Included = never`; the member is still declared.
const dataEmpty = Handlers.data(article, { included: [] });
assertType<
  Equals<Pick<typeof dataEmpty, "included">, { readonly included?: ReadonlyArray<never> }>
>(true);
// Negative control: the member is optional, never required.
assertType<Equals<Pick<typeof dataEmpty, "included">, { readonly included: ReadonlyArray<never> }>>(
  false,
);

const collectionEmpty = Handlers.collection([article], { included: [] });
assertType<
  Equals<Pick<typeof collectionEmpty, "included">, { readonly included?: ReadonlyArray<never> }>
>(true);

// No option at all: the member is optional and holds nothing.
const dataBare = Handlers.data(article);
assertType<Equals<Pick<typeof dataBare, "included">, { readonly included?: ReadonlyArray<never> }>>(
  true,
);

// A non-empty `included` keeps its element type.
const dataWithAuthor = Handlers.data(article, { included: [person] });
assertType<
  Equals<
    Pick<typeof dataWithAuthor, "included">,
    { readonly included?: ReadonlyArray<typeof person> }
  >
>(true);
