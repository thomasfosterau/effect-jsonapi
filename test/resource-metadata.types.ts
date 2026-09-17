/**
 * Type-level tests for resource metadata and introspection.
 *
 *   - `Resource.annotate` returns a *resource*, not a bare annotated schema:
 *     the definition keeps its exact type, so every derived member survives and
 *     it is still accepted wherever a resource is — including as a relationship
 *     target, which resolves lazily and by identity.
 *   - `Resource.attributeDescriptors` reports the **declared** attribute keys
 *     (input-only ones included) as a literal union, with the projections typed
 *     as the closed unions they are.
 *   - `Relationship.paginated`'s canonical `order` is closed over the *related*
 *     resource's attributes, plus its `id`.
 *
 * This file is type-checked by `tsconfig.test.json`; the `@ts-expect-error`
 * annotations are the assertions, each paired with the negative control that
 * shows the error is the declaration's and not the expression's. Every binding
 * is exported so an unused-local error can never stand in for the assertion an
 * `@ts-expect-error` expects.
 */
import { Schema } from "effect"
import { Relationship, Resource, Sort } from "@thomasfosterau/effect-jsonapi"

// Asserts that a value is assignable to `Expected`.
const assertType = <Expected>(_value: Expected): void => {}

// Whether two types are identical (not merely mutually assignable).
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false

const Person = Resource.make("people", {
  attributes: { name: Schema.NonEmptyString, joinedAt: Schema.DateFromString }
})

const Annotated = Resource.annotate(Person, { "acme/table": "people" })

// ---------------------------------------------------------------------------
// `annotate` preserves the resource type exactly
// ---------------------------------------------------------------------------

export const sameType: Equals<typeof Annotated, typeof Person> = true
// @ts-expect-error -- the identity is exact: it is not some widened resource
export const notWidened: Equals<typeof Annotated, Resource.Any> = true

// Every derived member survives, at the type level as at runtime.
export const type: "people" = Annotated.type
export const id: string = Annotated.Id.make("1")
export const ref: { readonly type: "people"; readonly id: string } = Annotated.ref("1")
export const createPayload: typeof Annotated.createPayload.Type = {
  data: { type: "people", attributes: { name: "Ada", joinedAt: new Date() } }
}
export const declaredKeys: keyof Resource.DeclaredAttributesOf<typeof Annotated> = "name"

// The negative control for the member assertions above: a member a resource
// really does not have is still an error.
// @ts-expect-error -- no such member on a resource definition
export const missingMember = Annotated.notAMember

// Effect's own `annotate` is what does *not* preserve it: the rebuilt schema is
// a plain struct, with none of the resource's assigned members.
// @ts-expect-error -- `schema.annotate` returns a schema, not a resource
export const bareAnnotate: "people" = Person.annotate({ title: "Person" }).type

// ---------------------------------------------------------------------------
// An annotated resource is still a relationship *target*
// ---------------------------------------------------------------------------

const Article = Resource.make("articles", {
  attributes: { title: Schema.NonEmptyString },
  relationships: {
    author: Relationship.one(() => Annotated),
    editor: Relationship.optional(() => Annotated),
    revisions: Relationship.paginated(() => Annotated, {
      order: [{ field: "joinedAt", direction: "desc" }]
    })
  }
})

export const target: Equals<Resource.Target<typeof Article, "author">, typeof Person> = true
export const linkage: NonNullable<(typeof Article.Type)["relationships"]>["author"]["data"] = {
  type: "people",
  id: Annotated.Id.make("9")
}
export const foreignLinkage: NonNullable<(typeof Article.Type)["relationships"]>["author"]["data"] = {
  // @ts-expect-error -- the target's branded type tag is still enforced
  type: "articles",
  id: Annotated.Id.make("9")
}

// ---------------------------------------------------------------------------
// `attributeDescriptors` reports the declared keys and closed projections
// ---------------------------------------------------------------------------

const Upload = Resource.make("uploads", {
  attributes: {
    fileName: Schema.NonEmptyString,
    caption: Resource.attribute(Schema.String, { create: "optional" }),
    // input-only: declared, but never on the resource object
    file: Resource.attribute(Schema.Uint8Array, { resource: false, update: false })
  }
})

const descriptors = Resource.attributeDescriptors(Upload)
type Key = (typeof descriptors)[number]["key"]

// The declared keys — the input-only one included, unlike `AttributeKeys`.
export const declaredKey: Key = "file"
export const anotherKey: Key = "fileName"
// @ts-expect-error -- "notDeclared" is not an attribute of this resource
export const undeclaredKey: Key = "notDeclared"
export const keysAreDeclared: Equals<Key, "fileName" | "caption" | "file"> = true

const descriptor = descriptors[0]!
assertType<Resource.AttributePresence>(descriptor.resource)
assertType<Resource.AttributePresence>(descriptor.create)
assertType<"optional" | false>(descriptor.update)
assertType<boolean>(descriptor.clearable)
assertType<boolean>(descriptor.nullable)
assertType<boolean>(descriptor.readOnly)
assertType<Schema.Codec<unknown, unknown>>(descriptor.schema)
assertType<Schema.Annotations.Annotations | undefined>(descriptor.annotations)

// `update` is the narrower union: an attribute is never *required* on update.
// @ts-expect-error -- "required" is not an update presence
export const requiredUpdate: (typeof descriptor)["update"] = "required"
// the negative control: the two presences an update really admits
export const optionalUpdate: (typeof descriptor)["update"] = "optional"
export const excludedUpdate: (typeof descriptor)["update"] = false

// ---------------------------------------------------------------------------
// A paginated relationship's canonical order is closed over the target
// ---------------------------------------------------------------------------

const Comment = Resource.make("comments", {
  attributes: { body: Schema.NonEmptyString, postedAt: Schema.DateFromString }
})

export const order: Relationship.Order<typeof Comment> = [
  { field: "postedAt", direction: "desc" },
  // the identifier is orderable too — it is what makes an order total
  { field: "id", direction: "asc" }
]
// @ts-expect-error -- "title" is not an attribute of the *related* resource
export const foreignField: Relationship.Order<typeof Comment> = [{ field: "title", direction: "asc" }]
// the negative control: the related resource's own attribute compiles
export const ownField: Relationship.Order<typeof Comment> = [{ field: "body", direction: "asc" }]

// @ts-expect-error -- the only directions are "asc" and "desc"
export const badDirection: Relationship.Order<typeof Comment> = [{ field: "id", direction: "sideways" }]

// The declaration is recorded on the descriptor, so a reader sees the literals.
const Thread = Resource.make("threads", {
  attributes: { subject: Schema.NonEmptyString },
  relationships: {
    replies: Relationship.paginated(() => Comment, { order: [{ field: "postedAt", direction: "asc" }] }),
    unordered: Relationship.paginated(() => Comment)
  }
})

export const declaredOrder: Equals<
  (typeof Thread.relationships.replies)["order"],
  readonly [{ readonly field: "postedAt"; readonly direction: "asc" }]
> = true
export const noOrder: Equals<(typeof Thread.relationships.unordered)["order"], undefined> = true

// An order is a list of sort terms — the same shape `Query.Sort` decodes into.
assertType<ReadonlyArray<Sort.Term<"postedAt" | "body" | "id">>>(order)
