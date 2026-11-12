/**
 * Error `meta` carried by a schema, for the 400 a decode failure renders.
 *
 * When a request names a member outside a closed vocabulary — the include
 * paths an endpoint supports, the fields a resource sorts on — the
 * spec-compliant answer is a 400 whose `detail` says which value failed;
 * what the caller actually needs next is the set it should have picked from.
 * The codec that owns the set publishes it as its vocabulary
 * (`internal/vocabulary.ts`), and this module lets the schema-error renderer
 * (`Middleware.schemaErrorDocument`) copy it onto the error object's `meta` —
 * `meta.includablePaths`, `meta.sortableFields` — without the renderer
 * knowing anything about includes or sorts.
 *
 * The lookup walks the issue tree once, recording the `meta` of every node
 * whose AST publishes a vocabulary together with the path at which it was
 * found; a formatted leaf then takes the meta of the nearest annotated node
 * above it (the node's path is a prefix of the leaf's), so a failure inside a
 * repeated-key list (`include[1]`) still reaches the annotation on the list's
 * element schema.
 */
import * as Arr from "effect/Array";
import type * as Schema from "effect/Schema";
import type * as SchemaAST from "effect/SchemaAST";
import type * as SchemaIssue from "effect/SchemaIssue";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as R from "effect/Record";
import type { Family } from "./vocabulary.js";
import { vocabularyOf } from "./vocabulary.js";

/** The `meta` a vocabulary renders as: members merged into the error object's `meta`. */
type ErrorMeta = R.ReadonlyRecord<string, unknown>;

// The `meta` member each family's vocabulary renders under. A family not
// listed here publishes its vocabulary to the support check only.
const META_KEYS: Partial<Readonly<Record<Family, string>>> = {
  include: "includablePaths",
  sort: "sortableFields",
};

/** The `meta` a schema node publishes through its vocabulary, if any. */
const errorMetaOf = (annotations: Schema.Annotations.Annotations): Option.Option<ErrorMeta> =>
  Option.flatMap(vocabularyOf(annotations), ({ family, values }) =>
    Option.map(Option.fromUndefinedOr(META_KEYS[family]), (key) => ({ [key]: values })),
  );

/** One annotated node: where in the decoded value it sits, and what it publishes. */
interface Found {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly meta: ErrorMeta;
}

// The AST an issue variant reports on, where it reports one. `MissingKey` /
// `InvalidValue` / `Forbidden` carry key- or issue-level annotations rather
// than a schema node, so they never publish `meta` themselves — a failure
// under them still inherits from an annotated ancestor.
const astOf = (issue: SchemaIssue.Issue): Option.Option<SchemaAST.AST> =>
  Match.value(issue).pipe(
    Match.tag("InvalidType", "UnexpectedKey", "Composite", "AnyOf", "Encoding", (issue) =>
      Option.some(issue.ast),
    ),
    Match.orElse(() => Option.none()),
  );

const collect = (
  issue: SchemaIssue.Issue,
  path: ReadonlyArray<PropertyKey>,
  found: Array<Found>,
): void => {
  const meta = Option.flatMap(astOf(issue), (ast) =>
    Option.flatMap(Option.fromUndefinedOr(ast.annotations), errorMetaOf),
  );
  if (Option.isSome(meta)) found.push({ path, meta: meta.value });
  Match.value(issue).pipe(
    Match.tag("Pointer", (issue) => collect(issue.issue, [...path, ...issue.path], found)),
    Match.tag("Filter", "Encoding", (issue) => collect(issue.issue, path, found)),
    Match.tag("Composite", "AnyOf", (issue) => {
      Arr.forEach(issue.issues, (child) => {
        collect(child, path, found);
      });
    }),
    Match.orElse(() => undefined),
  );
};

const isPrefix = (prefix: ReadonlyArray<PropertyKey>, path: ReadonlyArray<PropertyKey>): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);

/**
 * The `meta` a formatted leaf at `path` should carry: the annotation of the
 * nearest annotated node on the way down to it, `None` when there is
 * none. Build the index once per issue with {@link indexErrorMeta} and query
 * it per leaf.
 */
export const indexErrorMeta = (
  issue: SchemaIssue.Issue,
): ((path: ReadonlyArray<PropertyKey>) => Option.Option<ErrorMeta>) => {
  const found: Array<Found> = [];
  collect(issue, [], found);
  return (path) =>
    Option.map(
      Arr.reduce(found, Option.none<Found>(), (current, candidate) =>
        isPrefix(candidate.path, path) &&
        Option.match(current, {
          onNone: () => true,
          onSome: (current) => candidate.path.length >= current.path.length,
        })
          ? Option.some(candidate)
          : current,
      ),
      (best) => best.meta,
    );
};
