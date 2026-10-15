/**
 * Pure Effect Schema helpers with no JSON:API dependency of their own.
 *
 * **Moves to `@thomasfosterau/effect-schema-ext`** (effect-schema-ext#1) once
 * that package publishes; this module is the interim home so nothing here
 * depends on an unpublished package. Everything public is re-exported from a
 * public module (`ServerErrors.pathToJsonPointer`, `FlatQuery.suppliedValue`)
 * so the move is an import change, not an API change; `closedStruct` is used
 * only inside the library's own request-body schemas and the closed
 * identifier of `Endpoint.CommittedDocument`.
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
  SchemaAST,
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

/**
 * How many undeclared members a closed struct reports at their own paths
 * before it summarises the rest in one issue at the struct (#308).
 */
export const defaultMaxUndeclaredMemberErrors = 12;

/**
 * Validates a `maxUndeclaredMemberErrors` value: a positive integer, or
 * `Infinity` for no cap. Zero would report a summary with no member beside
 * it, and a fraction, a negative number, `NaN` or a non-number (from a caller
 * the types don't check) no count at all, so each throws, naming `where`
 * (`Resource.make("notes")`) and the value: a number with `String`, anything
 * else with `JSON.stringify`.
 */
export const validateMaxUndeclaredMemberErrors = (where: string, cap: number): number => {
  if (
    Predicate.isNumber(cap) &&
    (cap === Number.POSITIVE_INFINITY || (Number.isInteger(cap) && cap > 0))
  ) {
    return cap;
  }
  throw new Error(
    `${where}: maxUndeclaredMemberErrors must be a positive integer or Infinity, got ${showValue(cap)}`,
  );
};

// A number prints with `String` (`NaN`, `-Infinity`, `1.5`), anything else
// with `JSON.stringify` (`"12"`, `true`), or `String` again for a value JSON
// writes as nothing (a symbol, a function).
const showValue = (value: number): string =>
  Predicate.isNumber(value)
    ? String(value)
    : // oxlint-disable-next-line effect/avoid-direct-json -- a diagnostic rendering of an arbitrary value, not a wire boundary
      (JSON.stringify(value) ?? String(value));

// The summary issue's message: "9988 more undeclared members not listed". The
// count is plain digits (`String`), so a response body never depends on the
// host's locale.
const moreUndeclared = (count: number): string =>
  `${String(count)} more undeclared member${count === 1 ? "" : "s"} not listed`;

// Rejects every enumerable own key of an object outside `declared`. The first
// `cap` of them are reported each as an `UnexpectedKey` at its own path: the
// issue `onExcessProperty: "error"` reports, so the `SchemaErrors` middleware
// renders it unchanged ("Expected no excess property"). Any beyond the cap are
// counted, not reported: one `InvalidValue` at the struct itself says how many
// more there are (#308), so the issues, and the 400 a server renders from
// them, stay bounded however many keys a request sends. The keys are still
// all read, so the count is exact; only the issues are capped.
// It reads the enumerable own string keys (`Record.keys`), then the enumerable
// own symbol keys, which is the order `Reflect.ownKeys` gives, at a fraction of
// its cost. So a symbol key counts too, and an own `__proto__` / `constructor`
// (`JSON.parse` makes both) is rejected like any other name. A non-enumerable
// key is let through, as effect's own `onExcessProperty: "error"` lets it
// through ("only enumerable own properties can be excess"); `JSON.parse` never
// makes one. `declared` is a native `Set`, read once per key: the check runs
// twice per parse (see `closedStruct`), on every write body.
// A non-object is answered first, the way a struct with fields answers it:
// "Expected object" at the member itself. Only a struct that declares no
// fields lets one through to here (in the pinned effect it is a bare
// not-nullish check); `Predicate.isObject` is the test a struct with fields
// applies (`typeof "object"`, not `null`, not an array).
// The keys are grouped under a `Composite` on `Schema.Unknown`'s AST, not on
// the struct's: a formatter reads a `message` annotation on a check's issue as
// the whole check's message, so grouping them on the empty struct (which
// carries `nullAsObject`, below) would collapse every key into one "Expected
// object" at the member.
// JSON Schema: a struct with fields already renders `additionalProperties:
// false` in an OpenAPI document (effect generates it with `onExcessProperty:
// "error"`), so this check adds nothing there and the member's properties are
// rendered exactly as before. A struct with no fields renders only `{ not:
// { type: "null" } }`, so for it the check describes the closed object.
// No `identifier` / `title` / `description`: an identifier makes each site a
// named component (`noMembers`, `noMembers_1`, …) in every consumer's OpenAPI
// document and renders a `null` member as "Expected <identifier>", and a title
// or description would be copied into that document too.
const noMembers = (declared: ReadonlySet<PropertyKey>, cap: number) =>
  // oxlint-disable-next-line effect/require-filter-metadata -- see above: this check must stay anonymous in consumers' OpenAPI
  Schema.makeFilter<unknown>(
    (input, ast, options) => {
      if (!Predicate.isObject(input)) return "Expected object";
      const undeclared: Array<PropertyKey> = [
        ...Arr.filter(Rec.keys(input), (key) => !declared.has(key)),
        ...Arr.filter(
          Object.getOwnPropertySymbols(input),
          (key) => !declared.has(key) && Object.prototype.propertyIsEnumerable.call(input, key),
        ),
      ];
      if (!Arr.isReadonlyArrayNonEmpty(undeclared)) return true;
      const reported: Array<SchemaIssue.Issue> = Arr.map(
        Arr.take(undeclared, cap),
        (key) =>
          new SchemaIssue.Pointer(
            [key],
            new SchemaIssue.UnexpectedKey(ast, Object.getOwnPropertyDescriptor(input, key)?.value),
          ),
      );
      const more = undeclared.length - reported.length;
      return new SchemaIssue.Composite(
        Schema.Unknown.ast,
        Arr.isReadonlyArrayNonEmpty(reported) && more === 0
          ? reported
          : Arr.append(
              reported,
              new SchemaIssue.InvalidValue({ message: moreUndeclared(more) }, input, options),
            ),
        input,
        options,
      );
    },
    {
      toJsonSchema: () =>
        declared.size === 0 ? { type: "object", additionalProperties: false } : {},
    },
  );

