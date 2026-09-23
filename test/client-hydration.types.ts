/**
 * Type-level invariants of `Client`'s hydration: `related` is typed by the
 * relationship's cardinality and target, `walk` by the last hop of the path,
 * and a key or path the definition does not declare is refused.
 */
import { Option, Schema } from "effect";
import { Client, Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const assertType = <Expected>(_value: Expected): void => {};

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });
const Credit = Resource.make("credits", {
  attributes: { role: Schema.String },
  relationships: { contributor: Relationship.one(() => Person) },
});
const Book = Resource.make("books", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    authors: Relationship.many(() => Credit),
    publisher: Relationship.optional(() => Person),
  },
});
type Person = typeof Person.Type;
type Credit = typeof Credit.Type;

declare const book: typeof Book.Type;
declare const index: Client.IncludedIndex;

// A to-one relationship resolves to an Option of its target; a to-many to an array.
assertType<Option.Option<Person>>(Client.related(Book, book, "publisher", index));
assertType<ReadonlyArray<Credit>>(Client.related(Book, book, "authors", index));
// @ts-expect-error — `title` is an attribute, not a relationship
Client.related(Book, book, "title", index);

// A path resolves to the last hop's target.
assertType<ReadonlyArray<Person>>(Client.walk(Book, book, "authors.contributor", index));
assertType<ReadonlyArray<Credit>>(Client.walk(Book, book, "authors", index));
// @ts-expect-error — `credits` declares no `publisher`
Client.walk(Book, book, "authors.publisher", index);

// The bound view carries the same typing.
const hydrated = Client.hydrate(Book, { data: book, included: [] });
assertType<Option.Option<Person>>(hydrated.related("publisher"));
assertType<ReadonlyArray<Person>>(hydrated.walk("authors.contributor"));
// @ts-expect-error — not a relationship of `books`
hydrated.related("contributor");

// The document types are the wire form: string links.
declare const doc: Client.ResourceDocument<Person>;
assertType<string | undefined>(doc.data.links?.self as string | undefined);
assertType<ReadonlyArray<Client.IncludedResource> | undefined>(doc.included);
