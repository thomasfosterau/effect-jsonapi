/**
 * Declaration emit as a consumer sees it (#348, #385): a project that depends
 * on this package and compiles with `declaration: true` must be able to export
 * the values it builds without annotating them.
 *
 * `tsconfig.dist.json` already checks `test/emitted/` with `declaration: true`,
 * but it maps the package name to `./dist/index.d.ts` by `paths`, so every
 * declaration file under `dist/` sits *inside* the checking project: when an
 * inferred type needs a name only a module the `exports` map does not publish
 * declares, declaration emit writes a relative import of it and reports
 * nothing. A consumer resolves the package through `node_modules`, where the
 * `exports` map decides what it can name, and gets TS2883 ("cannot be named
 * without a reference to … This is likely not portable") instead. So this
 * builds that consumer: a project outside the repository, the package linked
 * into its `node_modules`, compiled by the native `tsc`.
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
import * as Schema from "effect/Schema";
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

/** Links `target` into the `node_modules` of `root` as package `name`. */
const link = (root: string, name: string, target: string): void => {
  const at = path.join(root, "node_modules", name);
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at, "dir");
};

/**
 * A consumer project root under `consumer`, with `effect`, `@types/node` and
 * the package at `pkg` in its `node_modules`.
 */
const project = (pkg: string): string => {
  const root = fs.mkdtempSync(path.join(consumer, "project-"));
  link(root, "@thomasfosterau/effect-jsonapi", pkg);
  link(root, "effect", fs.realpathSync(path.join(ROOT, "node_modules", "effect")));
  link(root, "@types/node", fs.realpathSync(path.join(ROOT, "node_modules", "@types", "node")));
  return root;
};

/**
 * Compiles `files` (name, source) as a consumer in `root`, emitting
 * declarations. Returns the compiler's output and the emitted `.d.ts` text.
 */
const compile = (root: string, files: ReadonlyArray<readonly [name: string, source: string]>) => {
  const src = fs.mkdtempSync(path.join(root, "src-"));
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

/**
 * Resources defined in a module of their own, as an app's `resources.ts`
 * would: the files that build endpoints, groups and clients over them import
 * them, not the `Resource` / `Relationship` namespaces their types mention.
 */
const RESOURCES = [
  'import * as Schema from "effect/Schema";',
  'import { Relationship, Resource } from "@thomasfosterau/effect-jsonapi";',
  "",
  'export const Person = Resource.make("people", { attributes: { name: Schema.String } });',
  'export const Comment = Resource.make("comments", {',
  "  attributes: { body: Schema.String },",
  "  relationships: { author: Relationship.one(() => Person) },",
  "});",
  'export const Article = Resource.make("articles", {',
  "  attributes: { title: Schema.String },",
  "  relationships: {",
  "    author: Relationship.one(() => Person),",
  "    comments: Relationship.many(() => Comment),",
  "  },",
  "});",
].join("\n");

/** An endpoint, groups and clients over `RESOURCES`, importing only what they call (#385). */
const ENDPOINTS = [
  'import { HttpApi, HttpApiClient } from "effect/http-api";',
  'import { Client, Endpoint, Group } from "@thomasfosterau/effect-jsonapi";',
  'import { Article, Person } from "./resources.js";',
  "",
  "export const getPerson = Endpoint.get(Person);",
  "export const listArticles = Endpoint.list(Article, { include: true });",
  "export const articles = Group.resource(Article, { include: true, fields: true });",
  "export const people = Group.make(Person, getPerson);",
  'const Api = HttpApi.make("api").add(articles).add(people);',
  'export const client = HttpApiClient.make(Api, { baseUrl: "https://example.test" });',
  'export const negotiated = Client.make(Api, { baseUrl: "https://example.test" });',
].join("\n");

/** The same, written against the module subpaths, as an `effect` user would. */
const SUBPATHS = [
  'import * as Endpoint from "@thomasfosterau/effect-jsonapi/Endpoint";',
  'import * as Group from "@thomasfosterau/effect-jsonapi/Group";',
  'import { Comment } from "./resources.js";',
  "",
  "export const getComment = Endpoint.get(Comment);",
  "export const comments = Group.resource(Comment, { include: true });",
].join("\n");

const CROSS_FILE = [
  ["resources.ts", RESOURCES],
  ["endpoints.ts", ENDPOINTS],
  ["subpaths.ts", SUBPATHS],
] as const;

/** The package manifest: its `exports` map, and whatever else it holds, kept as is. */
const Manifest = Schema.StructWithRest(
  Schema.Struct({ exports: Schema.Record(Schema.String, Schema.Json) }),
  [Schema.Record(Schema.String, Schema.Json)],
);
type Manifest = typeof Manifest.Type;
const ManifestJson = Schema.fromJsonString(Manifest);

/**
 * A copy of the built package under `consumer`, its manifest passed through
 * `manifest` and its `dist/index.d.ts` through `index`. A copy, not a link:
 * through a link the compiler would find the repository's own
 * `package.json` beside the real files.
 */
const packageCopy = (
  manifest: (manifest: Manifest) => Manifest,
  index: (source: string) => string = (source) => source,
): string => {
  const pkg = fs.mkdtempSync(path.join(consumer, "package-"));
  const original = Schema.decodeSync(ManifestJson)(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
  );
  fs.writeFileSync(
    path.join(pkg, "package.json"),
    Schema.encodeSync(ManifestJson)(manifest(original)),
  );
  fs.cpSync(path.join(ROOT, "dist"), path.join(pkg, "dist"), { recursive: true });
  const indexDts = path.join(pkg, "dist", "index.d.ts");
  fs.writeFileSync(indexDts, index(fs.readFileSync(indexDts, "utf8")));
  // Its own `effect` peer, as the repository's `node_modules` gives the real
  // package: the same files, so the consumer sees one `effect`.
  link(pkg, "effect", fs.realpathSync(path.join(ROOT, "node_modules", "effect")));
  return pkg;
};

/** `dist/index.d.ts` without its `export type { … } from` blocks: the root aliases. */
const stripRootAliases = (source: string): string => {
  const stripped = source.replace(/export type \{[^}]*\} from "[^"]*";/g, "");
  // Guard the edit itself: a regex that matched nothing would make the case
  // that uses it pass vacuously.
  expect(stripped).not.toBe(source);
  expect(stripped).not.toContain("export type {");
  return stripped;
};

