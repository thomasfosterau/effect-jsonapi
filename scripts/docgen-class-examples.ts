/**
 * Type-checks and runs the `@example` in each exported class's own doc
 * comment — the examples `@effect/docgen` parses and prints on the class's doc
 * page but never collects for checking (#276).
 *
 * docgen 0.5.2's `getExampleFiles` gathers the examples of modules, class
 * methods and static methods, interfaces, type aliases, constants, functions
 * and namespaces — not the class declaration's own JSDoc — and has no option
 * to add them. So a broken class example passes docgen while still being
 * published on the class's doc page. This runner repeats docgen's own example
 * pipeline for exactly the examples it skips:
 *
 * - modules are `<srcDir>/**\/*.ts` minus `exclude`, from `docgen.json`;
 * - a class counts when it is top-level and exported (by an `export`
 *   modifier or a local `export { … }` / `export default`, as ts-morph's
 *   `isExported()` reads it) and its last JSDoc block carries neither
 *   `@internal` nor `@ignore`;
 * - each `@example` loses its code fence (docgen's `fencedExampleRegex`), its
 *   package-name imports are rewritten to `../../src`, and an `assert` import
 *   is added when it uses `assert.`;
 * - the files are compiled by `tsc --noEmit` under a tsconfig holding only
 *   docgen's `examplesCompilerOptions`, then run by `tsx` through one
 *   `index.ts` that imports them all — the same `tsc` and `tsx` docgen spawns
 *   from `PATH` (under `vp run`, `node_modules/.bin`: native TypeScript 7).
 *
 * The second sub-task of the `docgen` task in vite.config.ts, so `vp run
 * docgen` (and its CI step) fails on a class example that does not compile or
 * that throws. Delete this file and that wiring once docgen collects class
 * examples itself.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import ts from "typescript";

const DocgenConfig = Schema.fromJsonString(
  Schema.Struct({
    srcDir: Schema.optionalKey(Schema.String),
    outDir: Schema.optionalKey(Schema.String),
    exclude: Schema.optionalKey(Schema.Array(Schema.String)),
    // docgen also accepts a tsconfig path here; this runner does not.
    examplesCompilerOptions: Schema.optionalKey(Schema.JsonObject),
  }),
);
const PackageJson = Schema.fromJsonString(Schema.Struct({ name: Schema.String }));
const ExamplesTsConfig = Schema.fromJsonString(
  Schema.Struct({ compilerOptions: Schema.JsonObject }),
  { space: 2 },
);

const cwd = process.cwd();
const config = Schema.decodeSync(DocgenConfig)(
  fs.readFileSync(path.join(cwd, "docgen.json"), "utf8"),
);
const { name: projectName } = Schema.decodeSync(PackageJson)(
  fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
);
// A sibling of docgen's own `<outDir>/examples`, at the same depth, so the
// `../../src` import rewrite resolves identically. Gitignored with the rest
// of the generated docs.
const examplesDir = path.join(cwd, config.outDir ?? "docs", "class-examples");

interface ExampleFile {
  readonly name: string;
  readonly content: string;
}

interface Tag {
  readonly title: string;
  readonly body: string;
}

/**
 * The tags of a JSDoc block, as doctrine reads them with `unwrap`: the
 * delimiters and each line's `*` margin dropped, and a tag running from its
 * `@title` to the next line that starts with `@`, trimmed.
 */
const parseTags = (jsDoc: string): ReadonlyArray<Tag> =>
  Arr.filterMap(
    jsDoc
      .replace(/^\/\*\*/, "")
      .replace(/\*\/$/, "")
      .split("\n")
      .map((line) => line.replace(/^\s*\*? ?/, ""))
      .join("\n")
      .split(/^(?=\s*@\w)/m),
    (chunk) => {
      const match = /^\s*@(\w+)([\s\S]*)$/.exec(chunk);
      return match === null
        ? Result.failVoid
        : Result.succeed({ title: match[1] ?? "", body: (match[2] ?? "").trim() });
    },
  );

// docgen's `fencedExampleRegex` / `parseExample`: an unfenced example is
// used as written.
const fencedExampleRegex =
  /^(?<fenceStart>(```|~~~)[^\n]*)\n(?<body>[\S\s]*)(?<fenceEnd>\n(```|~~~))$/;
const exampleBody = (example: string): string =>
  fencedExampleRegex.exec(example)?.groups?.["body"] ?? example;

