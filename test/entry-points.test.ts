/**
 * Mechanical proof that the schema-only entry point keeps its promise: that
 * `@thomasfosterau/effect-jsonapi/schema` resolves `effect` and nothing else.
 *
 * The property is a packaging commitment, and a comment asserting it would rot
 * within two releases — one `import type` added to `Resource.ts` is enough to
 * break it silently. So this walks the real import graph instead.
 */
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
const SRC = path.join(ROOT, "src")
const DIST = path.join(ROOT, "dist")

/**
 * Every module the schema-only entry point is allowed to reach. Pinned rather
 * than derived: the point is to notice when the tier grows, not to describe
 * whatever it currently is.
 */
const SCHEMA_TIER = [
  "Atomic.ts",
  "Client.ts",
  "Document.ts",
  "Filter.ts",
  "Handlers.ts",
  "Lid.ts",
  "Query.ts",
  "Relationship.ts",
  "Resource.ts",
  "Sort.ts",
  "internal/canonical.ts",
  "internal/codecs.ts",
  "internal/filter.ts",
  "internal/media.ts",
  "internal/operators.ts",
  "schema.ts"
]

/** The modules that bind JSON:API to Effect's `HttpApi`, and so stay out. */
const HTTP_TIER = ["ApiError.ts", "Endpoint.ts", "Group.ts", "Middleware.ts", "internal/httpMedia.ts"]

/**
 * Module specifiers of `file`, read off the AST.
 *
 * Deliberately not `ts.preProcessFile`: it does not report
 * `export * as ns from "..."`, which is the only form either barrel uses — a
 * check built on it passes vacuously for exactly the files that matter here.
 *
 * Type-only imports count. A `import type ... from "effect/unstable/httpapi"`
 * emits no runtime edge, but it still makes the published `.d.ts` unresolvable
 * without the peer, which is the surface this test is protecting.
 */
const specifiersOf = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true)
  const found: Array<string> = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      found.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      found.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

const resolveRelative = (from: string, specifier: string): string | null => {
  const base = path.resolve(path.dirname(from), specifier)
  const candidates = [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts"), base]
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null
}

interface Graph {
  /** Files reached, relative to the entry's own directory. */
  readonly modules: ReadonlyArray<string>
  /** Bare specifiers reached, each mapped to the chain of files that reached it. */
  readonly externals: ReadonlyMap<string, ReadonlyArray<string>>
}

/** Walks the transitive import graph from `entry`, recording how each external was reached. */
const graphFrom = (entry: string, dir: string): Graph => {
  const modules = new Set<string>()
  const externals = new Map<string, ReadonlyArray<string>>()
  const walk = (file: string, trail: ReadonlyArray<string>): void => {
    if (modules.has(file)) return
    modules.add(file)
    const here = [...trail, path.relative(dir, file)]
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) {
        const resolved = resolveRelative(file, specifier)
        // An unresolvable relative import is a broken graph, not a pass.
        expect(resolved, `${path.relative(dir, file)} imports unresolvable "${specifier}"`).not.toBeNull()
        walk(resolved as string, here)
      } else if (!externals.has(specifier)) {
        externals.set(specifier, here)
      }
    }
  }
  walk(entry, [])
  return {
    modules: [...modules].map((file) => path.relative(dir, file)).sort(),
    externals
  }
}

const unstable = (graph: Graph): ReadonlyArray<string> =>
  [...graph.externals.entries()]
    .filter(([specifier]) => specifier === "effect/unstable" || specifier.startsWith("effect/unstable/"))
    .map(([specifier, trail]) => `${specifier} via ${trail.join(" -> ")}`)
    .sort()

describe("schema-only entry point", () => {
  const schema = graphFrom(path.join(SRC, "schema.ts"), SRC)
  const root = graphFrom(path.join(SRC, "index.ts"), SRC)

  it("resolves no unstable effect surface at all", () => {
    expect(unstable(schema)).toEqual([])
  })

  it("declares `effect` as its only external", () => {
    expect([...schema.externals.keys()].sort()).toEqual(["effect"])
  })

  it("reaches exactly the modules assigned to the schema tier", () => {
    expect(schema.modules).toEqual([...SCHEMA_TIER].sort())
  })

  it("reaches none of the HTTP-tier modules", () => {
    expect(schema.modules.filter((module) => HTTP_TIER.includes(module))).toEqual([])
  })

  /**
   * The control. Without it every assertion above could pass because the
   * walker stopped finding imports rather than because the property holds —
   * which is precisely how this test would rot. The root barrel genuinely does
   * reach `effect/unstable/httpapi`, so a walker that cannot see it here
   * cannot be trusted to see it above.
   */
  it("is checked by a walker that does detect httpapi (control: the root barrel)", () => {
    expect(unstable(root).join("\n")).toContain("effect/unstable/httpapi")
    // Every tier module except the schema barrel itself: the two entry points
    // are peers, so the root reaches the modules, not the other entry point.
    const tierModules = SCHEMA_TIER.filter((module) => module !== "schema.ts")
    expect(root.modules).toEqual([...tierModules, ...HTTP_TIER, "index.ts"].sort())
  })
})

