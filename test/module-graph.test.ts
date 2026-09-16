/**
 * The packaging invariant behind the subpath exports (#117): the `Schema`-only
 * modules must be reachable without `effect/unstable/httpapi` in their
 * resolved module graph.
 *
 * Tree-shaking cannot substitute for this. A bundler may drop unreached code,
 * but it cannot drop a *peer*: while `effect/unstable/*` is pre-stable, an
 * unnecessary dependency on it is a version-compatibility surface for every
 * consumer of the subpath, whether or not the bytes survive the bundle. So the
 * property is asserted over the import graph — type-only imports included,
 * since those reach the published `.d.ts` even when they vanish at runtime.
 */
import { readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const src = resolve(root, "src")

/**
 * The tier each public module belongs to. Pinned rather than derived: moving a
 * module between tiers is a packaging decision, so it should fail this test
 * and be made deliberately (#117).
 */
const TIERS = {
  /** `effect` is the only peer. Importable by a client, a document consumer or a non-HTTP producer. */
  schema: ["Atomic", "Document", "Filter", "Handlers", "Lid", "Query", "Relationship", "Resource", "Sort"],
  /**
   * Builds on `effect/unstable/httpapi`. `Client` is here rather than in the
   * schema tier because it generates and negotiates real HTTP requests; the
   * error-document decoding a consumer wants *without* a transport is
   * `Document.decodeErrorDocument`, which stays schema-only.
   */
  http: ["ApiError", "Client", "Endpoint", "Group", "Middleware"]
} as const

const UNSTABLE = "effect/unstable/"

/** Every module specifier in a source file, imports and re-exports alike, type-only included. */
const specifiersOf = (file: string): ReadonlyArray<string> => {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.ESNext, true)
  const found: Array<string> = []
  source.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text)
    }
  })
  return found
}

/** The external (non-relative) specifiers reachable from `entry`, transitively. */
const externalsOf = (entry: string): ReadonlyArray<string> => {
  const seen = new Set<string>()
  const externals = new Set<string>()
  const visit = (file: string): void => {
    if (seen.has(file)) return
    seen.add(file)
    for (const specifier of specifiersOf(file)) {
      if (specifier.startsWith(".")) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")))
      } else {
        externals.add(specifier)
      }
    }
  }
  visit(resolve(src, `${entry}.ts`))
  return [...externals].sort()
}

const packageJson = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  readonly exports: Record<string, string | { readonly types: string; readonly default: string }>
}

describe("module graph", () => {
  describe("the schema-only tier resolves no unstable Effect surface", () => {
    it.each(TIERS.schema)("%s", (module) => {
      expect(externalsOf(module).filter((specifier) => specifier.startsWith(UNSTABLE))).toEqual([])
    })

    it("depends on `effect` and nothing else", () => {
      const externals = new Set(TIERS.schema.flatMap(externalsOf))
      expect([...externals].filter((specifier) => !specifier.startsWith("effect"))).toEqual([])
    })
  })

  describe("the HTTP tier does resolve it", () => {
    // Asserted in both directions so the table above stays honest: a module
    // that stops needing `httpapi` fails here and gets reassigned on purpose.
    it.each(TIERS.http)("%s", (module) => {
      expect(externalsOf(module)).toContain("effect/unstable/httpapi")
    })
  })

  it("the root barrel reaches the HTTP surface, which is why the subpaths exist", () => {
    expect(externalsOf("index")).toContain("effect/unstable/httpapi")
  })

  it("`internal/media` carries the spec's media-type constants with no dependencies at all", () => {
    // `Atomic` is in the schema tier only because of this split: it wants the
    // atomic media type, not `HttpApiSchema`.
    expect(specifiersOf(resolve(src, "internal/media.ts"))).toEqual([])
  })
})

describe("package exports", () => {
  const subpaths = Object.keys(packageJson.exports).filter((key) => key !== "." && key !== "./package.json")

  it("expose every public module, and only those", () => {
    expect(subpaths.map((key) => key.slice(2)).sort()).toEqual([...TIERS.schema, ...TIERS.http].sort())
  })

  it("point at build outputs that correspond to a real source module", () => {
    for (const key of subpaths) {
      const entry = packageJson.exports[key]
      expect(typeof entry).toBe("object")
      const { default: js, types } = entry as { readonly types: string; readonly default: string }
      expect(types).toBe(`./dist/${key.slice(2)}.d.ts`)
      expect(js).toBe(`./dist/${key.slice(2)}.js`)
      expect(relative(root, resolve(src, `${key.slice(2)}.ts`))).toBe(`src/${key.slice(2)}.ts`)
    }
  })

  it("keep `internal/` unreachable", () => {
    expect(subpaths.filter((key) => key.includes("internal"))).toEqual([])
  })
})
