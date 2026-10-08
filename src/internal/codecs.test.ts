import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import * as Record from "effect/Record";
import { flatten, nest } from "./codecs.js";

// A reshaper that wrote through `__proto__` would pollute every object in the
// process; undo it so one failure doesn't cascade into the rest.
const polluted = () => Object.hasOwn(Object.prototype, "polluted");
afterEach(() => {
  Reflect.deleteProperty(Object.prototype, "polluted");
});

// `Record.fromEntries` makes `__proto__` an own key, as `UrlParams.toRecord`
// does; an object literal would set the prototype instead.
const record = <V>(key: string, value: V) => Record.fromEntries([[key, value]]);

describe("nest", () => {
  it("reshapes one bracket level into groups", () => {
    expect(nest({ "page[offset]": "10", "page[limit]": "5", include: "a" })).toEqual({
      page: { offset: "10", limit: "5" },
      include: "a",
    });
  });

  it("copies deeper and empty-bracketed keys under their own spelling", () => {
    expect(nest({ "a[b][c]": "1", "a[]": "2", "[x]": "3" })).toEqual({
      "a[b][c]": "1",
      "a[]": "2",
      "[x]": "3",
    });
  });

  it("keeps a bare key and copies a colliding bracket key flat, in either order (#260)", () => {
    const expected = { x: "1", "x[y]": "2", "x[z]": "3" };
    expect(nest({ x: "1", "x[y]": "2", "x[z]": "3" })).toEqual(expected);
    expect(nest({ "x[y]": "2", x: "1", "x[z]": "3" })).toEqual(expected);
    expect(nest({ "x[y]": "2", "x[z]": "3", x: "1" })).toEqual(expected);
    expect(nest({ x: ["1", "2"], "x[y]": "3" })).toEqual({ x: ["1", "2"], "x[y]": "3" });
  });

  it("treats __proto__ as an ordinary key, never touching a prototype (#260)", () => {
    const grouped = nest(record("__proto__[polluted]", "yes"));
    expect(polluted()).toBe(false);
    expect(Object.getPrototypeOf(grouped)).toBe(Object.prototype);
    expect(Object.hasOwn(grouped, "__proto__")).toBe(true);
    expect(Object.getOwnPropertyDescriptor(grouped, "__proto__")?.value).toEqual({
      polluted: "yes",
    });

    const bare = nest(record("__proto__", { polluted: "yes" }));
    expect(Object.getPrototypeOf(bare)).toBe(Object.prototype);
    expect(Object.hasOwn(bare, "__proto__")).toBe(true);

    const member = nest(record("page[__proto__]", { polluted: "yes" }));
    expect(Object.getPrototypeOf(member.page)).toBe(Object.prototype);
    expect(Object.getOwnPropertyNames(member.page)).toEqual(["__proto__"]);
  });
});

describe("flatten", () => {
  it("is the inverse of nest on grouped keys", () => {
    const flat = { "page[offset]": "10", include: "a" };
    expect(flatten(nest(flat))).toEqual(flat);
  });

  it("treats __proto__ as an ordinary key", () => {
    const flat = flatten(record("__proto__", { polluted: "yes" }));
    expect(Object.getPrototypeOf(flat)).toBe(Object.prototype);
    expect(Object.hasOwn(flat, "__proto__[polluted]")).toBe(true);
    const bare = flatten(record("__proto__", ["yes"]));
    expect(Object.getPrototypeOf(bare)).toBe(Object.prototype);
    expect(Object.hasOwn(bare, "__proto__")).toBe(true);
  });
});

// A frozen `Object.prototype` (SES `lockdown()`, `--frozen-intrinsics`) makes
// every inherited member read-only, so plainly assigning `toString` throws in
// strict mode: the "override mistake". Freezing the prototype the vitest
// worker shares would break every other test, so one read-only member stands
// in for it. The codecs define every key, so they still write it as their own.
describe("under a read-only inherited member, as a frozen prototype gives (#269)", () => {
  beforeEach(() => {
    Object.defineProperty(Object.prototype, "readOnlyProbe", {
      value: "inherited",
      writable: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Reflect.deleteProperty(Object.prototype, "readOnlyProbe");
  });

  it("nest writes a group member under that name as its own", () => {
    const { page } = nest({ "page[readOnlyProbe]": "1" });
    expect(Object.getOwnPropertyDescriptor(page, "readOnlyProbe")?.value).toBe("1");
  });

  it("nest writes a bare key under that name as its own", () => {
    const nested = nest({ readOnlyProbe: "1" });
    expect(Object.getOwnPropertyDescriptor(nested, "readOnlyProbe")?.value).toBe("1");
  });

  it("flatten writes a key under that name as its own", () => {
    const flat = flatten({ readOnlyProbe: "1" });
    expect(Object.getOwnPropertyDescriptor(flat, "readOnlyProbe")?.value).toBe("1");
  });
});