describe("root entry point", () => {
  it("still exports every namespace, unchanged", async () => {
    const index = await import("@thomasfosterau/effect-jsonapi")
    expect(Object.keys(index).sort()).toEqual([
      "ApiError",
      "Atomic",
      "Client",
      "Document",
      "Endpoint",
      "Filter",
      "Group",
      "Handlers",
      "Lid",
      "MEDIA_TYPE",
      "Middleware",
      "Query",
      "Relationship",
      "Resource",
      "Sort"
    ])
  })

  it("exposes the same module objects the subpath does", async () => {
    const index = await import("@thomasfosterau/effect-jsonapi")
    const schema = await import("@thomasfosterau/effect-jsonapi/schema")
    // Not a second API: same modules, fewer of them.
    for (const name of Object.keys(schema)) {
      expect(index[name as keyof typeof index], `${name} differs between entry points`).toBe(
        schema[name as keyof typeof schema]
      )
    }
  })
})

describe("package exports map", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
    exports: Record<string, { types: string; default: string }>
  }

  it("publishes the root unchanged and the schema subpath alongside it", () => {
    expect(manifest.exports).toEqual({
      ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
      "./schema": { types: "./dist/schema.d.ts", default: "./dist/schema.js" }
    })
  })

  it("points every declared subpath at a real source module", () => {
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const source = path.join(SRC, `${path.basename(target.default, ".js")}.ts`)
      expect(fs.existsSync(source), `${subpath} -> ${target.default} has no source`).toBe(true)
    }
  })
})

/**
 * `tsc` emits one file per module and rewrites no specifiers, so the source
 * graph above is the built graph. This re-checks it on the artifact anyway,
 * because that is what actually ships. CI builds before it tests; a bare
 * `pnpm test` may not have, so the assertion is reported as skipped rather
 * than silently passing when `dist/` is absent.
 */
describe("built artifact", () => {
  const built = path.join(DIST, "schema.js")
  const hasDist = fs.existsSync(built)

  it.skipIf(!hasDist)("ships a schema entry point that resolves no unstable effect surface", () => {
    expect(unstable(graphFrom(built, DIST))).toEqual([])
  })

  it.skipIf(!hasDist)("ships declarations for both entry points", () => {
    for (const file of ["index.js", "index.d.ts", "schema.js", "schema.d.ts"]) {
      expect(fs.existsSync(path.join(DIST, file)), `dist/${file} missing`).toBe(true)
    }
  })

  /**
   * The end-to-end statement, and the one that does not depend on the walker
   * above being right: resolve the published subpath through Node's real
   * `exports` map, in a process where `effect/unstable/*` cannot be resolved
   * at all.
   */
  const loadWithoutUnstable = (entry: string) =>
    spawnSync(
      process.execPath,
      [
        "--import",
        fileURLToPath(new URL("./fixtures/forbid-unstable-peer.mjs", import.meta.url)),
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(entry)}); console.log("LOADED")`
      ],
      { cwd: ROOT, encoding: "utf8" }
    )

  it.skipIf(!hasDist)("loads the schema subpath with effect/unstable unresolvable", () => {
    const result = loadWithoutUnstable("@thomasfosterau/effect-jsonapi/schema")
    expect(`${result.stdout}${result.stderr}`).toContain("LOADED")
    expect(result.status).toBe(0)
  })

  /**
   * Control again. If blocking `effect/unstable/*` does not stop the root
   * barrel, it was never being blocked, and the assertion above proves
   * nothing.
   */
  it.skipIf(!hasDist)("is checked by hooks that do block httpapi (control: the root barrel)", () => {
    const result = loadWithoutUnstable("@thomasfosterau/effect-jsonapi")
    expect(`${result.stdout}${result.stderr}`).toContain("FORBIDDEN_PEER:effect/unstable/httpapi")
    expect(result.status).not.toBe(0)
  })
})
