/**
 * Effect Schema helpers with no JSON:API dependency of their own that
 * `@thomasfosterau/effect-ext` does not publish with the same behaviour (#552).
 *
 * `suppliedValue` and `pathToJsonPointer` moved to effect-ext's `TriState` and
 * `Issues` subpaths, and `FlatQuery.suppliedValue` / `ServerErrors.pathToJsonPointer`
 * re-export them, and the issue walk behind `ServerErrors.schemaIssueToErrors`
 * is effect-ext's `Issues.leaves` / `Issues.message` since 0.2.0 (#555). What
 * stays here is `closedStruct`, with its cap helpers: effect-ext has no
 * equivalent. It is used only inside the library's own request-body schemas
 * and the closed identifier of `Endpoint.CommittedDocument`.
 *
 * @internal
 */
// The bare `effect` barrel: the schema-only entry point reaches this module,
// and `test/entry-points.test.ts` pins `effect` as its only external.
import * as MutableHashSet from "effect/MutableHashSet";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";
import { tryStringify } from "./json.js";
import { declarationError } from "./errors.js";

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
  if (P.isNumber(cap) && (cap === Number.POSITIVE_INFINITY || (Number.isInteger(cap) && cap > 0))) {
    return cap;
  }
  throw declarationError(
    `${where}: maxUndeclaredMemberErrors must be a positive integer or Infinity, got ${showValue(cap)}`,
  );
};

// A number prints with `String` (`NaN`, `-Infinity`, `1.5`), anything else
// with `JSON.stringify` (`"12"`, `true`), or `String` again for a value JSON
// writes as nothing (a symbol, a function).
const showValue = (value: number): string =>
  P.isNumber(value) ? String(value) : Option.getOrElse(tryStringify(value), () => String(value));

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
// It reads the enumerable own string keys (`R.keys`), then the enumerable
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
// not-nullish check); `P.isObject` is the test a struct with fields
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
const noMembers = (declared: MutableHashSet.MutableHashSet<PropertyKey>, cap: number) =>
  // oxlint-disable-next-line effect/require-filter-metadata -- see above: this check must stay anonymous in consumers' OpenAPI
  Schema.makeFilter<unknown>(
    (input, ast, options) => {
      if (!P.isObject(input)) return "Expected object";
      const undeclared: Array<PropertyKey> = [
        ...Arr.filter(R.keys(input), (key) => !MutableHashSet.has(declared, key)),
        ...Arr.filter(
          Object.getOwnPropertySymbols(input),
          (key) =>
            !MutableHashSet.has(declared, key) &&
            Object.prototype.propertyIsEnumerable.call(input, key),
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
        MutableHashSet.size(declared) === 0 ? { type: "object", additionalProperties: false } : {},
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
  const struct = R.isEmptyReadonlyRecord(fields)
    ? Schema.Struct<Fields>(fields).annotate(nullAsObject)
    : Schema.Struct(fields);
  const { ast } = struct;
  // A `MutableHashSet`, not a `HashSet`: the lookup runs per key, twice per
  // parse of every write body, and `HashSet.has` made a 10-field decode ~45%
  // slower. A mutable set keeps its keys in a native `Map`, which a string or
  // symbol key is looked up in directly.
  const checks = [noMembers(MutableHashSet.fromIterable(Reflect.ownKeys(fields)), cap)] as const;
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
