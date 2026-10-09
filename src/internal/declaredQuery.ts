/**
 * The query parameter names an endpoint's query schema declares, read off its
 * encoded (flat, wire) side, and the decoded property each one feeds.
 *
 * The walk `Middleware`'s unknown-parameter check runs before an endpoint
 * decodes anything, and the one the conformance kit's discovery runs to find
 * the endpoints that do not declare a family — shared so the kit never probes
 * an endpoint for a parameter the middleware would let through to it.
 *
 * A query renamed on the wire (`Schema.encodeKeys`, and `Query.bracketKeys`
 * built on it) hides which decoded property each wire parameter feeds inside
 * an opaque transformation. `wireProperties` recovers it by running that
 * transformation on a probe, so the support check reads the property a
 * parameter actually decodes into and a rejected value's `source.parameter`
 * names the parameter the request sent (`queryLeaves`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import * as Result from "effect/Result";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaGetter from "effect/SchemaGetter";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * The wire names a query schema's encoded side declares, or none when that
 * side could accept a name this walk cannot enumerate — a record keyed by any
 * string, say. A union declares what any member declares, and a suspended
 * schema what its target declares. `filter: true`'s `filter[…]` rest is the
 * spec's own family and enumerable as such: it contributes its prefix,
 * `filter[`, which no property name ends with.
 *
 * @internal
 */
export const declaredNames = (ast: SchemaAST.AST): Option.Option<ReadonlyArray<string>> => {
  const encoded = SchemaAST.toEncoded(ast);
  if (SchemaAST.isObjects(encoded)) {
    return Option.map(
      Option.all(encoded.indexSignatures.map(({ parameter }) => familyPrefix(parameter))),
      (prefixes) => [
        ...encoded.propertySignatures.map((signature) => String(signature.name)),
        ...prefixes,
      ],
    );
  }
  if (SchemaAST.isUnion(encoded)) {
    return Option.map(Option.all(encoded.types.map(declaredNames)), Arr.flatten);
  }
  if (SchemaAST.isSuspend(encoded)) return declaredNames(encoded.thunk());
  return Option.none();
};

/**
 * The family an index signature's key admits, when it names one: a template
 * literal whose literal head opens the bracket after the base name (`filter[`).
 * Any other key could match a base name of any spelling.
 */
const familyPrefix = (parameter: SchemaAST.AST): Option.Option<string> => {
  if (!SchemaAST.isTemplateLiteral(parameter)) return Option.none();
  const [head] = parameter.parts;
  return head !== undefined &&
    SchemaAST.isLiteral(head) &&
    Predicate.isString(head.literal) &&
    head.literal.includes("[")
    ? Option.some(head.literal)
    : Option.none();
};

/**
 * One property of a struct's decoded side, with the name its encoded side
 * sends it under.
 *
 * @internal
 */
export interface WireProperty {
  /** The decoded property. */
  readonly property: SchemaAST.PropertySignature;
  /** The name the request carries it under. */
  readonly wire: string;
}

// A probe value per wire name: unique, and a string, as a query value is,
// so a transformation that reads its input as one still runs.
const sentinel = (index: number): string => `\u0000effect-jsonapi:probe:${index}`;

