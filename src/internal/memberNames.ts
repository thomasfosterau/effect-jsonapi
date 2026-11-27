/**
 * Member-name formatting: the presets that turn a TypeScript key into the name
 * a resource's member carries on the wire, at runtime and at the type level,
 * so the two always agree.
 *
 * @internal
 */
import * as Arr from "effect/Array";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as R from "effect/Record";
import { declarationError } from "./errors.js";
import { render } from "./json.js";
import { isMemberName } from "./memberName.js";

/**
 * How a resource's member names are formatted on the wire: a preset, an
 * explicit record from key to wire name (keys it omits keep their name), or a
 * function from key to wire name.
 */
export type MemberNames =
  | "camel"
  | "kebab"
  | "snake"
  | { readonly [key: string]: string }
  | ((key: string) => string);

// An upper-case letter: one `toLowerCase` changes, `toUpperCase` doesn't.
const isUpper = (c: string): boolean => c !== c.toLowerCase() && c === c.toUpperCase();

// Lower-cases each upper-case letter, putting `separator` before it unless it
// starts the key, and turns the other separator into this one.
const separated =
  (separator: "-" | "_", other: "-" | "_") =>
  (key: string): string =>
    Arr.map(Arr.fromIterable(key), (c, i) =>
      c === other ? separator : isUpper(c) ? `${i === 0 ? "" : separator}${c.toLowerCase()}` : c,
    ).join("");

// `createdAt` / `created_at` → `created-at`.
const kebab: (key: string) => string = separated("-", "_");

// `createdAt` / `created-at` → `created_at`.
const snake: (key: string) => string = separated("_", "-");

// `created-at` / `created_at` → `createdAt`.
const camel = (key: string): string => key.replace(/[-_](.)/gu, (_, c: string) => c.toUpperCase());

// The type-level mirrors of the presets, character by character.
type Separated<
  S extends string,
  Sep extends string,
  Other extends string,
  First extends boolean = true,
> = S extends `${infer C}${infer Rest}`
  ? `${C extends Other
      ? Sep
      : Uppercase<C> extends C
        ? Lowercase<C> extends C
          ? C
          : `${First extends true ? "" : Sep}${Lowercase<C>}`
        : C}${Separated<Rest, Sep, Other, false>}`
  : S;

/** The `"kebab"` preset on a literal key. */
export type Kebab<S extends string> = Separated<S, "-", "_">;

/** The `"snake"` preset on a literal key. */
export type Snake<S extends string> = Separated<S, "_", "-">;

/** The `"camel"` preset on a literal key. */
export type Camel<S extends string> = S extends `${infer Head}${"-" | "_"}${infer C}${infer Rest}`
  ? `${Head}${Uppercase<C>}${Camel<Rest>}`
  : S;

/** The wire name a {@link MemberNames} gives key `K`, at the type level. */
export type WireName<K extends string, Names> = [Names] extends [never]
  ? K
  : Names extends "kebab"
    ? Kebab<K>
    : Names extends "snake"
      ? Snake<K>
      : Names extends "camel"
        ? Camel<K>
        : Names extends (key: string) => string
          ? string
          : Names extends { readonly [key: string]: string }
            ? K extends keyof Names
              ? Names[K] & string
              : K
            : K;

/** The wire name a {@link MemberNames} gives one key, at runtime. */
export const wireName = (names: Option.Option<MemberNames>, key: string): string =>
  Option.match(names, {
    onNone: () => key,
    onSome: (format) => {
      if (format === "kebab") return kebab(key);
      if (format === "snake") return snake(key);
      if (format === "camel") return camel(key);
      if (P.isFunction(format)) return format(key);
      return Option.getOrElse(R.get(format, key), () => key);
    },
  });

/**
 * The wire name of each key, checked: each must be a legal member name, none
 * may be `type` or `id`, and no two keys may share one. `context` names the
 * declaration in the message. Returns only the keys whose name changes.
 */
export const resolveWireNames = (
  context: string,
  names: Option.Option<MemberNames>,
  keys: ReadonlyArray<string>,
): R.ReadonlyRecord<string, string> => {
  if (Option.isNone(names)) return {};
  const format = names.value;
  if (P.isObject(format) && !P.isFunction(format)) {
    const unknown = R.keys(format).filter((key) => !keys.includes(key));
    if (Arr.isArrayNonEmpty(unknown)) {
      throw declarationError(
        `${context}: memberNames names ${unknown.map((key) => render(key)).join(", ")}, which the resource does not declare`,
      );
    }
  }
  const seen = MutableHashMap.empty<string, string>();
  const changed: Record<string, string> = {};
  Arr.forEach(keys, (key) => {
    const wire = wireName(names, key);
    if (!P.isString(wire) || !isMemberName(wire)) {
      throw declarationError(
        `${context}: member ${render(key)} is formatted as ${render(wire)}, which is not a legal JSON:API member name`,
      );
    }
    if (wire === "type" || wire === "id") {
      throw declarationError(
        `${context}: member ${render(key)} is formatted as ${render(wire)}, a name JSON:API reserves`,
      );
    }
    const other = MutableHashMap.get(seen, wire);
    if (Option.isSome(other)) {
      throw declarationError(
        `${context}: members ${render(other.value)} and ${render(key)} are both formatted as ${render(wire)}`,
      );
    }
    MutableHashMap.set(seen, wire, key);
    if (wire !== key) changed[key] = wire;
  });
  return changed;
};
