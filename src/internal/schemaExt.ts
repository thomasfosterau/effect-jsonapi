/**
 * Pure Effect Schema helpers with no JSON:API dependency of their own.
 *
 * **Moves to `@thomasfosterau/effect-schema-ext`** (effect-schema-ext#1) once
 * that package publishes; this module is the interim home so nothing here
 * depends on an unpublished package. Everything is re-exported from a public
 * module (`ServerErrors.pathToJsonPointer`, `FlatQuery.suppliedValue`) so the
 * move is an import change, not an API change.
 *
 * @internal
 */
// The bare `effect` barrel: the schema-only entry point reaches this module,
// and `test/entry-points.test.ts` pins `effect` as its only external.
import { JsonPointer, Option, Predicate, SchemaIssue } from "effect";

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
