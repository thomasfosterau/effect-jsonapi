/**
 * Mechanical proof that the schema-only entry point keeps its promise: that
 * `@thomasfosterau/effect-jsonapi/schema` resolves `effect` and nothing else.
 * The same holds for each schema-tier module subpath
 * (`@thomasfosterau/effect-jsonapi/Resource`, …, #385), and every module the
 * root re-exports is published as a subpath of its own.
 *
 * The property is a packaging commitment, and a comment asserting it would rot
 * within two releases — one `import type` added to `Resource.ts` is enough to
 * break it silently. So this walks the real import graph instead.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import ts from "typescript";
import { describe, expect, it } from "vite-plus/test";
import config from "../vite.config.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = path.join(ROOT, "src");
const DIST = path.join(ROOT, "dist");

/**
 * Every module the schema-only entry point is allowed to reach. Pinned rather
 * than derived: the point is to notice when the tier grows, not to describe
 * whatever it currently is.
 */
const SCHEMA_TIER = [
  "Document.ts",
  "Filter.ts",
  "FlatQuery.ts",
  "Include.ts",
  "Relationship.ts",
  "Resource.ts",
  "Sort.ts",
  "internal/filter.ts",
  // `Include.included(resource, { include })` derives an endpoint's default
  // `included` union from this walk (#342); it imports neither `Query` nor
  // an `effect` subpath.
  "internal/includeGraph.ts",
  "internal/media.ts",
  "internal/operators.ts",
  "internal/schemaExt.ts",
  "schema.ts",
];

/**
 * The modules that resolve `effect/http-api`, and so stay out.
 *
 * `ApiError`, `Client`, `Endpoint`, `Group`, `Idempotency`, `MediaType` and
 * `Middleware` bind JSON:API to Effect's `HttpApi` directly — `Client` since it
 * gained the negotiation transform and `Client.make`, which reach `HttpClient`
 * and `HttpApiClient`, and `Idempotency` also to `HttpServerRequest` /
 * `HttpServerResponse`, being a middleware over the live request. `Query` is
 * here transitively: constraining include paths fails with
 * `ApiError.UnsupportedIncludePath` / `UnsupportedIncludeDepth`, which are
 * `HttpApi`-bound error classes — and `Handlers`, `Lid` and `Atomic` reach
 * `Query` in turn.
 *
 * `Conformance` drives a server over a real HTTP transport and discovers its
 * endpoints from an `HttpApi` value, so it is unambiguously HTTP-tier; its
 * internals come with it (`internal/conformance/report.ts` imports nothing
 * HTTP-bound itself, but it is reachable only from the tier that does).
 *
 * The server skeleton (`Assemble`, `Negotiation`, `Registry`,
 * `ResourceHandlers`, `ServerErrors`) is HTTP-tier by construction: it builds
 * on `Handlers`, `Query`, `Middleware` and `HttpApiBuilder`. `FlatQuery` is
 * the one server-skeleton module that is pure schema, and so is in the
 * schema tier with the `internal/schemaExt.ts` helpers it re-exports.
 */
const HTTP_TIER = [
  "ApiError.ts",
  "Assemble.ts",
  "Atomic.ts",
  "Client.ts",
  "Conformance.ts",
  "Endpoint.ts",
  "Group.ts",
  "Handlers.ts",
  "Idempotency.ts",
  "Lid.ts",
  "MediaType.ts",
  "Middleware.ts",
  "Negotiation.ts",
  "Query.ts",
  "Registry.ts",
  "ResourceHandlers.ts",
  "ServerErrors.ts",
  "internal/canonical.ts",
  "internal/codecs.ts",
  "internal/conformance/core.ts",
  "internal/conformance/crawl.ts",
  "internal/conformance/links.ts",
  "internal/conformance/pagination.ts",
  "internal/conformance/profile.ts",
  "internal/conformance/report.ts",
  "internal/conformance/spec.ts",
  "internal/conformance/write.ts",
  "internal/declaredQuery.ts",
  "internal/define.ts",
  "internal/errorMeta.ts",
  "internal/httpMedia.ts",
  "internal/linkage.ts",
  "internal/responseBody.ts",
  "internal/sparse.ts",
  "internal/vocabulary.ts",
  "internal/wireNames.ts",
];

