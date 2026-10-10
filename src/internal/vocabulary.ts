/**
 * The query parameter families JSON:API defines, and the closed vocabulary a
 * family's codec admits, published on the codec's schema.
 *
 * A closed vocabulary — the include paths an endpoint supports, the fields a
 * resource sorts on, the fields a sparse fieldset selects, the fields the
 * filter grammar filters on — is derived once, at schema-build time, and the
 * schema that enforces it is the only place that knows the whole set. This
 * annotation lets that schema publish it, so two readers can use it without
 * knowing how any family's codec is built:
 *
 * - the schema-error renderer (`internal/errorMeta.ts`) copies an `include`
 *   or `sort` vocabulary onto a rejected value's error object as `meta`
 *   (`meta.includablePaths`, `meta.sortableFields`), so a caller learns the
 *   legal set;
 * - `Middleware`'s support check ({@link admitsNoValue}) treats a parameter
 *   whose vocabulary is empty as one the endpoint does not support (#282,
 *   #261).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { declaredNames, wireProperties } from "./declaredQuery.js";

/** The annotation key. Namespaced so it can never collide with a consumer's. */
const VOCABULARY_ANNOTATION = "~@thomasfosterau/effect-jsonapi/vocabulary";

/**
 * The query parameter families JSON:API 1.1 defines, in the order the
 * specification introduces them: the base names reserved to it that an
 * endpoint supports only by declaring them (`Middleware`'s support check,
 * and the `allowedQueryParameters` entries it refuses).
 *
 * @internal
 */
export const FAMILIES = ["include", "fields", "sort", "page", "filter"] as const;

/**
 * A JSON:API query parameter family.
 *
 * @internal
 */
export type Family = (typeof FAMILIES)[number];

/**
 * Whether a parameter's family base name is one JSON:API defines.
 *
 * @internal
 */
export const isFamily = (base: string): base is Family =>
  FAMILIES.some((family) => family === base);

/**
 * Whether a family's bracketed members are each a parameter of its own,
 * which an endpoint supports only by declaring that very member
 * (`declaresName`): `fields[TYPE]` per resource type (#261), and `page[KEY]`
 * and `filter[KEY]` per declared key (#321), so `page[sise]` beside a
 * declared `page[size]` is no more supported than an undeclared family is.
 * An open record of the family (`filter[`, the `filter: true` grammar's
 * rest) declares every member. `include` and `sort` are one unbracketed
 * parameter each, so any declared name of theirs admits the family.
 *
 * @internal
 */
export const isMemberwise = (family: Family): boolean =>
  family === "fields" || family === "page" || family === "filter";

/**
 * A closed vocabulary: every value one JSON:API query parameter family's
 * codec admits. `include`, `sort`, the per-type `fields[TYPE]` and the
 * `filter: true` grammar publish one; `page` is spelled here so a codec can
 * publish its own under the same annotation.
 *
 * @internal
 */
export type Vocabulary =
  | {
      /** The family whose values these are: one parameter, unbracketed or bracketed. */
      readonly family: Exclude<Family, "fields">;
      /** Every value the codec admits: include paths, sortable fields, member names. */
      readonly values: ReadonlyArray<string>;
    }
  | {
      /** A sparse fieldset, whose parameter is bracketed per resource type. */
      readonly family: "fields";
      /** The resource type of the `fields[TYPE]` parameter it governs. */
      readonly type: string;
      /** Every field name the fieldset admits. */
      readonly values: ReadonlyArray<string>;
    };

/**
 * The annotation object `schema.annotate(...)` takes to publish a
 * vocabulary, with nothing else.
 *
 * @internal
 */
export const vocabularyAnnotation = (vocabulary: Vocabulary) =>
  ({ [VOCABULARY_ANNOTATION]: vocabulary }) satisfies Schema.Annotations.Annotations;

/**
 * The annotations of a closed vocabulary's literal schema: its whole set as
 * the family's vocabulary, which the 400 for a rejected value renders as
 * error `meta` and the support check reads, and, when the set is empty, a
 * `message` saying so — `Schema.Literals([])` is `never`, whose rejection
 * would otherwise read "Expected never" (#282).
 *
 * @internal
 */
