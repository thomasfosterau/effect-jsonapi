import { describe, expect, it } from "vite-plus/test";
import { assign, define } from "./define.js";

// A record whose prototype is frozen, standing in for a frozen
// `Object.prototype` without freezing the one every other test shares.
const underFrozen = (): Record<string, number> =>
  Object.create(
    Object.freeze({
      toString: () => "inherited",
      constructor: "inherited",
      prototype: "inherited",
    }),
  );

const keys = ["constructor", "prototype", "toString", "__proto__"];

describe("define", () => {
  // The request-path codecs write client-chosen names with it, so a
  // hardened runtime must not turn `?page[toString]=1` into a thrown error.
  it.each(keys)("defines %s as an own member even under a frozen prototype", (key) => {
    const record = underFrozen();
    define(record, key, 1);
    expect(Object.getOwnPropertyDescriptor(record, key)).toEqual({
      value: 1,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });
});

describe("assign", () => {
  it.each(keys)("writes %s as an own data member", (key) => {
    const record: Record<string, { readonly inner: number }> = {};
    assign(record, key, { inner: 2 });
    expect(Object.getPrototypeOf(record)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptor(record, key)).toEqual({
      value: { inner: 2 },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  });

  // The documented limitation of the fast path: JavaScript's "override
  // mistake" for a name the frozen prototype carries.
  it("throws for a name a frozen prototype carries, as plain assignment does", () => {
    expect(() => assign(underFrozen(), "toString", 1)).toThrow(TypeError);
    const record = underFrozen();
    assign(record, "__proto__", 1);
    expect(Object.hasOwn(record, "__proto__")).toBe(true);
  });
});
