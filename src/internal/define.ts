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
 */
export const define = <V>(record: Record<string, V>, key: string, value: V): void => {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
};
