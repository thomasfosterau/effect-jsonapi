/**
 * Sparse fieldsets over a document as encoded (JSON:API 1.1 §Sparse
 * Fieldsets): an endpoint MUST NOT include fields the request's `fields[TYPE]`
 * excludes in resource objects of that type. The middleware applies or checks
 * them here, on the wire, whatever the handler returned.
 */
import * as Arr from "effect/Array";
import * as HashSet from "effect/HashSet";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import type * as Schema from "effect/Schema";
import { assign } from "./define.js";
import { isJsonObject } from "./linkage.js";

/** The request's fieldsets: each requested type's field names. */
export type Fieldsets = Readonly<Record<string, ReadonlyArray<string>>>;

/** A field of a resource object that the request's fieldset excludes. */
export interface ExcludedField {
  readonly type: string;
  readonly id: string;
  readonly field: string;
}

/** A document with its excluded fields removed, and the fields it removed. */
export interface Projection {
  readonly document: Schema.JsonObject;
  readonly excluded: ReadonlyArray<ExcludedField>;
}

const isJsonArray = (json: Schema.Json): json is Schema.JsonArray => Arr.isArray(json);

const keysOf = (object: R.ReadonlyRecord<string, Schema.Json>): ReadonlyArray<string> =>
  R.keys(object);

// A resource object's `type` or `id` as its label; any other value, absent
// included, as the empty string.
const label = (value: Schema.Json): string => (P.isString(value) ? value : "");

// The members of `object` that `keep` admits. An own `__proto__` member (as
// parsed JSON gives) stays a member.
const pick = (object: Schema.JsonObject, keep: (name: string) => boolean): Schema.JsonObject => {
  const kept: Record<string, Schema.Json> = {};
  Arr.forEach(keysOf(object), (name) => {
    const value = object[name];
    if (keep(name) && value !== undefined) assign(kept, name, value);
  });
  return kept;
};

// `object` with `changes` applied: a member set to `Some` replaced, one set
// to `None` removed.
const update = (
  object: Schema.JsonObject,
  changes: ReadonlyArray<readonly [string, Option.Option<Schema.Json>]>,
): Schema.JsonObject => {
  const changed: Record<string, Schema.Json> = {};
  Arr.forEach(keysOf(object), (name) => {
    const value = object[name];
    if (value !== undefined && !Arr.some(changes, ([member]) => member === name))
      assign(changed, name, value);
  });
  Arr.forEach(changes, ([name, value]) => {
    if (Option.isSome(value)) assign(changed, name, value.value);
  });
  return changed;
};

// One resource object projected to its type's fieldset. A `relationships`
// member left empty is omitted; `attributes` stays, possibly empty, as
// `Handlers.project` leaves it.
const projectResource = (
  resource: Schema.Json,
  fields: Fieldsets,
  excluded: Array<ExcludedField>,
): Schema.Json => {
  if (!isJsonObject(resource)) return resource;
  const type = label(resource["type"] ?? null);
  if (!Object.hasOwn(fields, type)) return resource;
  const requested = HashSet.fromIterable(fields[type] ?? []);
  const id = label(resource["id"] ?? resource["lid"] ?? null);
  const changes: Array<readonly [string, Option.Option<Schema.Json>]> = [];
  Arr.forEach(["attributes", "relationships"] as const, (member) => {
    const fieldsOfMember = resource[member];
    if (fieldsOfMember === undefined || !isJsonObject(fieldsOfMember)) return;
    const kept = pick(fieldsOfMember, (name) => HashSet.has(requested, name));
    Arr.forEach(keysOf(fieldsOfMember), (field) => {
      if (!HashSet.has(requested, field)) excluded.push({ type, id, field });
    });
    changes.push([
      member,
      member === "relationships" && Arr.isReadonlyArrayEmpty(keysOf(kept))
        ? Option.none()
        : Option.some(kept),
    ]);
  });
  return update(resource, changes);
};

const projectData = (
  data: Schema.Json,
  fields: Fieldsets,
  excluded: Array<ExcludedField>,
): Schema.Json =>
  isJsonArray(data)
    ? Arr.map(data, (resource) => projectResource(resource, fields, excluded))
    : projectResource(data, fields, excluded);

/**
 * `document`'s primary data and `included` projected to `fields`, with every
 * field it removed. `None` when it removed none, so a document that already
 * honours the fieldsets is left as it is.
 */
export const projectDocument = (
  document: Schema.JsonObject,
  fields: Fieldsets,
): Option.Option<Projection> => {
  if (!Arr.isReadonlyArrayNonEmpty(keysOf(fields))) return Option.none();
  const excluded: Array<ExcludedField> = [];
  const { data, included } = document;
  const projected = update(document, [
    ...(data === undefined
      ? []
      : [["data", Option.some(projectData(data, fields, excluded))] as const]),
    ...(included === undefined || !isJsonArray(included)
      ? []
      : [["included", Option.some(projectData(included, fields, excluded))] as const]),
  ]);
  return Arr.isReadonlyArrayNonEmpty(excluded)
    ? Option.some({ document: projected, excluded })
    : Option.none();
};
