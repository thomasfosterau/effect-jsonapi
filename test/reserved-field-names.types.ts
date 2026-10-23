/**
 * Type-level tests for JSON:API 1.1 §Fields (#503): a resource's attributes
 * and relationships share one namespace with each other and with `type` and
 * `id`, so `Resource.make` and `Resource.extend` reject a field named `type` or
 * `id`, and a name declared as both an attribute and a relationship.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with a negative control that
 * compiles. The rejected definitions are thunks, so nothing here is built (the
 * runtime half, the throw, is asserted in `src/Resource.test.ts`). Every binding
 * is exported so an unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import { Schema } from "effect";
import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";

const Person = Resource.make("people", { attributes: { name: Schema.String } });

// ---------------------------------------------------------------------------
// `make`: reserved names
// ---------------------------------------------------------------------------

export const attributeNamedType = () =>
  Resource.make("things", {
    // @ts-expect-error — an attribute named `type`
    attributes: { type: Schema.String },
  });

export const attributeNamedId = () =>
  Resource.make("things", {
    // @ts-expect-error — an attribute named `id`
    attributes: { id: Schema.String, name: Schema.String },
  });

export const relationshipNamedType = () =>
  Resource.make("things", {
    attributes: { name: Schema.String },
    // @ts-expect-error — a relationship named `type`
    relationships: { type: Relationship.one(() => Person) },
  });

export const relationshipNamedId = () =>
  Resource.make("things", {
    attributes: { name: Schema.String },
    // @ts-expect-error — a relationship named `id`
    relationships: { id: Relationship.optional(() => Person) },
  });

// ---------------------------------------------------------------------------
// `make`: an attribute and a relationship sharing a name
// ---------------------------------------------------------------------------

export const clash = () =>
  Resource.make("articles", {
    attributes: { title: Schema.String, author: Schema.String },
    // @ts-expect-error — `author` is already an attribute
    relationships: { author: Relationship.one(() => Person) },
  });

// Negative control: distinct names, none reserved, compile, and the result
// keeps its exact attribute and relationship keys.
export const Article = Resource.make("articles", {
  attributes: { title: Schema.String, authorName: Schema.String },
  relationships: { author: Relationship.one(() => Person) },
});
export const articleKeys: ReadonlyArray<"title" | "authorName" | "author"> =
  Resource.fieldKeys(Article);

// ---------------------------------------------------------------------------
// `extend`: the same rules over the merged definition
// ---------------------------------------------------------------------------

export const extendAttributeNamedId = () =>
  Resource.extend(Person, "admins", {
    // @ts-expect-error — an attribute named `id`
    attributes: { id: Schema.String },
  });

export const extendAttributeOverRelationship = () =>
  Resource.extend(Article, "features", {
    // @ts-expect-error — `author` is a relationship of the base
    attributes: { author: Schema.String },
  });

export const extendRelationshipOverAttribute = () =>
  Resource.extend(Article, "features", {
    // @ts-expect-error — `title` is an attribute of the base
    relationships: { title: Relationship.one(() => Person) },
  });

export const extendRelationshipOverOwnAttribute = () =>
  Resource.extend(Person, "admins", {
    attributes: { manager: Schema.String },
    // @ts-expect-error — `manager` is an attribute this extension adds
    relationships: { manager: Relationship.one(() => Person) },
  });

// Negative control: overriding a base attribute with an attribute, and a base
// relationship with a relationship, is still allowed.
export const Feature = Resource.extend(Article, "features", {
  attributes: { title: Schema.NonEmptyString, rank: Schema.Finite },
  relationships: { author: Relationship.optional(() => Person) },
});
