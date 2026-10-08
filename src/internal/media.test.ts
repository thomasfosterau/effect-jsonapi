import { describe, expect, it } from "vite-plus/test";
import { MEDIA_TYPE, parseMediaType } from "./media.js";

const weightOf = (q: string) => parseMediaType(`${MEDIA_TYPE};q=${q}`).weight;

describe("parseMediaType — the q weight (RFC 9110 §12.4.2 qvalue)", () => {
  it("defaults to 1 when the entry carries no q", () => {
    expect(parseMediaType(MEDIA_TYPE).weight).toBe(1);
    expect(parseMediaType(`${MEDIA_TYPE};profile="https://example.com/p"`).weight).toBe(1);
  });

  it("reads every well-formed qvalue", () => {
    expect(weightOf("0")).toBe(0);
    expect(weightOf("0.")).toBe(0);
    expect(weightOf("0.000")).toBe(0);
    expect(weightOf("0.001")).toBe(0.001);
    expect(weightOf("0.5")).toBe(0.5);
    expect(weightOf("0.999")).toBe(0.999);
    expect(weightOf("1")).toBe(1);
    expect(weightOf("1.")).toBe(1);
    expect(weightOf("1.000")).toBe(1);
  });

  it("reads the q name case-insensitively, and tolerates whitespace around the parameter", () => {
    expect(parseMediaType(`${MEDIA_TYPE};Q=0`).weight).toBe(0);
    expect(parseMediaType(`${MEDIA_TYPE}; q=0.5`).weight).toBe(0.5);
    expect(parseMediaType(`${MEDIA_TYPE};q=0.5 `).weight).toBe(0.5);
  });

  // Each of these was a finite `Number(...)` before #234, so the empty and
  // non-positive ones read as `q=0` — an explicit refusal.
  it.each(["", "0x0", "-1", "-0", "+0", "1e-9", "2", "1.0001", "1.5", "0.0001", ".5"])(
    "reports q=%s, outside the qvalue grammar, as malformed (undefined), never as a refusal",
    (q) => {
      expect(weightOf(q)).toBeUndefined();
    },
  );

  it("reports a bare q with no = as malformed", () => {
    expect(parseMediaType(`${MEDIA_TYPE};q`).weight).toBeUndefined();
  });

  it("reports a non-numeric or quoted q as malformed", () => {
    expect(weightOf("abc")).toBeUndefined();
    // `weight = OWS ";" OWS "q=" qvalue` admits no quoted-string form.
    expect(weightOf('"0.5"')).toBeUndefined();
    expect(weightOf('"0"')).toBeUndefined();
  });

  it("still ends the media type parameter list at a malformed q", () => {
    const parsed = parseMediaType(`${MEDIA_TYPE};profile="https://example.com/p";q=;foo=bar`);
    expect(parsed.parameters).toEqual([["profile", "https://example.com/p"]]);
    expect(parsed.weight).toBeUndefined();
  });
});
