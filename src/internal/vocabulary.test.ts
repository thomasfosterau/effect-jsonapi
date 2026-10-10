import { describe, expect, it } from "vite-plus/test";
import { FAMILIES, isMemberwise } from "./vocabulary.js";

describe("isMemberwise", () => {
  // `fields[TYPE]` per type (#261), `page[KEY]` / `filter[KEY]` per key
  // (#321); `include` and `sort` are one unbracketed parameter each.
  it("is true for `fields`, `page` and `filter` alone", () => {
    expect(FAMILIES.filter(isMemberwise)).toEqual(["fields", "page", "filter"]);
  });
});
