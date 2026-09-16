/**
 * Packaging assertions over the built artifact (#117, #121).
 *
 * `test/module-graph.test.ts` proves the *source* graph of each schema-only
 * module never reaches `effect/unstable/httpapi`. This proves the two things
 * that only exist once `dist/` does:
 *
 *   1. a consumer importing a schema-only subpath bundles no HTTP surface, and
 *   2. `sideEffects: false` is doing its job — importing one namespace from the
 *      root barrel drops the modules it doesn't reach.
 *
 * Run after `pnpm run build`, via `pnpm run check:packaging`.
 */
import * as esbuild from "esbuild"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const dist = resolve(root, "dist")

const HTTP_SURFACE = "effect/unstable/httpapi"

/** Bundles `source` against the built package, leaving `effect` external so its specifiers stay readable. */
const bundle = async (source: string): Promise<string> => {
  const result = await esbuild.build({
    stdin: { contents: source, resolveDir: root, loader: "js" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    external: ["effect", "effect/*"]
  })
  return result.outputFiles[0]?.text ?? ""
}

const failures: Array<string> = []

const assert = (ok: boolean, describe: string): void => {
  console.log(`${ok ? "  ok  " : " FAIL "} ${describe}`)
  if (!ok) failures.push(describe)
}

if (!existsSync(dist)) {
  console.error("dist/ is missing — run `pnpm run build` first.")
  process.exit(1)
}

// 1. Each schema-only subpath bundles without the HTTP surface.
const SCHEMA_ONLY = [
  "Atomic",
  "Document",
  "Filter",
  "Handlers",
  "Lid",
  "Query",
  "Relationship",
  "Resource",
  "Sort"
] as const

for (const module of SCHEMA_ONLY) {
  const output = await bundle(`export * from "./dist/${module}.js"`)
  assert(!output.includes(HTTP_SURFACE), `subpath ./${module} bundles without ${HTTP_SURFACE}`)
}

// 2. The control: the HTTP tier *does* pull it in, so a pass above means
//    something. Without this, a bundle that silently produced nothing at all
//    would satisfy every assertion in part 1.
const endpointBundle = await bundle(`export * from "./dist/Endpoint.js"`)
assert(endpointBundle.includes(HTTP_SURFACE), `control: subpath ./Endpoint does bundle ${HTTP_SURFACE}`)

// 3. `sideEffects: false`: one namespace off the root barrel drops the rest.
const barrelBundle = await bundle(`
  import { Document } from "./dist/index.js"
  console.log(Document.ErrorObject)
`)
assert(
  !barrelBundle.includes(HTTP_SURFACE),
  `the root barrel tree-shakes to ${HTTP_SURFACE}-free when only Document is used`
)

const barrelWithEndpoint = await bundle(`
  import { Endpoint } from "./dist/index.js"
  console.log(Endpoint.get)
`)
assert(
  barrelWithEndpoint.includes(HTTP_SURFACE),
  `control: the same barrel keeps ${HTTP_SURFACE} when Endpoint is used`
)

if (failures.length > 0) {
  console.error(`\n${failures.length} packaging assertion(s) failed.`)
  process.exit(1)
}
console.log("\nAll packaging assertions passed.")