export const vocabularyAnnotations = (
  vocabulary: Vocabulary,
  emptyMessage: string,
): Schema.Annotations.Annotations =>
  Arr.match(vocabulary.values, {
    onEmpty: () => ({ ...vocabularyAnnotation(vocabulary), message: emptyMessage }),
    onNonEmpty: () => vocabularyAnnotation(vocabulary),
  });

const isVocabulary = (value: unknown): value is Vocabulary =>
  Predicate.hasProperty(value, "family") && Predicate.hasProperty(value, "values");

/**
 * The vocabulary a schema node publishes through its annotations, if any.
 *
 * @internal
 */
export const vocabularyOf = (
  annotations: Schema.Annotations.Annotations,
): Option.Option<Vocabulary> =>
  Option.liftPredicate(annotations[VOCABULARY_ANNOTATION], isVocabulary);

// The suspended schemas on the way down to a node, so a recursive schema
// cannot loop a walk: a `Suspend` already on the path is not followed again.
type Visiting = ReadonlyArray<SchemaAST.AST>;

const enter = (visiting: Visiting, ast: SchemaAST.Suspend): Option.Option<Visiting> =>
  visiting.includes(ast) ? Option.none() : Option.some([...visiting, ast]);

// One wire parameter whose vocabulary a walk reads: its family, and for a
// `fields[TYPE]` the resource type, whose fieldset alone it draws on. A
// `fields` parameter of any other shape (`fields`, `fields[a][b]`) has none,
// and draws on any fieldset.
interface Parameter {
  readonly family: Family;
  readonly type: Option.Option<string>;
}

// The `TYPE` of a `fields[TYPE]` parameter name.
const FIELDSET = /^fields\[([^[\]]*)\]$/;

// The parameter's own vocabulary a node publishes, if it publishes one: its
// family's, and for a `fields[TYPE]` that type's fieldset, so a neighbouring
// type's fieldset never counts.
const ownVocabulary = (ast: SchemaAST.AST, parameter: Parameter): Option.Option<Vocabulary> =>
  Option.filter(
    Option.flatMap(Option.fromNullishOr(ast.annotations), vocabularyOf),
    (vocabulary) =>
      vocabulary.family === parameter.family &&
      (vocabulary.family !== "fields" ||
        Option.match(parameter.type, {
          onNone: () => true,
          onSome: (type) => vocabulary.type === type,
        })),
  );

// Whether every value `ast` decodes draws its values for `parameter` from an
// empty vocabulary. A node publishing the parameter's vocabulary decides it;
// a union does when all its members do (an `undefined` member carries no
// value); a struct or an array does when any member does, a value of it
// carrying that member's values; anything else publishes no vocabulary, so
// it admits values this walk cannot see. A `Suspend` already on the path
// admits them too: it adds nothing the path has not already been asked.
const drawsOnlyFromEmpty = (
  ast: SchemaAST.AST,
  parameter: Parameter,
  visiting: Visiting,
): boolean =>
  Option.match(ownVocabulary(ast, parameter), {
    onSome: (vocabulary) => Arr.isReadonlyArrayEmpty(vocabulary.values),
    onNone: () => {
      const within = (child: SchemaAST.AST) => drawsOnlyFromEmpty(child, parameter, visiting);
      if (SchemaAST.isUnion(ast)) {
        const members = Arr.filter(ast.types, (member) => !SchemaAST.isUndefined(member));
        return Arr.isReadonlyArrayNonEmpty(members) && Arr.every(members, within);
      }
      if (SchemaAST.isObjects(ast)) {
        return Arr.some([...ast.propertySignatures, ...ast.indexSignatures], ({ type }) =>
          within(type),
        );
      }
      if (SchemaAST.isArrays(ast)) return Arr.some([...ast.elements, ...ast.rest], within);
      if (SchemaAST.isSuspend(ast)) {
        return Option.exists(enter(visiting, ast), (next) =>
          drawsOnlyFromEmpty(ast.thunk(), parameter, next),
        );
      }
      return false;
    },
  });

