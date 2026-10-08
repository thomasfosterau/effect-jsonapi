/**
 * Own-property writes for records whose keys come from outside: a query
 * string, a request body, or a handler's free-form value.
 *
 * @internal
 */

/**
 * Assigns an own, enumerable data property. Plain assignment would run the
 * `__proto__` accessor for a key spelled `__proto__` (which `JSON.parse`,
 * `UrlParams.toRecord` and database drivers all produce as an own key),
 * dropping the member and re-parenting the record onto its value — or, for a
 * group later read back through that key, writing into `Object.prototype`.
 *
 * Every key is defined, none assigned, so a frozen `Object.prototype` cannot
 * make a client-chosen name (`?page[toString]=1`) throw: the request-path
 * codecs use this one. The response path, where the per-key cost shows, uses
 * {@link assign}.
 */
export const define = <V>(record: Record<string, V>, key: string, value: V): void => {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};

/**
 * {@link define}'s fast path for the response-path copies
 * (`Assemble.toWireSafeResource`, `Handlers.project`), which write every
 * member of every resource: only `__proto__` is defined, as effect's own
 * `Record.assignProperty` does, since on a plain object it is the one name
 * whose assignment runs an inherited accessor. Every other key is plainly
 * assigned, which is what keeps those copies as fast as before #269's fix.
 *
 * Known limitation, as before that fix: once `Object.prototype` is frozen its
 * members are read-only, so assigning a key such as `toString` or
 * `constructor` throws a `TypeError` in strict mode instead of adding an own
 * member — JavaScript's "override mistake".
 */
export const assign = <V>(record: Record<string, V>, key: string, value: V): void => {
  if (key === "__proto__") define(record, key, value);
  else record[key] = value;
};