/**
 * Module specifiers of `file`, read off the AST.
 *
 * Deliberately not `ts.preProcessFile`: it does not report
 * `export * as ns from "..."`, which is the only form either barrel uses — a
 * check built on it passes vacuously for exactly the files that matter here.
 *
 * Type-only imports count. A `import type ... from "effect/http-api"`
 * emits no runtime edge, but it still makes the published `.d.ts` unresolvable
 * without the peer, which is the surface this test is protecting.
 */
const specifiersOf = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<string> = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
};

/**
 * The file a relative specifier names. A declaration file's `./x.js` is its
 * sibling `./x.d.ts`, never the JavaScript beside it: `dist/` holds both.
 */
const resolveRelative = (from: string, specifier: string): string | null => {
  const base = path.resolve(path.dirname(from), specifier);
  const candidates = from.endsWith(".d.ts")
    ? [base.replace(/\.js$/, ".d.ts")]
    : [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts"), base];
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ??
    null
  );
};

interface Graph {
  /** Files reached, relative to the entry's own directory. */
  readonly modules: ReadonlyArray<string>;
  /** Bare specifiers reached, each mapped to the chain of files that reached it. */
  readonly externals: ReadonlyMap<string, ReadonlyArray<string>>;
}

/** Walks the transitive import graph from `entry`, recording how each external was reached. */
const graphFrom = (entry: string, dir: string): Graph => {
  const modules = new Set<string>();
  const externals = new Map<string, ReadonlyArray<string>>();
  const walk = (file: string, trail: ReadonlyArray<string>): void => {
    if (modules.has(file)) return;
    modules.add(file);
    const here = [...trail, path.relative(dir, file)];
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier);
        // An unresolvable relative import is a broken graph, not a pass.
        expect(
          resolved,
          `${path.relative(dir, file)} imports unresolvable "${specifier}"`,
        ).not.toBeNull();
        walk(resolved as string, here);
      } else if (!externals.has(specifier)) {
        externals.set(specifier, here);
      }
    }
  };
  walk(entry, []);
  return {
    modules: [...modules].map((file) => path.relative(dir, file)).sort(),
    externals,
  };
};

/** Whether `specifier` is part of Effect's HTTP surface: `effect/http` or `effect/http-api`, or a module under either. */
const isHttpSurface = (specifier: string): boolean =>
  specifier === "effect/http" ||
  specifier.startsWith("effect/http/") ||
  specifier === "effect/http-api" ||
  specifier.startsWith("effect/http-api/");

/** Whether `specifier` is `effect` or one of its modules: the package's only peer. */
const isEffect = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/");

/** Externals of `graph` that are not `effect`, each with the chain that reached it. */
const foreign = (graph: Graph): ReadonlyArray<string> =>
  Arr.sort(
    [...graph.externals.entries()]
      .filter(([specifier]) => !isEffect(specifier))
      .map(([specifier, trail]) => `${specifier} via ${trail.join(" -> ")}`),
    Order.String,
  );

/** The externals of `graph` other than `effect` itself, labelled with `label`. */
const beyondEffect = (label: string, graph: Graph): ReadonlyArray<string> =>
  [...graph.externals.keys()]
    .filter((specifier) => specifier !== "effect")
    .map((specifier) => `${label}: ${specifier}`);

/**
 * The namespaces a barrel re-exports, read off its `export * as X from
 * "./X.js"` statements. Each is published as the subpath `./X` (#385), so
 * the barrels, not a hand-kept list, say which subpaths must exist.
 */