describe("declaration emit in a consumer project", () => {
  beforeAll(() => {
    if (!hasDist) return;
    consumer = fs.mkdtempSync(path.join(os.tmpdir(), "effect-jsonapi-consumer-"));
  });

  afterAll(() => {
    if (consumer !== "") fs.rmSync(consumer, { recursive: true, force: true });
  });

  it.skipIf(!hasDist)(
    "exports every endpoint, group and client value without an annotation",
    () => {
      const result = compile(
        project(ROOT),
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
   * The case #385 reported: an endpoint, a group and a client over resources
   * imported from another file, built from the root's namespaces and from
   * the module subpaths. Their inferred types need `Resource.Resource`,
   * `Resource.Id` and friends, which the exporting file has no namespace
   * import for; each module's subpath (`@thomasfosterau/effect-jsonapi/Resource`)
   * exports them directly, so declaration emit names them through it.
   */
  it.skipIf(!hasDist)(
    "exports an endpoint, a group and a client over resources from another file",
    () => {
      const result = compile(project(ROOT), CROSS_FILE);
      expect(result.output).toBe("");
      expect(result.status).toBe(0);
      expect(result.declarations).toContain(
        'import("@thomasfosterau/effect-jsonapi/Resource").Resource<"people"',
      );
      // No relative path into the package: a name reached through a file the
      // exports map hides would be written as one, and break when published.
      expect(result.declarations).not.toMatch(/import\("\.{1,2}\//);
      expect(result.declarations).not.toContain("node_modules");
    },
    120_000,
  );

  /**
   * The root type aliases (#348) are deprecated in favour of the subpaths:
   * with every one of them withdrawn from `dist/index.d.ts`, the same
   * consumer files still emit, each type named through its module's subpath.
   */
  it.skipIf(!hasDist)(
    "needs none of the deprecated root type aliases",
    () => {
      const pkg = packageCopy((manifest) => manifest, stripRootAliases);
      const result = compile(
        project(pkg),
        [
          "declaration-emit.types.ts",
          "declaration-emit-group.types.ts",
          "declaration-emit-errors.types.ts",
          "requirements.types.ts",
        ].map((name) => [name, fixture(name)] as const),
      );
      expect(result.output).toBe("");
      expect(result.status).toBe(0);
      expect(result.declarations).toContain(
        'import("@thomasfosterau/effect-jsonapi/Middleware").ContentNegotiation',
      );
      expect(result.declarations).not.toContain('"effect-jsonapi/ContentNegotiation"');
    },
    120_000,
  );

  /**
   * Control: the harness must resolve through the `exports` map, or the cases
   * above could pass whatever the package publishes. The same package with
   * its `./Resource` subpath withdrawn must fail the cross-file compile with
   * TS2883, naming `Resource`; if it passes, those cases prove nothing.
   */
  it.skipIf(!hasDist)(
    "reports a type whose module's subpath is withdrawn (control)",
    () => {
      const pkg = packageCopy(
        ({ exports: { "./Resource": _withdrawn, ...exports }, ...manifest }) => ({
          ...manifest,
          exports,
        }),
      );
      const result = compile(project(pkg), CROSS_FILE);
      expect(result.output).toContain("error TS2883");
      expect(result.output).toContain("'Resource'");
      expect(result.status).not.toBe(0);
    },
    120_000,
  );
});
