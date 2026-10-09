/**
 * Pure Effect Schema helpers with no JSON:API dependency of their own.
 *
 * **Moves to `@thomasfosterau/effect-schema-ext`** (effect-schema-ext#1) once
 * that package publishes; this module is the interim home so nothing here
 * depends on an unpublished package. Everything public is re-exported from a
 * public module (`ServerErrors.pathToJsonPointer`, `FlatQuery.suppliedValue`)
 * so the move is an import change, not an API change; `closedStruct` is used
 * only inside the library's own request-body schemas.
 *
 * @internal
 */
// The bare `effect` barrel: the schema-only entry point reaches this module,
// and `test/entry-points.test.ts` pins `effect` as its only external.
import {
  Array as Arr,
  JsonPointer,
  Option,
  Predicate,
  Record as Rec,
  Schema,
  SchemaIssue,
} from "effect";

/**
 * The value an update actually **supplies** for a clearable, tri-state field
 * (`Schema.optionalKey(Schema.OptionFromNullOr(X))`), collapsing the two
 * states that supply no value: an absent key (carry forward) and an explicit
 * `Option.none()` (clear).
 *
 * Use it only where those two genuinely behave alike — a side effect that
 * runs only when a value is *set*. Never on a write path, where "carry
 * forward" and "clear" must produce different column values.
 */
export const suppliedValue = <A>(field: Option.Option<A> | undefined): Option.Option<A> =>
  field ?? Option.none();

/**
 * An RFC 6901 JSON Pointer from a path of property keys:
 * `["data", "attributes", "name"]` → `/data/attributes/name`. The empty path
 * is `""` (the whole document). Segments are escaped (`~` → `~0`, `/` → `~1`).
 */
export const pathToJsonPointer = (path: ReadonlyArray<PropertyKey>): string =>
  path.length === 0
    ? ""
    : `/${path.map((segment) => JsonPointer.escapeToken(String(segment))).join("/")}`;

/** One terminal issue of a schema failure, with the path that reaches it. */
export interface IssueLeaf {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly issue: SchemaIssue.Issue;
  /**
   * The node a formatter renders this leaf's message from: the leaf itself,
   * or the nearest `Filter` above it. A failed check's leaf is usually an
   * `InvalidValue` with no message of its own; what the check expected, and
   * any `message` annotation on it, lives on the `Filter`.
   */
  readonly describedBy: SchemaIssue.Issue;
}

/** An `InvalidValue` leaf carrying no `message` annotation of its own. */
const isBareInvalidValue = (leaf: SchemaIssue.Issue): boolean =>
  Predicate.isTagged(leaf, "InvalidValue") && !Predicate.isString(leaf.annotations?.message);

/**
 * A bare `InvalidValue` is described by the nearest `Filter` above it when
 * that `Filter` sits directly over it (its `expected` text, or `Expected
 * <filter>`) or carries a `message` annotation (a struct-level check that
 * points its failure at a field). Any other leaf describes itself.
 */
const describedBy = (
  leaf: SchemaIssue.Issue,
  filter: Option.Option<SchemaIssue.Filter>,
): SchemaIssue.Issue =>
  isBareInvalidValue(leaf)
    ? Option.getOrElse(
        Option.filter(
          filter,
          (check) => check.issue === leaf || SchemaIssue.defaultCheckHook(check) !== undefined,
        ),
        () => leaf,
      )
    : leaf;

/**
 * Flattens an Effect Schema issue tree to its leaves, accumulating every
 * `Pointer`'s path on the way down.
 *
 * `Pointer` extends the path and recurses; `Composite` and a non-empty
 * `AnyOf` recurse into each child at the same path (one leaf per rejected
 * union member); `Filter` and `Encoding` recurse into their inner issue (the
 * nearest `Filter` is carried down to decide each leaf's `describedBy`); an
 * empty `AnyOf` (a literal-union no-match) and every other node is a leaf.
 */