const namespacesOf = (barrel: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(
    barrel,
    fs.readFileSync(barrel, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  return source.statements
    .filter(ts.isExportDeclaration)
    .flatMap((node) =>
      node.exportClause !== undefined &&
      ts.isNamespaceExport(node.exportClause) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
        ? [{ name: node.exportClause.name.text, specifier: node.moduleSpecifier.text }]
        : [],
    )
    .map(({ name, specifier }) => {
      // A namespace re-exported under another module's name would publish
      // `./X` as a module that is not `X`.
      expect(specifier, `${path.basename(barrel)} re-exports ${name}`).toBe(`./${name}.js`);
      return name;
    });
};

/** Every module the root barrel re-exports: one subpath each. */
const PUBLIC_MODULES = namespacesOf(path.join(SRC, "index.ts"));

/** The modules the schema barrel re-exports: the schema-tier subpaths. */
const SCHEMA_MODULES = namespacesOf(path.join(SRC, "schema.ts"));

/** The public modules that are not schema tier: they may resolve Effect's HTTP surface. */
const HTTP_MODULES = PUBLIC_MODULES.filter((module) => !SCHEMA_MODULES.includes(module));

const httpSurface = (graph: Graph): ReadonlyArray<string> =>
  [...graph.externals.entries()]
    .filter(([specifier]) => isHttpSurface(specifier))
    .map(([specifier, trail]) => `${specifier} via ${trail.join(" -> ")}`)
    .sort();

describe("schema-only entry point", () => {
  const schema = graphFrom(path.join(SRC, "schema.ts"), SRC);
  const root = graphFrom(path.join(SRC, "index.ts"), SRC);

  it("resolves no HTTP surface of effect at all", () => {
    expect(httpSurface(schema)).toEqual([]);
  });

  it("declares `effect` as its only external", () => {
    expect([...schema.externals.keys()].sort()).toEqual(["effect"]);
  });

  it("reaches exactly the modules assigned to the schema tier", () => {
    expect(schema.modules).toEqual([...SCHEMA_TIER].sort());
  });

  /**
   * The lint exemption follows the tier. `vite.config.ts` turns
   * `effect/no-barrel-imports` off for exactly the modules this entry point
   * reaches, because the plain `effect` barrel is the only import they may
   * use. A module that leaves the tier must lose the exemption, and one that
   * joins it must gain it, so the override's `files` are pinned to
   * `SCHEMA_TIER` (which includes `schema.ts` itself). Every override that
   * names the rule counts, whatever severity it spells (`"off"`, `["off"]`,
   * `0`, `"allow"`), so a second exemption cannot slip past by spelling "off"
   * differently.
   */
  it("exempts exactly the schema tier from `no-barrel-imports`", () => {
    const overrides = (config.lint?.overrides ?? []).filter(
      (override) => override.rules !== undefined && "effect/no-barrel-imports" in override.rules,
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]?.rules?.["effect/no-barrel-imports"]).toEqual("off");
    expect(Arr.sort(overrides[0]?.files ?? [], Order.String)).toEqual(
      Arr.sort(
        SCHEMA_TIER.map((module) => `src/${module}`),
        Order.String,
      ),
    );
  });

  it("reaches none of the HTTP-tier modules", () => {
    expect(schema.modules.filter((module) => HTTP_TIER.includes(module))).toEqual([]);
  });

  /**
   * The control. Without it every assertion above could pass because the
   * walker stopped finding imports rather than because the property holds —
   * which is precisely how this test would rot. The root barrel genuinely does
   * reach `effect/http-api`, so a walker that cannot see it here
   * cannot be trusted to see it above.
   */
  it("is checked by a walker that does detect http-api (control: the root barrel)", () => {
    expect(httpSurface(root).join("\n")).toContain("effect/http-api");
    // Every tier module except the schema barrel itself: the two entry points
    // are peers, so the root reaches the modules, not the other entry point.
    const tierModules = SCHEMA_TIER.filter((module) => module !== "schema.ts");
    expect(root.modules).toEqual([...tierModules, ...HTTP_TIER, "index.ts"].sort());
  });
});

describe("module subpaths", () => {
  it("publish every public module, and only those", () => {
    // `vp pack` takes every `src/[A-Z]*.ts` as an entry (vite.config.ts), so
    // a module file the root does not re-export would ship unlisted.
    const files = fs
      .readdirSync(SRC)
      .filter((file) => /^[A-Z]\w*\.ts$/.test(file))
      .map((file) => path.basename(file, ".ts"));
    expect(Arr.sort(PUBLIC_MODULES, Order.String)).toEqual(Arr.sort(files, Order.String));
    expect(PUBLIC_MODULES.length).toBeGreaterThan(SCHEMA_MODULES.length);
  });

  it("puts every schema-barrel module in the schema tier", () => {
    expect(SCHEMA_MODULES.filter((module) => !SCHEMA_TIER.includes(`${module}.ts`))).toEqual([]);
    expect(SCHEMA_MODULES.every((module) => PUBLIC_MODULES.includes(module))).toBe(true);
  });

  it("resolve `effect` alone from each schema-tier module", () => {
    const graphs = SCHEMA_MODULES.map(
      (module) => [module, graphFrom(path.join(SRC, `${module}.ts`), SRC)] as const,
    );
    expect(graphs.map(([module, graph]) => [module, [...graph.externals.keys()]])).toEqual(
      SCHEMA_MODULES.map((module) => [module, ["effect"]]),
    );
    expect(
      graphs.flatMap(([module, graph]) =>
        graph.modules
          .filter((reached) => !SCHEMA_TIER.includes(reached))
          .map((reached) => `./${module} reaches ${reached}`),
      ),
    ).toEqual([]);
  });

  it("resolve nothing but `effect` from each HTTP-tier module", () => {
    expect(HTTP_MODULES.filter((module) => !HTTP_TIER.includes(`${module}.ts`))).toEqual([]);
    expect(
      HTTP_MODULES.flatMap((module) => foreign(graphFrom(path.join(SRC, `${module}.ts`), SRC))),
    ).toEqual([]);
  });

  /**
   * Control: the per-subpath walk above must be able to see the HTTP surface,
   * or "resolves `effect` alone" proves nothing. `Endpoint` reaches it.
   */
  it("is checked by a walk that does see an HTTP-tier subpath's `effect/http-api` (control)", () => {
    expect(httpSurface(graphFrom(path.join(SRC, "Endpoint.ts"), SRC)).join("\n")).toContain(
      "effect/http-api",
    );
  });
});

describe("root entry point", () => {
  it("still exports every namespace, unchanged", async () => {
    const index = await import("@thomasfosterau/effect-jsonapi");
    expect(Object.keys(index).sort()).toEqual([
      "ApiError",
      "Assemble",
      "Atomic",
      "Client",
      "Conformance",
      "Document",
      "Endpoint",
      "Filter",
      "FlatQuery",
      "Group",
      "Handlers",
      "Idempotency",
      "Include",
      "Lid",
      "MEDIA_TYPE",
      "MediaType",
      "Middleware",
      "Negotiation",
      "Query",
      "Registry",
      "Relationship",
      "Resource",
      "ResourceHandlers",
      "ServerErrors",
      "Sort",
    ]);
  });

  it("exposes the same module objects the subpath does", async () => {
    const index = await import("@thomasfosterau/effect-jsonapi");
    const schema = await import("@thomasfosterau/effect-jsonapi/schema");
    // Not a second API: same modules, fewer of them.
    for (const name of Object.keys(schema)) {
      expect(index[name as keyof typeof index], `${name} differs between entry points`).toBe(
        schema[name as keyof typeof schema],
      );
    }
  });
});

describe("module subpaths, from source", () => {
  it("are the root's namespaces", () =>
    import("@thomasfosterau/effect-jsonapi")
      .then((index) =>
        Promise.all(
          PUBLIC_MODULES.map((module) =>
            import(`@thomasfosterau/effect-jsonapi/${module}`).then((subpath) =>
              Arr.some(
                Rec.toEntries(index),
                ([name, namespace]) => name === module && namespace === subpath,
              )
                ? []
                : [module],
            ),
          ),
        ),
      )
      .then((differing) => expect(differing.flat()).toEqual([])));
});

describe("package exports map", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, { types: string; default: string }>;
  };

  it("publishes the root and the schema subpath unchanged", () => {
    expect(manifest.exports["."]).toEqual({
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    expect(manifest.exports["./schema"]).toEqual({
      types: "./dist/schema.d.ts",
      default: "./dist/schema.js",
    });
  });

  it("publishes a subpath for every public module, and nothing else", () => {
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./schema": { types: "./dist/schema.d.ts", default: "./dist/schema.js" },
      ...Rec.fromEntries(
        PUBLIC_MODULES.map(
          (module) =>
            [
              `./${module}`,
              { types: `./dist/${module}.d.ts`, default: `./dist/${module}.js` },
            ] as const,
        ),
      ),
    });
  });

  it("points every declared subpath at a real source module", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const source = path.join(SRC, `${path.basename(target.default, ".js")}.ts`);
      expect(fs.existsSync(source), `${subpath} -> ${target.default} has no source`).toBe(true);
    }
  });
});

