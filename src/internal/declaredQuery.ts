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
 * an opaque transformation. `wireProperties` recovers it from the schema's
 * structure, so the support check reads the property a parameter actually
 * decodes into and a rejected value's `source.parameter` names the
 * parameter the request sent (`queryLeaves`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaIssue from "effect/SchemaIssue";

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

// A name whose place in an object's key order is not where it was written:
// an array index sorts first and a symbol last, so a rename to or from one
// can reorder the encoded struct against the decoded one.
const keepsItsPlace = (signature: SchemaAST.PropertySignature): boolean =>
  Predicate.isString(signature.name) && !/^\d+$/.test(signature.name);

/**
 * The wire name of every property of a struct's decoded side that its
 * encoding settles, so a query renamed with `Schema.encodeKeys` (or
 * `Query.bracketKeys`, built on it) is read by the parameter a request
 * actually sends, never by a decoded name that may stand for another wire
 * parameter (a decoded `sort` sent as `include`).
 *
 * `Schema.encodeKeys` builds the encoded struct from `Schema.toEncoded` of
 * each field, in the decoded struct's own field order, and
 * `SchemaAST.toEncoded` is memoised by identity: the encoded property at a
 * given place carries the very AST `toEncoded` gives the decoded property at
 * that place. So when every place pairs up that way, the struct is read
 * place by place, which settles even two properties whose codecs encode to
 * one shared AST (`Schema.String`). Otherwise a wire property is paired with
 * the one decoded property whose encoded AST it carries, when exactly one
 * does and no other wire property carries it too. A property neither rule
 * pairs is left out: the AST does not say where it goes. A struct no
 * encoding renames pairs each property with its own name.
 *
 * @internal
 */
export const wireProperties = (ast: SchemaAST.Objects): ReadonlyArray<WireProperty> => {
  const encoded = SchemaAST.toEncoded(ast);
  if (!SchemaAST.isObjects(encoded)) return [];
  const decoded = Arr.map(ast.propertySignatures, (property) => ({
    property,
    encoded: SchemaAST.toEncoded(property.type),
  }));
  const wire = encoded.propertySignatures;
  const pair = (property: SchemaAST.PropertySignature, signature: SchemaAST.PropertySignature) => ({
    property,
    wire: String(signature.name),
  });
  const inPlace =
    decoded.length === wire.length &&
    Arr.every(ast.propertySignatures, keepsItsPlace) &&
    Arr.every(wire, keepsItsPlace) &&
    Arr.every(wire, (signature, index) => decoded[index]?.encoded === signature.type);
  if (inPlace)
    return Arr.zipWith(decoded, wire, ({ property }, signature) => pair(property, signature));
  return Arr.flatMap(wire, (signature) => {
    const carriers = Arr.filter(decoded, ({ encoded }) => encoded === signature.type);
    const sharers = Arr.filter(wire, (other) => other.type === signature.type);
    return carriers.length === 1 && sharers.length === 1
      ? Arr.map(carriers, ({ property }) => pair(property, signature))
      : [];
  });
};

// The structs a query schema decodes its parameters with: the query itself,
// every member of a union, and the target of a suspended schema, once.
const structsOf = (
  ast: SchemaAST.AST,
  visiting: ReadonlyArray<SchemaAST.AST>,
): ReadonlyArray<SchemaAST.Objects> => {
  if (SchemaAST.isObjects(ast)) return [ast];
  if (SchemaAST.isUnion(ast))
    return Arr.flatMap(ast.types, (member) => structsOf(member, visiting));
  if (SchemaAST.isSuspend(ast) && !visiting.includes(ast)) {
    return structsOf(ast.thunk(), [...visiting, ast]);
  }
  return [];
};

// The wire name a struct issue's property `key` was sent under, when the
// struct's encoding settles it. `known` pairs each property of the query the
// request was decoded with: a decoder may rebuild a struct's encoded side
// (HttpApi lets an array decode from a single value), which loses the
// identities `wireProperties` reads, but it keeps the decoded side's
// property signatures. Otherwise the issue's own schema is read.
const wireNameOf =
  (ast: SchemaAST.AST, known: ReadonlyArray<WireProperty>) =>
  (key: PropertyKey): Option.Option<string> => {
    if (!SchemaAST.isObjects(ast)) return Option.none();
    const pairedWith = (properties: ReadonlyArray<WireProperty>) =>
      Option.map(
        Arr.findFirst(properties, ({ property }) => property.name === key),
        ({ wire }) => wire,
      );
    return Option.orElse(
      pairedWith(Arr.filter(known, ({ property }) => ast.propertySignatures.includes(property))),
      () => pairedWith(wireProperties(ast)),
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

// `SchemaIssue.makeFormatterStandardSchemaV1`'s own walk, which extends the
// path only through a pointer, an encoding, a composite and a non-empty
// union: every other node is `formatted` alone. A struct's issue reports its
// decoded side's AST when the decoded side rejected the value, under decoded
// names, and its encoded side's AST when the wire value was rejected before
// any rename, under wire names: either way `wireNameOf` that AST names the
// wire.
const leavesOf = (
  issue: SchemaIssue.Issue,
  at: At,
  known: ReadonlyArray<WireProperty>,
): ReadonlyArray<QueryLeaf> =>
  Match.value(issue).pipe(
    Match.tag("Pointer", (pointer) =>
      leavesOf(
        pointer.issue,
        { path: [...at.path, ...pointer.path], wire: [...at.wire, ...pointer.path] },
        known,
      ),
    ),
    Match.tag("Encoding", (encoding) => leavesOf(encoding.issue, at, known)),
    Match.tag("Composite", (composite) => {
      const wireName = wireNameOf(composite.ast, known);
      return Arr.flatMap(composite.issues, (child) =>
        Match.value(child).pipe(
          Match.tag("Pointer", (pointer) => {
            const [key, ...rest] = pointer.path;
            const sent = key === undefined ? [] : [Option.getOrElse(wireName(key), () => key)];
            return leavesOf(
              pointer.issue,
              { path: [...at.path, ...pointer.path], wire: [...at.wire, ...sent, ...rest] },
              known,
            );
          }),
          Match.orElse((other) => leavesOf(other, at, known)),
        ),
      );
    }),
    Match.tag("AnyOf", (anyOf) =>
      Arr.match(anyOf.issues, {
        onEmpty: () => formatted(anyOf, at),
        onNonEmpty: (issues) => Arr.flatMap(issues, (child) => leavesOf(child, at, known)),
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
 * the wire name `wireProperties` settles for it, read off `query` (the
 * schema the request was decoded with) when there is one, else off the
 * issue's own schema; one it does not settle keeps its reported name.
 *
 * @internal
 */
export const queryLeaves = (
  issue: SchemaIssue.Issue,
  query: Option.Option<SchemaAST.AST>,
): ReadonlyArray<QueryLeaf> =>
  leavesOf(
    issue,
    { path: [], wire: [] },
    Arr.flatMap(
      Option.match(query, { onNone: () => [], onSome: (ast) => structsOf(ast, []) }),
      wireProperties,
    ),
  );