// A `null` never reaches `noMembers` on a struct with no fields: its own
// not-nullish check rejects it first, as an `InvalidType` whose text comes from
// `SchemaAST.Objects#getExpected`, which is "object | array" for a struct with
// no fields ("object" for one with fields). The default formatters read a
// `message` annotation on that issue's AST before the expected text, so this
// one renders the `null` the way a struct with fields does (#286). Unlike an
// `identifier`, a `message` names no OpenAPI component and is not copied into
// the JSON Schema, and it changes no parse: only the text of that issue.
const nullAsObject = { message: "Expected object" } as const;

/**
 * `Schema.Struct(fields)`, closed: a member of its input that `fields` doesn't
 * declare is rejected, each of the first `cap` as an `UnexpectedKey` issue at
 * that member's path ("Expected no excess property"), and any beyond them by one
 * `InvalidValue` at the struct ("9988 more undeclared members not listed"). A
 * non-object, an array or a `null` is rejected at its own path ("Expected
 * object"). The result is still a
 * `Schema.Struct`: its `fields`, its `Type` / `Encoded`, the JSON Schema /
 * OpenAPI it renders and how it decodes a declared member are unchanged.
 *
 * In the pinned `effect`, a struct **with** fields drops the input keys it
 * doesn't declare while it parses, so a check (which runs on the parsed
 * output) never sees them; a struct with **no** fields is a bare not-nullish
 * check that returns its input unchanged, so every key would reach the
 * decoded value although its type is `{}`. Parse options can't close a single
 * struct (`onExcessProperty` applies to every struct in the payload). So the
 * key check is attached twice: as a check, and as an **encoding check**, which
 * the parser runs on a node's raw input once that node has parsed. Decoding
 * runs the encoding check, encoding (`SchemaAST.flip` swaps the two lists)
 * runs the check, so both directions reject an undeclared member: a server
 * decoding a request body, and a client encoding one.
 *
 * What that ordering means for the issues reported:
 * - The first `cap` undeclared members of one struct are reported, each as
 *   its own issue, and the rest by one summary issue at the struct, whatever
 *   the `errors` parse option says (#308). `cap` is a positive integer or
 *   `Infinity` (every member reported, the summary never). It is required,
 *   so no write body member can silently fall back to a default its resource
 *   doesn't carry; the caller resolves it ({@link defaultMaxUndeclaredMemberErrors}
 *   when none is configured) and validates it
 *   ({@link validateMaxUndeclaredMemberErrors}).
 * - The encoding check runs only once the node has parsed. So when a declared
 *   field fails (a wrong type, a missing required key), only that field is
 *   reported, and the undeclared members beside it are not, even with
 *   `errors: "all"`.
 * - `Schema.is(struct)` and `struct.make` validate the type side. A struct
 *   with fields drops an undeclared member there before the check sees it, so
 *   `Schema.is` answers `true` for a value with one and `make` strips it. A
 *   struct with no fields keeps it, so `Schema.is` answers `false` and `make`
 *   throws.
 *
 * Deriving a new struct (`mapFields`, `Struct.pick`, …) builds a plain one
 * from the fields, without the check.
 */
export const closedStruct = <const Fields extends Schema.Struct.Fields>(
  fields: Fields,
  cap: number,
): Schema.Struct<Fields> => {
  const struct = Rec.isEmptyReadonlyRecord(fields)
    ? Schema.Struct<Fields>(fields).annotate(nullAsObject)
    : Schema.Struct(fields);
  const { ast } = struct;
  // A native `Set`, not a `HashSet`: the lookup runs per key, twice per parse
  // of every write body, and `HashSet.has` made a 10-field decode ~45% slower.
  // oxlint-disable-next-line effect/avoid-native-object-helpers -- hot-path lookup, see above
  const checks = [noMembers(new Set(Reflect.ownKeys(fields)), cap)] as const;
  return struct.rebuild(
    new SchemaAST.Objects(
      ast.propertySignatures,
      ast.indexSignatures,
      ast.annotations,
      checks,
      ast.encoding,
      ast.context,
      checks,
    ),
  );
};
