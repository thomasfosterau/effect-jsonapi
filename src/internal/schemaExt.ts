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
import type { SchemaIssue } from "effect";
import { JsonPointer, Option, Predicate } from "effect";

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
   * or the `Filter` directly wrapping it. A failed check's leaf is a bare
   * `InvalidValue`; what the check expected — and any `message` annotation
   * on it — lives on the `Filter`.
   */
  readonly describedBy: SchemaIssue.Issue;
}

/**
 * A failed check's leaf is a bare `InvalidValue` directly under its `Filter`;
 * the check's message is the `Filter`'s. Any other leaf describes itself.
 */
const describedBy = (
  leaf: SchemaIssue.Issue,
  filter: Option.Option<SchemaIssue.Filter>,
): SchemaIssue.Issue =>
  Predicate.isTagged(leaf, "InvalidValue") ? Option.getOrElse(filter, () => leaf) : leaf;

/**
 * Flattens an Effect Schema issue tree to its leaves, accumulating every
 * `Pointer`'s path on the way down.
 *
 * `Pointer` extends the path and recurses; `Composite` and a non-empty
 * `AnyOf` recurse into each child at the same path (one leaf per rejected
 * union member); `Filter` and `Encoding` recurse into their inner issue (a
 * `Filter` directly over an `InvalidValue` becomes that leaf's
 * `describedBy`); an empty `AnyOf` (a literal-union no-match) and every other
 * node is a leaf.
 */
export const issueLeaves = (issue: SchemaIssue.Issue): ReadonlyArray<IssueLeaf> => {
  const leaves: Array<IssueLeaf> = [];
  const walk = (
    current: SchemaIssue.Issue,
    path: ReadonlyArray<PropertyKey>,
    filter: Option.Option<SchemaIssue.Filter> = Option.none(),
  ): void => {
    switch (current._tag) {
      case "Pointer":
        walk(current.issue, [...path, ...current.path]);
        return;
      case "Composite":
        for (const child of current.issues) walk(child, path);
        return;
      case "AnyOf":
        if (current.issues.length === 0) {
          leaves.push({ path, issue: current, describedBy: current });
          return;
        }
        for (const child of current.issues) walk(child, path);
        return;
      case "Filter":
        walk(current.issue, path, Option.some(current));
        return;
      case "Encoding":
        walk(current.issue, path);
        return;
      default:
        leaves.push({ path, issue: current, describedBy: describedBy(current, filter) });
    }
  };
  walk(issue, []);
  return leaves;
};
