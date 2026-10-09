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
 * an opaque transformation. `wireProperties` recovers it, where it can show
 * it, by running that transformation on probes, so the support check reads
 * the property a parameter actually decodes into and a rejected value's
 * `source.parameter` names the parameter the request sent (`queryLeaves`).
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
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

// The context a probe runs in: it provides no service, so a getter that asks
// for one dies looking it up, inside the run, and a failed run pairs nothing.
const noServices = Context.makeUnsafe<unknown>(Context.empty().mapUnsafe);

// What a struct transformation's decode makes of a probe that holds the
// given wire names, each with its own sentinel: the own properties of the
// object it decodes to, or none when it fails, dies or goes asynchronous, or
// decodes to no object.
// Suspended, so a getter that throws while it runs dies inside the run
// rather than out of this function. A run that goes asynchronous leaves its
// fiber behind (`runSyncExitWith` answers `AsyncFiberError` and stops
// there), so that fiber is interrupted, never left to run the rest of the
// decode on sentinel values later.
const decodeProbe = (
  transformation: SchemaTransformation.Transformation<unknown, unknown, unknown, unknown>,
  entries: ReadonlyArray<readonly [name: string, index: number]>,
): Option.Option<ReadonlyArray<readonly [key: PropertyKey, value: unknown]>> => {
  const input = Rec.fromEntries(
    Arr.map(entries, ([name, index]) => [name, sentinel(index)] as const),
  );
  const decode = Effect.suspend(() =>
    SchemaGetter.run(transformation.decode, Option.some(input), {}),
  );
  const output = Exit.match(Effect.runSyncExitWith(noServices)(decode), {
    onFailure: (cause) => {
      const defect = Cause.squash(cause);
      if (Cause.isAsyncFiberError(defect)) defect.fiber.interruptUnsafe();
      return Option.none<unknown>();
    },
    onSuccess: (decoded) => decoded,
  });
  return Option.map(Option.filter(output, Predicate.isObject), (decoded) =>
    Arr.map(Reflect.ownKeys(decoded), (key) => [key, decoded[key]] as const),
  );
};

// The keys of a decoded probe that hold wire name `index`'s sentinel.
const landing = (
  decoded: ReadonlyArray<readonly [key: PropertyKey, value: unknown]>,
  index: number,
): ReadonlyArray<PropertyKey> =>
  Arr.filterMap(decoded, ([key, value]) =>
    value === sentinel(index) ? Result.succeed(key) : Result.failVoid,
  );

// The one key a decoded probe lands wire name `index`'s sentinel on, if it
// lands it on exactly one.
const landsOn = (
  decoded: ReadonlyArray<readonly [key: PropertyKey, value: unknown]>,
  index: number,
): Option.Option<PropertyKey> => {
  const [key, ...more] = landing(decoded, index);
  return key !== undefined && Arr.isReadonlyArrayEmpty(more) ? Option.some(key) : Option.none();
};

// Where a struct transformation's decode moves each wire property. It runs
// the decode on a full probe, every wire name holding its own sentinel, and
// on a solo probe per wire name, that name alone. A wire name is paired with
// a decoded key only when its sentinel lands on that one key in both its
// solo probe and the full one, and no other wire name's solo probe reaches
// the key: puts any value on it, or fails, and so could. A decode whose
// output at a key depends on which names are present (`include ?? inc`) is
// read as the rename it is only when each name stays on its own key. A
// sentinel that lands nowhere (the value was rebuilt, nested or dropped) or
// on more than one key pairs nothing, and a full probe that fails, dies,
// goes asynchronous or is no `Transformation` (a `Middleware`) pairs nothing
// at all. For `Schema.encodeKeys` the decode is `Struct.renameKeys`, which
// settles every rename, swaps and array-index names included.
const probe = (
  transformation: SchemaAST.Link["transformation"],
  wire: ReadonlyArray<string>,
): ReadonlyArray<readonly [wire: string, decoded: PropertyKey]> => {
  if (!SchemaTransformation.isTransformation(transformation)) return [];
  return Option.match(
    decodeProbe(
      transformation,
      Arr.map(wire, (name, index) => [name, index] as const),
    ),
    {
      onNone: () => [],
      onSome: (full) => {
        const solos = Arr.map(wire, (name, index) => ({
          name,
          index,
          decoded: decodeProbe(transformation, [[name, index]]),
        }));
        // Whether a solo probe could put a value on `key`: it did, or it
        // failed, and so shows nothing.
        const reaches = (
          solo: Option.Option<ReadonlyArray<readonly [key: PropertyKey, value: unknown]>>,
          key: PropertyKey,
        ): boolean =>
          Option.match(solo, {
            onNone: () => true,
            onSome: (decoded) =>
              Arr.some(decoded, ([other, value]) => other === key && value !== undefined),
          });
        return Arr.filterMap(solos, ({ name, index, decoded }) =>
          Option.match(
            Option.filter(
              landsOn(full, index),
              (key) =>
                Option.exists(decoded, (solo) => Option.contains(landsOn(solo, index), key)) &&
                !Arr.some(solos, (other) => other.index !== index && reaches(other.decoded, key)),
            ),
            {
              onNone: () => Result.failVoid,
              onSome: (key) => Result.succeed([name, key] as const),
            },
          ),
        );
      },
    },
  );
};

// The pairings `wireProperties` settles, per struct AST. HttpApi builds an
// endpoint's codecs once, so a struct's AST outlives the requests it
// rejects, and the probe (the schema's own decode) runs once per struct
// rather than once per rejected request.
const settledByStruct = new WeakMap<SchemaAST.Objects, ReadonlyArray<WireProperty>>();

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
 * transformation's decode on probes (`probe`): on every wire property at
 * once, and on each alone. A wire property is paired with a decoded property
 * when its value lands in that property, and only there, both alone and
 * among the rest, and no other wire property alone puts a value there. So a
 * rename is read as the rename it is, and a passthrough between two structs
 * that list the same names in another order pairs each name with itself,
 * while a decoded property that more than one wire property can fill
 * (`include ?? inc`) is paired with none of them. Anything else (a chain of
 * more than one transformation, a source that is no plain struct, a
 * `Middleware`, a decode that fails on a probe, a value the transformation
 * rebuilds) pairs nothing it cannot show, and callers fall back to reading
 * the property by its name (#306's rule).
 *
 * The probes run the schema's own decode, synchronously, outside any request
 * and with no service, once per struct AST (the result is cached): a
 * transformation with a side effect (a log, say) has it run on sentinel
 * values, one that needs a service fails on the probe and so pairs nothing,
 * and one that goes asynchronous is interrupted and pairs nothing.
 *
 * @internal
 */
export const wireProperties = (ast: SchemaAST.Objects): ReadonlyArray<WireProperty> => {
  const cached = settledByStruct.get(ast);
  if (cached !== undefined) return cached;
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
  const settled = Arr.flatMap(routes, ([wire, name]) =>
    Arr.fromOption(
      Option.map(
        Arr.findFirst(ast.propertySignatures, (property) => property.name === name),
        (property) => ({ property, wire }),
      ),
    ),
  );
  settledByStruct.set(ast, settled);
  return settled;
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
