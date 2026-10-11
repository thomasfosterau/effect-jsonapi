import { describe, expect, it } from "vite-plus/test";
import { definesMembers, FAMILIES, isFamilyMember } from "./vocabulary.js";

describe("definesMembers", () => {
  // `fields[TYPE]` per type, `page[KEY]` / `filter[KEY]` per key; `include`
  // and `sort` are one bare parameter each (#329).
  it("is true for `fields`, `page` and `filter` alone", () => {
    expect(FAMILIES.filter(definesMembers)).toEqual(["fields", "page", "filter"]);
  });
});

describe("isFamilyMember", () => {
  // JSON:API 1.1 §Query Parameter Families: the base name followed by `[]`
  // or square-bracketed legal member names (§Member Names).
  it.each([
    ["include[]", "include"],
    ["include[x]", "include"],
    ["sort[x][y]", "sort"],
    ["sort[][]", "sort"],
    ["page[size]", "page"],
    ["page[]", "page"],
    ["filter[a_b]", "filter"],
    ["filter[a-b c]", "filter"],
    ["filter[é]", "filter"],
    ["fields[articles]", "fields"],
  ] as const)("admits %j as a member of %j", (name, family) => {
    expect(isFamilyMember(name, family)).toBe(true);
  });

  it.each([
    ["page", "page"],
    ["page[", "page"],
    ["page[size", "page"],
    ["page]", "page"],
    ["page[size]x", "page"],
    ["page[[size]]", "page"],
    ["filter[_]", "filter"],
    ["filter[-a]", "filter"],
    ["filter[a ]", "filter"],
    ["filter[a.b]", "filter"],
    ["sort[x]", "page"],
  ] as const)("refuses %j as a member of %j", (name, family) => {
    expect(isFamilyMember(name, family)).toBe(false);
  });
});
