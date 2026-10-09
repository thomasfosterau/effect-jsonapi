/**
 * The query parameter names an endpoint's query schema declares, read off its
 * encoded (flat, wire) side.
 *
 * The walk `Middleware`'s unknown-parameter check runs before an endpoint
 * decodes anything, and the one the conformance kit's discovery runs to find
 * the endpoints that do not declare a family — shared so the kit never probes
 * an endpoint for a parameter the middleware would let through to it.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as SchemaAST from "effect/SchemaAST";

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
