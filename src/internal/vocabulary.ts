/**
 * The closed vocabulary a query family's codec admits, published on the
 * codec's schema.
 *
 * A closed vocabulary — the include paths an endpoint supports, the fields a
 * resource sorts on — is derived once, at schema-build time, and the schema
 * that enforces it is the only place that knows the whole set. This
 * annotation lets that schema publish it, so two readers can use it without
 * knowing how any family's codec is built:
 *
 * - the schema-error renderer (`internal/errorMeta.ts`) copies it onto a
 *   rejected value's error object as `meta` (`meta.includablePaths`,
 *   `meta.sortableFields`), so a caller learns the legal set;
 * - `Middleware`'s support check ({@link admitsNoValue}) treats a family
 *   whose vocabulary is empty as one the endpoint does not support (#282).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import { declaredNames } from "./declaredQuery.js";

/** The annotation key. Namespaced so it can never collide with a consumer's. */
const VOCABULARY_ANNOTATION = "~@thomasfosterau/effect-jsonapi/vocabulary";

/**
 * A closed vocabulary: every value one JSON:API query parameter family's
 * codec admits. Only `include` and `sort` publish one today; `page`,
 * `filter` and the per-type `fields[TYPE]` are spelled here so their codecs
 * can publish theirs under the same annotation.
 *
 * @internal
 */
export type Vocabulary =
  | {
      /** The family whose values these are: one parameter, unbracketed or bracketed. */
      readonly family: "include" | "sort" | "page" | "filter";
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
 * The JSON:API query parameter families a vocabulary can belong to.
 *
 * @internal
 */
export type Family = Vocabulary["family"];

// The annotation object `schema.annotate(...)` takes to publish a vocabulary.
const vocabularyAnnotation = (vocabulary: Vocabulary) =>
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

// The family's own vocabulary a node publishes, if it publishes one.
const ownVocabulary = (ast: SchemaAST.AST, family: Family): Option.Option<Vocabulary> =>
  Option.filter(
    Option.flatMap(Option.fromNullishOr(ast.annotations), vocabularyOf),
    (vocabulary) => vocabulary.family === family,
  );

// Whether every value `ast` decodes draws its `family` values from an empty
// vocabulary. A node publishing the family's vocabulary decides it; a union
// does when all its members do (an `undefined` member carries no value); a
// struct or an array does when any member does, a value of it carrying that
// member's values; anything else publishes no vocabulary, so it admits
// values this walk cannot see. A `Suspend` already on the path admits them
// too: it adds nothing the path has not already been asked.
const drawsOnlyFromEmpty = (ast: SchemaAST.AST, family: Family, visiting: Visiting): boolean =>
  Option.match(ownVocabulary(ast, family), {
    onSome: (vocabulary) => Arr.isReadonlyArrayEmpty(vocabulary.values),
    onNone: () => {
      const within = (child: SchemaAST.AST) => drawsOnlyFromEmpty(child, family, visiting);
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
          drawsOnlyFromEmpty(ast.thunk(), family, next),
        );
      }
      return false;
    },
  });

// The schemas a query decodes its wire parameter `name` with, each read on
// its decoded side. On a struct that is its property of that name, or, when
// it has none but its encoded side declares `name`, every property whose name
// that side does not declare: one of them is the property the struct's
// encoding renamed to `name` (`Schema.encodeKeys`), and the AST does not say
// which. Read on every member of a union and through a suspended schema.
const propertiesFor = (
  ast: SchemaAST.AST,
  name: string,
  visiting: Visiting,
): ReadonlyArray<SchemaAST.AST> => {
  if (SchemaAST.isObjects(ast)) {
    const decoded = (signatures: ReadonlyArray<SchemaAST.PropertySignature>) =>
      Arr.map(signatures, (signature) => SchemaAST.toType(signature.type));
    const named = Arr.filter(ast.propertySignatures, (signature) => signature.name === name);
    if (Arr.isReadonlyArrayNonEmpty(named)) return decoded(named);
    const wire = Option.getOrElse(declaredNames(ast), (): ReadonlyArray<string> => []);
    return wire.includes(name)
      ? decoded(
          Arr.filter(ast.propertySignatures, (signature) => !wire.includes(String(signature.name))),
        )
      : [];
  }
  if (SchemaAST.isUnion(ast)) {
    return Arr.flatMap(ast.types, (member) => propertiesFor(member, name, visiting));
  }
  if (SchemaAST.isSuspend(ast)) {
    return Option.match(enter(visiting, ast), {
      onNone: () => [],
      onSome: (next) => propertiesFor(ast.thunk(), name, next),
    });
  }
  return [];
};

/**
 * Whether a query schema declares `family` only with an empty vocabulary, so
 * that no value of it can decode: `include: { paths: [] }`, `include: true`
 * over no relationships, `sort: true` over no attributes. Reads the property
 * the family's wire parameter decodes into and nothing else, so a vocabulary
 * under another parameter never counts: the property named after the family,
 * or, where the query's encoding renames another property to the family's
 * name, every property the wire does not name. True only when every such
 * property, in every member of a union query, draws its values from empty
 * vocabularies alone; a property that publishes no vocabulary
 * (`Query.IncludeList`, a custom codec) or a non-empty one anywhere admits a
 * value, and so does an endpoint whose decoded query has no such property.
 *
 * @internal
 */
export const admitsNoValue = (query: SchemaAST.AST, family: Family): boolean => {
  const properties = propertiesFor(query, family, []);
  return (
    Arr.isReadonlyArrayNonEmpty(properties) &&
    Arr.every(properties, (property) => drawsOnlyFromEmpty(property, family, []))
  );
};