export const issueLeaves = (issue: SchemaIssue.Issue): ReadonlyArray<IssueLeaf> => {
  const leaves: Array<IssueLeaf> = [];
  const walk = (
    current: SchemaIssue.Issue,
    path: ReadonlyArray<PropertyKey>,
    filter: Option.Option<SchemaIssue.Filter>,
  ): void => {
    switch (current._tag) {
      case "Pointer":
        walk(current.issue, [...path, ...current.path], filter);
        return;
      case "Composite":
        for (const child of current.issues) walk(child, path, filter);
        return;
      case "AnyOf":
        if (current.issues.length === 0) {
          leaves.push({ path, issue: current, describedBy: current });
          return;
        }
        for (const child of current.issues) walk(child, path, filter);
        return;
      case "Filter":
        walk(current.issue, path, Option.some(current));
        return;
      case "Encoding":
        walk(current.issue, path, filter);
        return;
      default:
        leaves.push({ path, issue: current, describedBy: describedBy(current, filter) });
    }
  };
  walk(issue, [], Option.none());
  return leaves;
};

// A struct that declares no fields parses any non-nullish input (in the
// pinned effect it is a bare not-nullish check), so this filter first answers
// a non-object the way a struct with fields does: "Expected object" at the
// member itself. `Predicate.isObject` is the test that struct applies
// (`typeof "object"`, not `null`, not an array). Otherwise each enumerable own
// key of the input is an `UnexpectedKey` at its own path, the issue
// `onExcessProperty: "error"` reports for a struct with fields;
// `Reflect.ownKeys` rather than `Object.keys` so a symbol key counts too.
// The keys are grouped under a `Composite` on `Schema.Unknown`'s AST, not on
// this struct's: a formatter reads a `message` annotation on a check's issue
// as the whole check's message, so grouping them on the struct (which
// carries `nullAsObject`, below) would collapse every key into one "Expected
// object" at the member.
// No `identifier` / `title` / `description`: an identifier makes each site a
// named component (`noMembers`, `noMembers_1`, …) in every consumer's OpenAPI
// document and renders a `null` member as "Expected <identifier>", and a title
// or description would be copied into that document too.
// oxlint-disable-next-line effect/require-filter-metadata -- see above: this check must stay anonymous in consumers' OpenAPI
const noMembers = Schema.makeFilter<unknown>(
  (input, ast, options) => {
    if (!Predicate.isObject(input)) return "Expected object";
    const members = Reflect.ownKeys(input)
      .filter((key) => Object.prototype.propertyIsEnumerable.call(input, key))
      .map(
        (key) =>
          new SchemaIssue.Pointer(
            [key],
            new SchemaIssue.UnexpectedKey(ast, Object.getOwnPropertyDescriptor(input, key)?.value),
          ),
      );
    return Arr.isReadonlyArrayNonEmpty(members)
      ? new SchemaIssue.Composite(Schema.Unknown.ast, members, input, options)
      : true;
  },
  { toJsonSchema: () => ({ type: "object", additionalProperties: false }) },
);

// A `null` never reaches `noMembers`: the empty struct's own not-nullish
// check rejects it first, as an `InvalidType` whose text comes from
// `SchemaAST.Objects#getExpected`, which is "object | array" for a struct with
// no fields ("object" for one with fields). The default formatters read a
// `message` annotation on that issue's AST before the expected text, so this
// one renders the `null` the way a struct with fields does (#286). Unlike an
// `identifier`, a `message` names no OpenAPI component and is not copied into
// the JSON Schema, and it changes no parse: only the text of that issue.
const nullAsObject = { message: "Expected object" } as const;

/**
 * `Schema.Struct(fields)`, closed when `fields` is empty: a struct that
 * declares no fields rejects every member of its input, each as an
 * `UnexpectedKey` issue at that member's path ("Expected no excess property"),
 * and rejects a non-object, an array or a `null` at its own path ("Expected
 * object"), as a struct with fields does.
 *
 * In the pinned `effect`, a struct **with** fields drops input keys it doesn't
 * declare, but a struct with **no** fields is a bare not-nullish check that
 * returns its input unchanged, so every key reaches the decoded value although
 * its type is `{}`. Parse options can't close it (`onExcessProperty` is never
 * consulted on that path); this check does. A struct with fields is returned
 * as `Schema.Struct` builds it.
 */
export const closedStruct = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
): Schema.Struct<Fields> =>
  Rec.isEmptyReadonlyRecord(fields)
    ? Schema.Struct<Fields>(fields).annotate(nullAsObject).check(noMembers)
    : Schema.Struct(fields);
