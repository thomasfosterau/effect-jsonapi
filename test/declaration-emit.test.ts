/**
 * Declaration emit as a consumer sees it (#348): a project that depends on
 * this package and compiles with `declaration: true` must be able to export
 * the values it builds without annotating them.
 *
 * `tsconfig.dist.json` already checks `test/emitted/` with `declaration: true`,
 * but it maps the package name to `./dist/index.d.ts` by `paths`, so the
 * bundle's shared chunk (`dist/media-*.d.ts`) sits *inside* the checking
 * project: when an inferred type needs a name only that chunk exports,
 * declaration emit writes a relative import of it and reports nothing. A
 * consumer resolves the package through `node_modules`, where the `exports`
 * map hides the chunk, and gets TS2883 ("cannot be named without a reference
 * to … This is likely not portable") instead. So this builds that consumer:
 * a project outside the repository, the package linked into its
 * `node_modules`, compiled by the native `tsc`.
 *
 * It reads `dist/`, so it needs `vp run build` first, as
 * `test/entry-points.test.ts` does; CI builds before it runs
 * `vp run -r test:unit`, and a local run without `dist/` reports the cases as
 * skipped rather than passing.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSC = path.join(ROOT, "node_modules", ".bin", "tsc");
const hasDist = fs.existsSync(path.join(ROOT, "dist", "index.d.ts"));

/**
 * The `tsconfig.json` a consumer of the library compiles with, emitting
 * declarations only.
 */
const TSCONFIG = `{
  "compilerOptions": {
    "module": "preserve",
    "moduleResolution": "bundler",
    "target": "esnext",
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true,
    "types": ["node"],
    "declaration": true,
    "emitDeclarationOnly": true,
    "outDir": "out"
  },
  "include": ["*.ts"]
}
`;

let consumer = "";

/** Links `target` into the consumer's `node_modules` as package `name`. */
const link = (name: string, target: string): void => {
  const at = path.join(consumer, "node_modules", name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, "dir");
};

/**
 * Compiles `files` (name, source) as the consumer, emitting declarations.
 * Returns the compiler's output and the emitted `.d.ts` text.
 */
const compile = (files: ReadonlyArray<readonly [name: string, source: string]>) => {
  const src = fs.mkdtempSync(path.join(consumer, "src-"));
  files.forEach(([name, source]) => fs.writeFileSync(path.join(src, name), source));
  fs.writeFileSync(path.join(src, "tsconfig.json"), TSCONFIG);
  const result = spawnSync(TSC, ["-p", src, "--pretty", "false"], { cwd: src, encoding: "utf8" });
  const out = path.join(src, "out");
  const declarations = fs.existsSync(out)
    ? fs
        .readdirSync(out)
        .map((name) => fs.readFileSync(path.join(out, name), "utf8"))
        .join("\n")
    : "";
  return { output: `${result.stdout}${result.stderr}`, status: result.status, declarations };
};

const fixture = (name: string): string =>
  fs.readFileSync(path.join(ROOT, "test", "emitted", name), "utf8");

describe("declaration emit in a consumer project", () => {
  beforeAll(() => {
    if (!hasDist) return;
    consumer = fs.mkdtempSync(path.join(os.tmpdir(), "effect-jsonapi-consumer-"));
    link("@thomasfosterau/effect-jsonapi", ROOT);
    link("effect", fs.realpathSync(path.join(ROOT, "node_modules", "effect")));
    link("@types/node", fs.realpathSync(path.join(ROOT, "node_modules", "@types", "node")));
  });

  afterAll(() => {
    if (consumer !== "") fs.rmSync(consumer, { recursive: true, force: true });
  });

  it.skipIf(!hasDist)(
    "exports every endpoint, group and client value without an annotation",
    () => {
      const result = compile(
        [
          "declaration-emit.types.ts",
          "declaration-emit-group.types.ts",
          "declaration-emit-errors.types.ts",
          "requirements.types.ts",
        ].map((name) => [name, fixture(name)] as const),
      );
      expect(result.output).toBe("");
      expect(result.status).toBe(0);
      // The middlewares are named, not inlined: an unnameable class is
      // written out structurally, its service key and all, into every
      // endpoint's type.
      expect(result.declarations).toContain(
        'import("@thomasfosterau/effect-jsonapi").ContentNegotiation',
      );
      const inlined = [
        "effect-jsonapi/ContentNegotiation",
        "effect-jsonapi/SchemaErrors",
        "effect-jsonapi/CreatedLocation",
        "effect-jsonapi/Idempotency",
      ].filter((key) => result.declarations.includes(`"${key}"`));
      expect(inlined).toEqual([]);
    },
    120_000,
  );

  /**
   * Control: the harness must see what a `paths`-mapped check cannot — a type
   * reachable only through the bundle's shared chunk. An endpoint over a
   * resource defined in *another* file needs `Resource.Resource` and friends,
   * which its own file has no namespace import for and the package root does
   * not export, so it still fails (tracked in #385). If this passes vacuously,
   * the case above proves nothing.
   */
  it.skipIf(!hasDist)(
    "reports a type reachable only through the shared chunk (control)",
    () => {
      const result = compile([
        [
          "resources.ts",
          [
            'import * as Schema from "effect/Schema";',
            'import { Resource } from "@thomasfosterau/effect-jsonapi";',
            'export const Person = Resource.make("people", { attributes: { name: Schema.String } });',
          ].join("\n"),
        ],
        [
          "endpoints.ts",
          [
            'import { Endpoint } from "@thomasfosterau/effect-jsonapi";',
            'import { Person } from "./resources.js";',
            "export const getPerson = Endpoint.get(Person);",
          ].join("\n"),
        ],
      ]);
      expect(result.output).toContain("error TS2883");
      expect(result.output).toContain("'Resource'");
      expect(result.status).not.toBe(0);
    },
    120_000,
  );
});