/**
 * `dist/` is not the source graph: `vp pack` (tsdown) bundles it into one ESM
 * file per entry point (`index.js`, `schema.js` and one per module subpath),
 * code they share split out into hashed chunks, and `tsc` writes one
 * declaration file per source module beside them. A clean source graph does not
 * prove the bundler kept the schema entry's imports clean, so this re-checks
 * the property on the artifact, because that is what actually ships. The cases
 * read `dist/`, so they need `vp run build` first; CI builds before it runs
 * `vp run -r test:unit`, but a local test run may not have, so each case is
 * `it.skipIf(!hasDist)` and reported as skipped rather than silently passing
 * when `dist/` is absent.
 */
describe("built artifact", () => {
  const built = path.join(DIST, "schema.js");
  const hasDist = fs.existsSync(built);

  it.skipIf(!hasDist)("ships a schema entry point that resolves `effect` alone", () => {
    expect(httpSurface(graphFrom(built, DIST))).toEqual([]);
    expect([...graphFrom(built, DIST).externals.keys()]).toEqual(["effect"]);
  });

  it.skipIf(!hasDist)("ships JavaScript and declarations for every entry point", () => {
    const missing = ["index", "schema", ...PUBLIC_MODULES]
      .flatMap((entry) => [`${entry}.js`, `${entry}.d.ts`])
      .filter((file) => !fs.existsSync(path.join(DIST, file)));
    expect(missing).toEqual([]);
  });

  it.skipIf(!hasDist)("ships schema-tier subpaths that resolve `effect` alone", () => {
    const entries = ["schema", ...SCHEMA_MODULES];
    // `effect` at most: a module whose bundled code needs nothing from it
    // (`dist/Sort.js`) imports no package at all.
    expect(
      entries.flatMap((entry) =>
        beyondEffect(`dist/${entry}.js`, graphFrom(path.join(DIST, `${entry}.js`), DIST)),
      ),
    ).toEqual([]);
    // The declarations may name an `effect` module (`import("effect/Cause")`
    // in an inferred type), but never its HTTP surface.
    const types = entries.map((entry) => graphFrom(path.join(DIST, `${entry}.d.ts`), DIST));
    expect(types.flatMap(httpSurface)).toEqual([]);
    expect(types.flatMap(foreign)).toEqual([]);
  });

  it.skipIf(!hasDist)("ships HTTP-tier subpaths that resolve nothing but `effect`", () => {
    expect(
      ["index", ...HTTP_MODULES]
        .flatMap((entry) => [`${entry}.js`, `${entry}.d.ts`])
        .flatMap((file) => foreign(graphFrom(path.join(DIST, file), DIST))),
    ).toEqual([]);
  });

  /**
   * Control for the declaration walk: `dist/Endpoint.d.ts` names
   * `effect/http-api`, so a walk that cannot see it there cannot be trusted
   * to see its absence above.
   */
  it.skipIf(!hasDist)("walks declarations that do reach `effect/http-api` (control)", () => {
    expect(httpSurface(graphFrom(path.join(DIST, "Endpoint.d.ts"), DIST)).join("\n")).toContain(
      "effect/http-api",
    );
  });

  /**
   * One module, one instance: the subpath and the root namespace must be the
   * same module object's members, not a second copy whose classes fail
   * `instanceof` against the first. Resolved through Node's real `exports`
   * map. A subpath may carry one binding its namespace lacks: the bundler
   * builds the namespace object the root re-exports in the module's own
   * chunk and exports it from there under a short name (`t`). Nothing else
   * may ride along, and the declarations (`tsc`'s) do not mention it.
   */
  it.skipIf(!hasDist)("ships subpaths whose members are the root namespaces' own", () => {
    // The module names arrive as arguments; each mismatch is one line out.
    const script = `
      const root = await import("@thomasfosterau/effect-jsonapi");
      for (const name of process.argv.slice(1)) {
        const sub = await import("@thomasfosterau/effect-jsonapi/" + name);
        for (const key of Object.keys(root[name])) {
          if (sub[key] !== root[name][key]) console.log(name + "." + key + " differs");
        }
        for (const key of Object.keys(sub).filter((key) => !(key in root[name]))) {
          if (sub[key] !== root[name]) console.log(name + " also exports " + key);
        }
      }
      console.log("CHECKED");
    `;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script, ...PUBLIC_MODULES],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("CHECKED\n");
  });

  /**
   * The end-to-end statement, and the one that does not depend on the walker
   * above being right: resolve the published subpath through Node's real
   * `exports` map, in a process where no non-core Effect namespace (`effect/http`, `effect/rpc`, ...) can be resolved
   * at all.
   */
  const loadWithoutHttp = (...entries: ReadonlyArray<string>) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./fixtures/forbid-http-peer.mjs", import.meta.url)),
        "--input-type=module",
        "-e",
        `${entries.map((entry) => `await import(${JSON.stringify(entry)});`).join(" ")} console.log("LOADED")`,
      ],
      { cwd: ROOT, encoding: "utf8" },
    );

  it.skipIf(!hasDist)(
    "loads every schema-tier subpath with every non-core effect namespace unresolvable",
    () => {
      // One process for all of them: any one that reached a blocked
      // specifier would fail the whole load.
      const result = loadWithoutHttp(
        ...["schema", ...SCHEMA_MODULES].map(
          (subpath) => `@thomasfosterau/effect-jsonapi/${subpath}`,
        ),
      );
      expect(`${result.stdout}${result.stderr}`).toContain("LOADED");
      expect(result.status).toBe(0);
    },
  );

  /**
   * Control again. If blocking `effect/http` and `effect/http-api` does not stop the root
   * barrel, it was never being blocked, and the assertion above proves
   * nothing.
   *
   * Which specifier surfaces is deliberately not pinned. The root graph
   * carries several forbidden peers — `effect/http-api`,
   * `effect/http` and the `http/HttpServer*` submodules — and Node
   * links a module's dependencies concurrently, so the first rejection to
   * surface is a race between them. Asserting one exact specifier would pass
   * or fail on module ordering rather than on the property being protected.
   * That the root barrel really does reach `effect/http-api` is
   * asserted deterministically by the static walker above.
   */
  it.skipIf(!hasDist)("is checked by hooks that do block the root barrel (control)", () => {
    const result = loadWithoutHttp("@thomasfosterau/effect-jsonapi");
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain("FORBIDDEN_PEER:effect/http");
    expect(output).not.toContain("LOADED");
    expect(result.status).not.toBe(0);
  });
});