// Where a struct transformation's decode moves each wire property: run on a
// probe whose every wire name holds its own sentinel, a wire name goes to
// the one output key its sentinel lands on. A sentinel that lands nowhere
// (the value was rebuilt, nested or dropped) or on more than one key leaves
// its wire name out, and a decode that fails, dies, goes asynchronous or is
// no `Transformation` (a `Middleware`) leaves every one out. The decode is
// `effect`'s own getter: for `Schema.encodeKeys` it is
// `Struct.renameKeys`, which settles every rename, swaps and array-index
// names included.
const probe = (
  transformation: SchemaAST.Link["transformation"],
  wire: ReadonlyArray<string>,
): ReadonlyArray<readonly [wire: string, decoded: PropertyKey]> => {
  if (!SchemaTransformation.isTransformation(transformation)) return [];
  const input = Rec.fromEntries(Arr.map(wire, (name, index) => [name, sentinel(index)] as const));
  // Suspended, so a getter that throws while it runs dies inside the run
  // rather than out of this function.
  // SAFETY: the run provides no service; a getter that asks for one dies
  // looking it up, inside the run, and a failed run pairs nothing.
  const decode = Effect.suspend(() =>
    SchemaGetter.run(transformation.decode, Option.some(input), {}),
  ) as Effect.Effect<Option.Option<unknown>, SchemaIssue.Issue>;
  const output = Exit.match(Effect.runSyncExit(decode), {
    onFailure: () => Option.none<unknown>(),
    onSuccess: (decoded) => decoded,
  });
  return Option.match(Option.filter(output, Predicate.isObject), {
    onNone: () => [],
    onSome: (decoded) => {
      const landed = Arr.flatMap(Reflect.ownKeys(decoded), (key) =>
        Arr.filterMap(wire, (name, index) =>
          decoded[key] === sentinel(index) ? Result.succeed([name, key] as const) : Result.failVoid,
        ),
      );
      return Arr.filter(
        landed,
        ([name]) => Arr.filter(landed, ([other]) => other === name).length === 1,
      );
    },
  });
};

/**
 * The wire name of every property of a struct's decoded side that its
 * encoding settles, so a query renamed with `Schema.encodeKeys` (or
 * `Query.bracketKeys`, built on it) is read by the parameter a request
 * actually sends, never by a decoded name that may stand for another wire
 * parameter (a decoded `sort` sent as `include`).
 *
 * A struct with no encoding of its own pairs each property with its own
 * name. A struct decoded from another struct (`Schema.encodeKeys`, or any
 * `Schema.decodeTo` between two structs) is read by running that one
 * transformation's decode on a probe (`probe`): each wire property is paired
 * with the decoded property its value lands in, so a rename is read as the
 * rename it is and a passthrough between two structs that list the same
 * names in another order pairs each name with itself. Anything else (a
 * chain of more than one transformation, a source that is no plain struct,
 * a `Middleware`, a decode that fails on the probe, a value the
 * transformation rebuilds) pairs nothing it cannot show, and callers fall
 * back to reading the property by its name (#306's rule).
 *
 * The probe runs the schema's own decode, synchronously, outside any
 * request and with no service: a transformation with a side effect (a log,
 * say) has it run on sentinel values each time this is called, and one that
 * needs a service fails on the probe and so pairs nothing.
 *
 * @internal
 */
export const wireProperties = (ast: SchemaAST.Objects): ReadonlyArray<WireProperty> => {
  const names = (struct: SchemaAST.Objects) =>
    Arr.map(struct.propertySignatures, ({ name }) => String(name));
  const routes = Option.match(Option.fromNullishOr(ast.encoding), {
    onNone: () => Arr.map(ast.propertySignatures, ({ name }) => [String(name), name] as const),
    onSome: ([link, ...rest]) =>
      Arr.isReadonlyArrayEmpty(rest) &&
      SchemaAST.isObjects(link.to) &&
      link.to.encoding === undefined
        ? probe(link.transformation, names(link.to))
        : [],
  });
  return Arr.flatMap(routes, ([wire, name]) =>
    Arr.fromOption(
      Option.map(
        Arr.findFirst(ast.propertySignatures, (property) => property.name === name),
        (property) => ({ property, wire }),
      ),
    ),
  );
};

// The wire name a struct issue's property `key` was sent under, when the
// struct's encoding settles it: read off the issue's own schema, which is
// the side that rejected the value. A decoder that rebuilds the struct's
// encoded side (HttpApi lets an array decode from a single value) keeps its
// one transformation, which `wireProperties` runs.
const wireNameOf = (ast: SchemaAST.AST): ((key: PropertyKey) => Option.Option<string>) => {
  const settled = SchemaAST.isObjects(ast) ? wireProperties(ast) : [];
  return (key) =>
    Option.map(
      Arr.findFirst(settled, ({ property }) => property.name === key),
      ({ wire }) => wire,
    );
};

/**
 * One formatted leaf of a query issue: its message, the path it sits at in
 * the decoded value, and that path with each property named as the request
 * sent it.
 *
 * @internal
 */
export interface QueryLeaf {
  readonly message: string;
  readonly path: ReadonlyArray<PropertyKey>;
  readonly wire: ReadonlyArray<PropertyKey>;
}

