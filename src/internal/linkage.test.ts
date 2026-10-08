import { describe, expect, it } from "vite-plus/test";
import * as HashSet from "effect/HashSet";
import { reachable } from "./linkage.js";

/** Linkage over a fixed graph: each key's neighbours, nothing for an unknown key. */
const graph =
  (edges: Record<string, ReadonlyArray<string>>) =>
  (key: string): ReadonlyArray<string> =>
    edges[key] ?? [];

const sorted = (set: HashSet.HashSet<string>) => [...set].toSorted();

describe("reachable", () => {
  it("reaches the seeds and everything their linkage reaches, level by level", () => {
    const linkageOf = graph({ a: ["b"], b: ["c", "d"], c: [], d: ["e"], x: ["a"] });
    expect(sorted(reachable(["a"], linkageOf))).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("ends a branch at a key that names no resource in the document", () => {
    expect(sorted(reachable(["a"], graph({ a: ["missing"] })))).toEqual(["a", "missing"]);
  });

  it("terminates on a cycle and does not reach a cycle the seeds do not", () => {
    const linkageOf = graph({ a: ["b"], b: ["a"], x: ["y"], y: ["x"] });
    expect(sorted(reachable(["a"], linkageOf))).toEqual(["a", "b"]);
  });

  it("reaches nothing from no seeds", () => {
    expect(HashSet.size(reachable([], graph({ a: ["b"] })))).toBe(0);
  });

  it("walks a 100,000-level chain without overflowing the stack (#239)", () => {
    // 0 → 1 → … → 99999: one walk level per key, so a walk that recursed per
    // level would exhaust the stack (the recursive walk #248 shipped on trunk
    // overflowed at about 6,000 levels on Node 22).
    const length = 100_000;
    const linkageOf = (key: string) => {
      const next = Number(key) + 1;
      return next < length ? [String(next)] : [];
    };
    expect(HashSet.size(reachable(["0"], linkageOf))).toBe(length);
  });
});
