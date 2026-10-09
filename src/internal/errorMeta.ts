/**
 * Error `meta` carried by a schema, for the 400 a decode failure renders.
 *
 * A closed vocabulary — the include paths an endpoint supports, the fields a
 * resource sorts on — is derived once, at schema-build time, and the schema
 * that enforces it is the only place that knows the whole set. When a request
 * names a member outside it, the spec-compliant answer is a 400 whose `detail`
 * says which value failed; what the caller actually needs next is the set it
 * should have picked from. This annotation lets the codec that owns the set
 * publish it, and lets the schema-error renderer (`Middleware.schemaErrorDocument`)
 * copy it onto the error object's `meta` — `meta.includablePaths`,
 * `meta.sortableFields` — without the renderer knowing anything about
 * includes or sorts.
 *
 * The lookup walks the issue tree once, recording the `meta` of every node
 * whose AST carries the annotation together with the path at which it was
 * found; a formatted leaf then takes the meta of the nearest annotated node
 * above it (the node's path is a prefix of the leaf's), so a failure inside a
 * repeated-key list (`include[1]`) still reaches the annotation on the list's
 * element schema.
 */
import type { Schema } from "effect";
import type { SchemaIssue } from "effect";

/** The annotation key. Namespaced so it can never collide with a consumer's. */
const ERROR_META_ANNOTATION = "~@thomasfosterau/effect-jsonapi/errorMeta";

/** The shape the annotation carries: members merged into the error object's `meta`. */
export type ErrorMeta = Readonly<Record<string, unknown>>;

/** The annotation object `schema.annotate(...)` takes to publish `meta`. */
export const errorMeta = (meta: ErrorMeta): { readonly [ERROR_META_ANNOTATION]: ErrorMeta } => ({
  [ERROR_META_ANNOTATION]: meta,
});

/** The `meta` a schema node publishes through its annotations, if any. */
export const errorMetaOf = (
  annotations: Schema.Annotations.Annotations | undefined,
): ErrorMeta | undefined => {
  const meta = annotations?.[ERROR_META_ANNOTATION];
  return typeof meta === "object" && meta !== null ? (meta as ErrorMeta) : undefined;
};

/** One annotated node: where in the decoded value it sits, and what it publishes. */
interface Found {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly meta: ErrorMeta;
}

// The AST an issue variant reports on, where it reports one. `MissingKey` /
// `InvalidValue` / `Forbidden` carry key- or issue-level annotations rather
// than a schema node, so they never publish `meta` themselves — a failure
// under them still inherits from an annotated ancestor.
const astOf = (
  issue: SchemaIssue.Issue,
): { readonly annotations?: Schema.Annotations.Annotations | undefined } | undefined => {
  switch (issue._tag) {
    case "InvalidType":
    case "UnexpectedKey":
    case "Composite":
    case "AnyOf":
    case "Encoding":
      return issue.ast;
    default:
      return undefined;
  }
};

const collect = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  found: Array<Found>,
): void => {
  const meta = errorMetaOf(astOf(issue)?.annotations);
  if (meta !== undefined) found.push({ path, meta });
  switch (issue._tag) {
    case "Pointer":
      collect(issue.issue, [...path, ...issue.path], found);
      return;
    case "Filter":
    case "Encoding":
      collect(issue.issue, path, found);
      return;
    case "Composite":
    case "AnyOf":
      for (const child of issue.issues) collect(child, path, found);
      return;
    default:
      return;
  }
};

const isPrefix = (prefix: ReadonlyArray<PropertyKey>, path: ReadonlyArray<PropertyKey>): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);

/**
 * The `meta` a formatted leaf at `path` should carry: the annotation of the
 * nearest annotated node on the way down to it, `undefined` when there is
 * none. Build the index once per issue with {@link indexErrorMeta} and query
 * it per leaf.
 */
export const indexErrorMeta = (
  issue: SchemaIssue.Issue,
): ((path: ReadonlyArray<PropertyKey>) => ErrorMeta | undefined) => {
  const found: Array<Found> = [];
  collect(issue, [], found);
  return (path) => {
    let best: Found | undefined;
    for (const candidate of found) {
      if (
        isPrefix(candidate.path, path) &&
        (best === undefined || candidate.path.length >= best.path.length)
      ) {
        best = candidate;
      }
    }
    return best?.meta;
  };
};
