/**
 * Type-level tests for a to-one relationship's storage key (#509):
 * `Relationship.one(ref, { key })` / `optional(ref, { key })` record the key as
 * the literal passed, `undefined` when none is declared, and the lowercase
 * annotation types name it as their third parameter, so a mutually-recursive
 * definition can annotate a keyed relationship.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T | undefined => undefined;

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });

const keyed = Relationship.one(() => Person, { key: "authorId" });
export const keyedIsLiteral = assertTrue<Equals<typeof keyed.key, "authorId">>();

const unkeyed = Relationship.optional(() => Person);
export const unkeyedIsUndefined = assertTrue<Equals<typeof unkeyed.key, undefined>>();

// The lowercase annotation names the key as its third parameter…
export const annotated: Relationship.one<typeof Person, false, "authorId"> = keyed;
// …and defaults it to `undefined`, as the constructor does.
// @ts-expect-error a keyed relationship is not the unkeyed annotation
export const misannotated: Relationship.one<typeof Person> = keyed;

// @ts-expect-error a storage key is a string
export const numericKey = Relationship.one(() => Person, { key: 1 });

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Person, { key: "authorId" }),
    editor: Relationship.optional(() => Person, { key: "editorId", filter: ["eq", "isnull"] }),
  },
});
export const readThrough =
  assertTrue<
    Equals<ReturnType<typeof Resource.relationships<typeof Article>>["editor"]["key"], "editorId">
  >();