// The schemas a query decodes its wire parameter `name` with, each read on
// its decoded side. On a struct that is the property its encoding sends
// under `name` (`wireProperties`), whatever its decoded name. Where the
// encoding does not settle that, it is among the properties the encoding
// does not settle: the one of that name, or of the family's name
// (`Query.schema` nests every `fields[TYPE]` under `fields`), or, when it has
// neither but its encoded side declares `name`, every such property whose
// name that side does not declare, one of which the struct's encoding
// renamed to `name`. Read on every member of a union and through a
// suspended schema.
const propertiesFor = (
  ast: SchemaAST.AST,
  name: string,
  family: Family,
  visiting: Visiting,
): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isObjects(ast)) {
    const decoded = (signatures: ReadonlyArray<SchemaAST.PropertySignature>) =>
      Arr.map(signatures, (signature) => SchemaAST.toType(signature.type));
    const settled = wireProperties(ast);
    const sent = Arr.filter(settled, (property) => property.wire === name);
    if (Arr.isReadonlyArrayNonEmpty(sent)) {
      return decoded(Arr.map(sent, ({ property }) => property));
    }
    const unsettled = Arr.filter(
      ast.propertySignatures,
      (signature) => !Arr.some(settled, ({ property }) => property === signature),
    );
    const named = Arr.filter(
      unsettled,
      (signature) => signature.name === name || signature.name === family,
    );
    if (Arr.isReadonlyArrayNonEmpty(named)) return decoded(named);
    const wire = Option.getOrElse(declaredNames(ast), (): ReadonlyArray<string> => []);
    return wire.includes(name)
      ? decoded(Arr.filter(unsettled, (signature) => !wire.includes(String(signature.name))))
      : [];
  }
  if (SchemaAST.isUnion(ast)) {
    return Arr.flatMap(ast.types, (member) => propertiesFor(member, name, family, visiting));
  }
  if (SchemaAST.isSuspend(ast)) {
    return Option.match(enter(visiting, ast), {
      onNone: () => [],
      onSome: (next) => propertiesFor(ast.thunk(), name, family, next),
    });
  }
  return [];
};

/**
 * Whether a query schema declares the wire parameter `name` only with an
 * empty vocabulary, so that no value of it can decode: `include: { paths: []
 * }`, `include: true` over no relationships, `sort: true` over no
 * attributes, `filter: true` over no filterable field, and a `fields[TYPE]`
 * whose resource type has no attribute. Always false for a name outside the
 * specification's families. `fields` is per resource type: `fields[TYPE]`
 * reads only TYPE's fieldset, so a neighbouring type's never counts; every
 * other family is read whole.
 *
 * Reads the property the wire parameter decodes into and nothing else, so a
 * vocabulary under another parameter never counts: the property the query's
 * encoding sends under the wire name (`wireProperties`), whatever its
 * decoded name. Where the encoding does not settle that, it reads, among the
 * properties it does not settle, the one named after the wire parameter or
 * its family, or, where the encoded side declares the wire name, every one
 * the wire does not name. True only when every such property, in every
 * member of a union query, draws its values from empty vocabularies alone;
 * a property that publishes no vocabulary (`Query.IncludeList`, a custom
 * codec) or a non-empty one anywhere admits a value, and so does an endpoint
 * whose decoded query has no such property.
 *
 * @internal
 */
export const admitsNoValue = (query: SchemaAST.AST, name: string): boolean => {
  const bracket = name.indexOf("[");
  const family = bracket === -1 ? name : name.slice(0, bracket);
  if (!isFamily(family)) return false;
  const type =
    family === "fields" ? Option.fromNullishOr(FIELDSET.exec(name)?.[1]) : Option.none<string>();
  const parameter: Parameter = { family, type };
  const properties = propertiesFor(query, family === "fields" ? name : family, family, []);
  return (
    Arr.isReadonlyArrayNonEmpty(properties) &&
    Arr.every(properties, (property) => drawsOnlyFromEmpty(property, parameter, []))
  );
};