const format = SchemaIssue.makeFormatterStandardSchemaV1();

// Where a leaf sits: in decoded names, and as the request spelled it.
interface At {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly wire: ReadonlyArray<PropertyKey>;
}

// A node the formatter does not walk through, formatted alone, its leaves'
// paths prefixed with where it sits.
const formatted = (issue: SchemaIssue.Issue, at: At): ReadonlyArray<QueryLeaf> =>
  Arr.map(format(issue).issues, (leaf) => {
    const below = Arr.map(leaf.path ?? [], (segment) =>
      Predicate.isPropertyKey(segment) ? segment : segment.key,
    );
    return { message: leaf.message, path: [...at.path, ...below], wire: [...at.wire, ...below] };
  });

// Whether the formatter walks through a failed check to the issue it
// carries, as it does when the check names no message of its own and its
// issue is no bare value (a struct check's `{ path, issue }` is a pointer).
const walksThrough = (filter: SchemaIssue.Filter): boolean =>
  SchemaIssue.defaultCheckHook(filter) === undefined && filter.issue._tag !== "InvalidValue";

// `SchemaIssue.makeFormatterStandardSchemaV1`'s own walk, which extends the
// path only through a pointer, an encoding, a composite, a non-empty union
// and a check it `walksThrough`: every other node is `formatted` alone. A
// struct's property issue is a pointer under the struct's composite, either
// directly or under a check on the struct that points at the property (a
// `Schema.makeFilter` returning `{ path, issue }`, or several of them, which
// the check carries as a composite of pointers on the same struct). Either
// way the pointer's first key is the struct's property, named on the wire by
// `wireNameOf` the composite's AST: a struct's issue reports its decoded
// side's AST when the decoded side rejected the value, under decoded names,
// and its encoded side's AST when the wire value was rejected before any
// rename, under wire names. A check met anywhere else is `formatted` alone,
// as the formatter would render it, in the names the issue reports.
const leavesOf = (issue: SchemaIssue.Issue, at: At): ReadonlyArray<QueryLeaf> =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) =>
      leavesOf(pointer.issue, {
        path: [...at.path, ...pointer.path],
        wire: [...at.wire, ...pointer.path],
      }),
    ),
    Match.tag("Encoding", (encoding) => leavesOf(encoding.issue, at)),
    Match.tag("Composite", (composite) => {
      const wireName = wireNameOf(composite.ast);
      const enter = (child: SchemaIssue.Issue): ReadonlyArray<QueryLeaf> =>
        Match.value(child).pipe(
          Match.tag("Pointer", (pointer) => {
            const [key, ...rest] = pointer.path;
            const sent = key === undefined ? [] : [Option.getOrElse(wireName(key), () => key)];
            return leavesOf(pointer.issue, {
              path: [...at.path, ...pointer.path],
              wire: [...at.wire, ...sent, ...rest],
            });
          }),
          Match.tag("Filter", (filter) =>
            walksThrough(filter) ? enter(filter.issue) : formatted(filter, at),
          ),
          Match.orElse((other) => leavesOf(other, at)),
        );
      return Arr.flatMap(composite.issues, enter);
    }),
    Match.tag("AnyOf", (anyOf) =>
      Arr.match(anyOf.issues, {
        onEmpty: () => formatted(anyOf, at),
        onNonEmpty: (issues) => Arr.flatMap(issues, (child) => leavesOf(child, at)),
      }),
    ),
    Match.orElse((other) => formatted(other, at)),
  );

/**
 * The formatted leaves of a query's decode failure, as
 * `SchemaIssue.makeFormatterStandardSchemaV1` gives them, each with its path
 * in wire names too: a property a struct's encoding renames
 * (`Schema.encodeKeys`, `Query.bracketKeys`) is reported under its decoded
 * name when its decoded side rejected it, which names no parameter the
 * request carries. Each place a leaf's path enters a struct's property takes
 * the wire name `wireProperties` settles for it, read off the issue's own
 * schema; one it does not settle keeps its reported name.
 *
 * @internal
 */
export const queryLeaves = (issue: SchemaIssue.Issue): ReadonlyArray<QueryLeaf> =>
  leavesOf(issue, { path: [], wire: [] });
