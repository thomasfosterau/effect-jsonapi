/**
 * Type-level tests for a to-one relationship's storage key (#509):
 * `Relationship.one(ref, { key })` / `optional(ref, { key })` record the key as
 * an `Option` of the literal passed, `Option<never>` (`Option.none()`) when none
 * is declared, and the lowercase annotation types name it as their third
 * parameter, so a mutually-recursive definition can annotate a keyed
 * relationship. The wide descriptor types match keyed and unkeyed alike.
 *
 * Type-checked by `tsconfig.json`; the `@ts-expect-error` annotations are the
 * assertions.
 */
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertTrue = <T extends true>(): T[] => [];

const Person = Resource.make("people", { attributes: { name: Schema.NonEmptyString } });

const keyed = Relationship.one(() => Person, { key: "authorId" });
export const keyedIsLiteral = assertTrue<Equals<typeof keyed.key, Option.Option<"authorId">>>();

const unkeyed = Relationship.optional(() => Person);
export const unkeyedIsNone = assertTrue<Equals<typeof unkeyed.key, Option.Option<never>>>();

// The lowercase annotation names the key as its third parameter…
export const annotated: Relationship.one<typeof Person, false, "authorId"> = keyed;
// …and defaults it to `never` (an `Option<never>` key), as the constructor does.
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
    Equals<
      ReturnType<typeof Resource.relationships<typeof Article>>["editor"]["key"],
      Option.Option<"editorId">
    >
  >();

// The wide matchers still match a keyed and an unkeyed descriptor alike.
type MatchesOne<D> = D extends Relationship.One<Resource.Any> ? true : false;
type MatchesOptional<D> = D extends Relationship.Optional<Resource.Any> ? true : false;
type MatchesToOne<D> = D extends Relationship.ToOne<Resource.Any> ? true : false;
type MatchesDescriptor<D> = D extends Relationship.Descriptor ? true : false;
export const wideOneKeyed = assertTrue<MatchesOne<typeof keyed>>();
export const wideOneUnkeyed =
  assertTrue<MatchesOne<ReturnType<typeof Relationship.one<typeof Person>>>>();
export const wideOptionalKeyed =
  assertTrue<MatchesOptional<(typeof Article.relationships)["editor"]>>();
export const wideOptionalUnkeyed = assertTrue<MatchesOptional<typeof unkeyed>>();
export const wideToOneKeyed = assertTrue<MatchesToOne<typeof keyed>>();
export const wideToOneUnkeyed = assertTrue<MatchesToOne<typeof unkeyed>>();
export const wideDescriptorKeyed = assertTrue<MatchesDescriptor<typeof keyed>>();
export const wideDescriptorUnkeyed = assertTrue<MatchesDescriptor<typeof unkeyed>>();
// Assignability, not only conditional matching: both forms widen to `One<Any>`.
export const wideKeyed: Relationship.One<Resource.Any> = keyed;
export const wideUnkeyed: Relationship.One<Resource.Any> = Relationship.one(() => Person);
// The wide key reads as `Option<string>`.
export const wideKeyIsOption =
  assertTrue<Equals<Relationship.One<Resource.Any>["key"], Option.Option<string>>>();