// docgen's `replaceProjectName` + `addAssertImport`.
const importRegex = new RegExp(
  `from (?<quote>['"])${projectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/lib)?(?:/(?<path>.*))?\\k<quote>`,
  "g",
);
const handleImports = (code: string): string => {
  const source = code.replace(importRegex, (...args) => {
    const subpath = args.at(-1)?.path;
    return `from '../../src${subpath ? `/${subpath}` : ""}'`;
  });
  return source.includes("assert.") ? `import * as assert from 'assert'\n${source}` : source;
};

// The local names a module exports without an `export` modifier on the
// declaration: `export { X }`, `export { X as Y }`, `export type { X }` and
// `export default X`. ts-morph's `isExported()`, which docgen calls, counts
// a class exported through any of them.
const isLocalExportList = (statement: ts.Statement): statement is ts.ExportDeclaration =>
  ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined;
const localName = (element: ts.ExportSpecifier): string =>
  (element.propertyName ?? element.name).text;
const exportListNames = (statement: ts.Statement): ReadonlyArray<string> => {
  const clause = isLocalExportList(statement) ? statement.exportClause : undefined;
  return clause !== undefined && ts.isNamedExports(clause) ? clause.elements.map(localName) : [];
};
const exportDefaultNames = (statement: ts.Statement): ReadonlyArray<string> =>
  ts.isExportAssignment(statement) && ts.isIdentifier(statement.expression)
    ? [statement.expression.text]
    : [];
const exportedNames = (sourceFile: ts.SourceFile): ReadonlyArray<string> =>
  sourceFile.statements.flatMap((statement) => [
    ...exportListNames(statement),
    ...exportDefaultNames(statement),
  ]);

const isExported = (node: ts.ClassDeclaration, exported: ReadonlyArray<string>): boolean =>
  (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export) !== 0 ||
  (node.name !== undefined && exported.includes(node.name.text));

// docgen's `shouldNotIgnore`.
const isIgnoreTag = (tag: Tag): boolean => tag.title === "internal" || tag.title === "ignore";

const classExamples = (file: string): ReadonlyArray<ExampleFile> => {
  const sourceFile = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const prefix = file.split(path.sep).join("-");
  const exported = exportedNames(sourceFile);
  return sourceFile.statements
    .filter(ts.isClassDeclaration)
    .filter((node) => isExported(node, exported))
    .flatMap((node) => {
      // docgen reads the last JSDoc block only.
      const jsDoc = ts.getJSDocCommentsAndTags(node).filter(ts.isJSDoc).at(-1);
      const tags = jsDoc === undefined ? [] : parseTags(jsDoc.getText());
      if (node.name === undefined || tags.some(isIgnoreTag)) return [];
      const className = node.name.text;
      return tags
        .filter((tag) => tag.title === "example")
        .map((tag, i) => ({
          name: `${prefix}-class-${className}-${i}.ts`,
          content: `${handleImports(exampleBody(tag.body))}\n`,
        }));
    });
};

const run = (command: string, args: ReadonlyArray<string>): void => {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    console.error(
      `docgen-class-examples: \`${command}\` failed on the class examples in ${path.relative(cwd, examplesDir)}`,
    );
    process.exit(result.status ?? 1);
  }
};

// `exclude` is applied by globbing it and dropping the matches, not through
// `globSync`'s own `exclude` option: that option takes glob patterns only
// from Node 22.14, and `engines` admits every Node 22.
const excluded = fs.globSync([...(config.exclude ?? [])]);
const examples = Arr.sort(
  fs
    .globSync(path.join(config.srcDir ?? "src", "**", "*.ts"))
    .filter((file) => !excluded.includes(file)),
  Order.String,
).flatMap(classExamples);

fs.rmSync(examplesDir, { recursive: true, force: true });
console.log(`docgen-class-examples: ${examples.length} class example(s) found`);
if (Arr.isReadonlyArrayNonEmpty(examples)) {
  fs.mkdirSync(examplesDir, { recursive: true });
  examples.forEach((example) =>
    fs.writeFileSync(path.join(examplesDir, example.name), example.content),
  );
  const index = path.join(examplesDir, "index.ts");
  fs.writeFileSync(
    index,
    `${examples.map((example) => `import './${path.basename(example.name, ".ts")}'`).join("\n")}\n`,
  );
  const tsconfig = path.join(examplesDir, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    Schema.encodeSync(ExamplesTsConfig)({
      compilerOptions: config.examplesCompilerOptions ?? {},
    }),
  );
  run("tsc", ["--noEmit", "--project", tsconfig]);
  run("tsx", ["--tsconfig", tsconfig, index]);
  // Left in place on failure (as docgen leaves `<outDir>/examples`) so the
  // failing file can be read.
  fs.rmSync(examplesDir, { recursive: true, force: true });
  console.log("docgen-class-examples: every class example compiled and ran");
}
