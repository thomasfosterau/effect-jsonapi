/**
 * Type-level tests for the wire shapes spelled from their schemas (#533, PR 5
 * of the `prefer-option-over-null` series): each exported wire type is
 * `Equals` to what a schema for that wire member decodes, built here
 * independently of the module's own spelling — so the respelling kept the
 * type identical (`null` stays on the wire, a JSON:API-optional member stays a
 * native optional), and a later drift in either fails here.
 *
 * The members that were `?: T | undefined` are now the wire's own `?: T` (as
 * `Schema.optionalKey` decodes them), which the `@ts-expect-error` cases pin:
 * a decoded document still assigns, an explicit `undefined` does not.
 *
 * Type-checked by `tsconfig.json`; never executed.
 */
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  Assemble,
  Atomic,
  Client,
  Handlers,
  Lid,
  Relationship,
  Resource,
} from "@thomasfosterau/effect-jsonapi";

const assertTrue = <T extends true>(): T[] => [];

// The non-null halves, as schemas of the module's own interfaces.
const Identifier = Schema.Struct({ type: Schema.String, id: Schema.String });
const Linkage = Schema.NullOr(Schema.Union([Identifier, Schema.Array(Identifier)]));
const LinkValue = Schema.Union([Schema.String, Schema.Struct({ href: Schema.String })]);
const AnyRecord = Schema.Record(Schema.String, Schema.Unknown);

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const linkageValue = assertTrue<Types.Equals<Handlers.LinkageValue, typeof Linkage.Type>>();

const TopLevelLinks = Schema.Struct({
  self: Schema.optionalKey(LinkValue),
  related: Schema.optionalKey(LinkValue),
  describedby: Schema.optionalKey(LinkValue),
  first: Schema.optionalKey(Schema.NullOr(LinkValue)),
  last: Schema.optionalKey(Schema.NullOr(LinkValue)),
  prev: Schema.optionalKey(Schema.NullOr(LinkValue)),
  next: Schema.optionalKey(Schema.NullOr(LinkValue)),
});
export const linksValue =
  assertTrue<Types.Equals<Handlers.LinksValue, typeof TopLevelLinks.Type>>();

const RelationshipValue = Schema.Struct({
  data: Schema.optionalKey(Linkage),
  links: Schema.optionalKey(Schema.Unknown),
  meta: Schema.optionalKey(Schema.Unknown),
});
export const resourceValueRelationship =
  assertTrue<
    Types.Equals<
      NonNullable<Handlers.ResourceValue["relationships"]>[string],
      typeof RelationshipValue.Type
    >
  >();

const ResourceValue = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  relationships: Schema.optionalKey(Schema.Record(Schema.String, RelationshipValue)),
});
const Primary = Schema.NullOr(Schema.Union([ResourceValue, Schema.Array(ResourceValue)]));
export const resolveIncludedPrimary =
  assertTrue<Types.Equals<Parameters<typeof Handlers.resolveIncluded>[0], typeof Primary.Type>>();

// `data`'s bound admits `null` primary data, and `resource` infers it.
export const nullData = Handlers.data(null);

// ---------------------------------------------------------------------------
// Atomic
// ---------------------------------------------------------------------------

const ResultValue = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(ResourceValue)),
  meta: Schema.optionalKey(AnyRecord),
});
export const resultValue = assertTrue<Types.Equals<Atomic.ResultValue, typeof ResultValue.Type>>();
export const nullResult = Atomic.result(null);

const Person = Resource.make("people", { attributes: { name: Schema.String } });
const Article = Resource.make("articles", {
  attributes: { title: Schema.String },
  relationships: {
    author: Relationship.optional(() => Person),
    editor: Relationship.one(() => Person),
  },
});
const OptionalRef = Schema.NullOr(Resource.Ref(Person));
export const optionalRelationshipData =
  assertTrue<
    Types.Equals<Atomic.RelationshipDataValue<typeof Article, "author">, typeof OptionalRef.Type>
  >();

// ---------------------------------------------------------------------------
// Lid
// ---------------------------------------------------------------------------

const RefValue = Schema.Union([
  Identifier,
  Schema.Struct({ type: Schema.String, lid: Schema.String }),
]);
const RefLinkage = Schema.Record(
  Schema.String,
  Schema.Struct({
    data: Schema.optionalKey(Schema.NullOr(Schema.Union([RefValue, Schema.Array(RefValue)]))),
    meta: Schema.optionalKey(AnyRecord),
  }),
);
export const refLinkageValue =
  assertTrue<Types.Equals<Lid.RefLinkageValue, typeof RefLinkage.Type>>();

const OptionalLinkage = Schema.Struct({
  data: Schema.NullOr(Person.identifier),
  meta: Schema.optionalKey(AnyRecord),
});
export const resolvedOptionalLinkage =
  assertTrue<
    Types.Equals<
      NonNullable<Lid.ResolvedLinkage<typeof Article>["author"]>,
      typeof OptionalLinkage.Type
    >
  >();

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------

const AssembleRef = Schema.Struct({ type: Schema.String, id: Schema.String });
const RefLinkageData = Schema.NullOr(Schema.Union([AssembleRef, Schema.Array(AssembleRef)]));
export const relationshipDocumentData =
  assertTrue<
    Types.Equals<
      Assemble.RelationshipDocument<Assemble.ResourceLike>["data"],
      typeof RefLinkageData.Type
    >
  >();
export const relationshipObjectData =
  assertTrue<
    Types.Equals<
      NonNullable<Assemble.RelationshipObject["data"]>,
      NonNullable<typeof RefLinkageData.Type>
    >
  >();

// `RelationshipObject` / `ResourceLike` members are native optionals: an
// absent member is left out, not forwarded as `undefined`.
export const relationshipObject: Assemble.RelationshipObject = { data: null };
// @ts-expect-error -- an explicit `undefined` is not a wire value
export const relationshipObjectUndefined: Assemble.RelationshipObject = { meta: undefined };
export const resourceLike: Assemble.ResourceLike = { type: "t", id: "1", attributes: {} };
// @ts-expect-error -- an explicit `undefined` is not a wire value
export const resourceLikeUndefined: Assemble.ResourceLike = {
  type: "t",
  id: "1",
  attributes: {},
  links: undefined,
};

// A decoded resource (its members `Schema.optionalKey`) still assigns.
export const decodedAssigns = (person: typeof Person.Type): Assemble.ResourceLike => person;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const IncludedResource = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  attributes: Schema.optionalKey(AnyRecord),
  relationships: Schema.optionalKey(AnyRecord),
  links: Schema.optionalKey(AnyRecord),
  meta: Schema.optionalKey(AnyRecord),
});
export const includedResource =
  assertTrue<Types.Equals<Client.IncludedResource, typeof IncludedResource.Type>>();

const LinkedResource = Schema.Struct({ relationships: Schema.optionalKey(AnyRecord) });
const HydrateDocument = Schema.Struct({
  data: Schema.NullOr(LinkedResource),
  included: Schema.optionalKey(Schema.Array(IncludedResource)),
});
export const hydrateDocument =
  assertTrue<Types.Equals<Parameters<typeof Client.hydrate>[1], typeof HydrateDocument.Type>>();

// @ts-expect-error -- an explicit `undefined` is not a wire value
export const documentMembersUndefined: Client.DocumentMembers = { meta: undefined };
export const totalCountOfNothing = Client.readTotalCount();
