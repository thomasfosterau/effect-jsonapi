/**
 * Root workspace config. Owns the repo-wide format / lint / staged passes
 * (read statically by `vp fmt` / `vp lint` / `vp staged`), the library's own
 * task graph (`typecheck`, `build`, `typecheck:dist`, `test:unit`, `docgen`),
 * the root `check` aggregate over every package's type gate, and the `vp pack`
 * build that emits `dist/`.
 *
 * Copied in shape from the consuming applications' root config (via
 * effect-drizzle-ext, the library reference): every comment that explains a
 * load-bearing decision is part of the standard and travels with the config.
 */

import { fileURLToPath } from "node:url";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

/**
 * Input fingerprint for the cached tasks: auto tracking minus node_modules
 * bookkeeping churn (pnpm rewrites `.modules.yaml` on every install), with the
 * lockfile back explicitly so a dependency upgrade still invalidates a
 * type-check or a test run.
 */
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  "!examples/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

/**
 * Vitest's worker cap, from `VITEST_MAX_WORKERS` when it is set (a loaded or
 * memory-bound machine); otherwise Vitest's own default.
 */
const workerOptions = process.env.VITEST_MAX_WORKERS
  ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
  : {};

export default defineConfig({
  // Staged-file checks run by `vp staged` (pre-commit).
  staged: {
    "*.{js,mjs,ts,json,md,yml,yaml}": "vp check --fix",
  },
  fmt: {
    // CHANGELOG.md is written by `changeset version`; the generated API docs
    // under docs/ are gitignored (only the three hand-written notes are
    // tracked) and are docgen's output, not ours to format.
    ignorePatterns: ["**/dist/**", "CHANGELOG.md", "docs/modules/**", "docs/index.md"],
    overrides: [
      {
        files: ["**/*.md"],
        options: {
          proseWrap: "never",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
    extends: [recommended, effect.configs.recommended],
    // oxlint's default plugins (eslint, typescript, unicorn, oxc) plus the
    // `import`, `promise` and `vitest` rule sets; `correctness`, `suspicious`
    // and `perf` run at `error` across all of them (#532). The handful of
    // their rules that cut across this library's conventions are off below,
    // each with its reason.
    plugins: ["eslint", "typescript", "unicorn", "oxc", "import", "promise", "vitest"],
    categories: {
      correctness: "error",
      suspicious: "error",
      perf: "error",
    },
    rules: {
      "eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "eslint/prefer-const": "warn",
      // `casting-awareness` is an awareness prompt, not a defect rule — it
      // fires on every `as`, including the narrowings the conditional-type
      // machinery in Resource.ts / Query.ts / Endpoint.ts structurally
      // requires (see `AsFields` in AGENTS.md). Stays visible as a warning.
      "effect/casting-awareness": "warn",
      // Hard-codes abbreviations (`Arr`, `P`, `R`, …) with no options, so it is
      // unsatisfiable under the full-name convention (`import { Option } from
      // "effect"`) this library shares with its consumers.
      "effect/prefer-namespace-imports": "off",

      // ---- Effect preset: staged rollout ---------------------------------
      // `effect.configs.recommended` turns on every rule at `error`. The
      // modules under src/ predate the preset, so the rules below sit at
      // `warn`: every site stays reported and countable, but the tree stays
      // committable while the remaining work lands incrementally. Flip a rule
      // back to `error` (and delete its line) the moment its count reaches
      // zero — a new site is a defect, not headroom. Counted on adopting
      // plugin 0.6.0 (`vp lint`, 2026-10-22): 4,040 warnings, with 813
      // `require-safety-comment-for-type-assertion`, 626 `casting-awareness`,
      // 489 `prefer-option-over-null`, 326 `avoid-native-object-helpers` and
      // 237 `avoid-non-null-assertion` the largest. Per-rule remainder and the
      // order to pay it down in: #436. The move to @enfect/oxlint 0.9.0 (#532),
      // the same rules under the same `effect/` names plus
      // `no-cause-in-http-response` (no sites), left the count unchanged.
      "effect/require-safety-comment-for-type-assertion": "warn",
      "effect/no-chained-type-assertions": "warn",
      // This rule and `no-known-value-widening` only check the built-in
      // `Record<K, V>` while no local binding is named `Record`, so importing
      // effect's `Record` module under that name hides every such site in
      // the file (#275). Never bind it as `Record`: spell the alias `Rec`
      // everywhere (`import { Record as Rec } from "effect"`), never `R`,
      // which is the resource type parameter in many files.
      "effect/no-unsafe-dictionary-type": "warn",
      "effect/no-runtime-typeof": "warn",
      "effect/use-clock-service": "warn",
      "effect/imperative-loops": "warn",
      "effect/avoid-native-object-helpers": "warn",
      "effect/avoid-non-null-assertion": "warn",
      "effect/avoid-any": "warn",
      "effect/avoid-untagged-errors": "warn",
      "effect/avoid-direct-json": "warn",
      "effect/prefer-effect-is": "warn",
      "effect/effect-run-in-body": "warn",
      "effect/no-barrel-imports": "warn",
      "effect/prefer-option-over-null": "warn",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",

      // ---- `suspicious` / `perf` / plugin rules this library opts out of ----
      // Effect code builds its handlers, layers and schema transformations
      // as closures over their arguments; hoisting each one out of its
      // factory would scatter one definition across a module.
      "unicorn/consistent-function-scoping": "off",
      // The module-as-namespace convention (`Option`, `Schema`, `Query`, …)
      // and the generic `R` / `A` / `E` parameters mean names deliberately
      // recur in nested scopes.
      "eslint/no-shadow": "off",
      // `_tag` is Effect's discriminant and `_`-prefixed bindings are the
      // unused-on-purpose convention `no-unused-vars` above honours.
      "eslint/no-underscore-dangle": "off",
      // Conditional members are spread in (`...definedMember(…)`) so an
      // absent one stays absent under `exactOptionalPropertyTypes`; the
      // copies are small, immutable error and fixture objects.
      "oxc/no-map-spread": "off",
      // `Effect.catch(effect, f)` takes two arguments; the rule reads every
      // `.catch` as `Promise#catch`.
      "promise/valid-params": "off",
      // `expect(value, message)` is Vitest API, and the suites assert through
      // helpers (`expectReject`, `assertFails`, …) the rule cannot see into.
      "vitest/valid-expect": "off",
      "vitest/expect-expect": "off",
      // Test titles are computed (`it(name, …)` in table-driven helpers).
      "vitest/valid-title": "off",
      // Many `toThrow()` assertions pin only that a sync decode throws; the
      // message is Effect's, not ours, and checking it would test Effect.
      "vitest/require-to-throw-message": "off",
      // The Effect preset's `avoid-native-object-helpers` counts every native
      // `Set` as debt, so trading a short constant array for one would add a
      // site there (#436) to clear one here.
      "unicorn/prefer-set-has": "off",
      // Reports prose comments that mention `expect(` as commented-out tests.
      "vitest/no-commented-out-tests": "off",
    },
    overrides: [
      // Type-level tests exist to be *checked*, not run: every binding is a
      // compile-time assertion that no runtime code reads.
      {
        files: ["**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
          "effect/avoid-ts-ignore": "off",
        },
      },
      // effect's `HttpApiEndpoint` constructors guard their `error` option with
      // a conditional type (`ErrorNoStream`) that no generic error list can
      // satisfy: TypeScript defers a conditional type over a type parameter,
      // and `ErrorNoStream` is not exported, so no local type or helper can
      // prove it either (#436). Our error wires never stream, so each
      // constructor call in this file carries an expect-error directive on
      // the `error:` property (and, under TS7, on the properties the failed
      // overload anchors at: AGENTS.md). Every other file, colocated tests
      // included, is held to `avoid-ts-ignore` at `error`; a compile-time
      // negative assertion goes in a `test/*.types.ts` file.
      {
        files: ["src/Endpoint.ts"],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // The schema tier: every module `src/schema.ts` reaches. That entry point
      // resolves `effect` and nothing else, and test/entry-points.test.ts keys
      // the externals it walks by specifier, so an `effect/Schema`-style
      // subpath import here fails it. The barrel is the only import these
      // files can use, so `no-barrel-imports` is not debt in them. A module
      // that joins the tier joins this list, and one that leaves it leaves:
      // test/entry-points.test.ts pins these `files` to its `SCHEMA_TIER`.
      {
        files: [
          "src/schema.ts",
          "src/Document.ts",
          "src/Filter.ts",
          "src/FlatQuery.ts",
          "src/Include.ts",
          "src/Relationship.ts",
          "src/Resource.ts",
          "src/Sort.ts",
          "src/internal/filter.ts",
          "src/internal/includeGraph.ts",
          "src/internal/media.ts",
          "src/internal/operators.ts",
          "src/internal/refusedClientId.ts",
          "src/internal/schemaExt.ts",
        ],
        rules: {
          "effect/no-barrel-imports": "off",
        },
      },
      // Build/test configs and the module-hook fixture are evaluated by Vite /
      // Vitest / Node in bare Node, before any Effect runtime exists — there
      // is no `Config` provider to read from and no `FileSystem` or
      // `ChildProcess` service to call, so `process.env` and `node:*` are the
      // only things that work there. The two artifact tests drive the built
      // package from outside, the same way: a module graph walk, and a
      // consumer project compiled by `tsc` in a temp directory.
      {
        files: [
          "**/vite.config.ts",
          "test/fixtures/**",
          "test/entry-points.test.ts",
          "test/declaration-emit.test.ts",
        ],
        rules: {
          "effect/avoid-node-imports": "off",
          "effect/avoid-sync-fs": "off",
          "effect/avoid-process-env": "off",
          "effect/use-console-service": "off",
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-command-executor-service": "off",
          "effect/avoid-native-fetch": "off",
          "effect/effect-promise-vs-trypromise": "off",
        },
      },
      // Tests that send requests one after another on purpose (a case per
      // malformed key, each answer checked before the next is sent), and the
      // prototype-pollution probes that define a member on Object.prototype
      // to prove the codecs ignore it.
      {
        files: ["**/*.test.ts"],
        rules: {
          "eslint/no-await-in-loop": "off",
          "eslint/no-extend-native": "off",
        },
      },
      // The consumer project test/declaration-emit.test.ts compiles lives in
      // a temp directory made in `beforeAll` and removed in `afterAll`,
      // around every case, outside any Effect scope.
      {
        files: ["test/declaration-emit.test.ts"],
        rules: {
          "effect/use-temp-file-scoped": "off",
        },
      },
    ],
    // Type-aware linting is intentionally disabled: type checking stays the
    // `typecheck` tasks' job (native tsc, Effect-patched).
    options: {
      typeAware: false,
      typeCheck: false,
    },
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // The CI type gate, as one task: the sources + colocated tests + the
      // type-level tests (`typecheck`), the emitted declarations
      // (`typecheck:dist`, which builds `dist/` first), and every example.
      // A pure graph node.
      check: {
        command: "echo 'check: every type gate green'",
        dependsOn: [
          "typecheck",
          "typecheck:dist",
          "@thomasfosterau/effect-jsonapi-example-blog#check",
          "@thomasfosterau/effect-jsonapi-example-github#check",
          "@thomasfosterau/effect-jsonapi-example-northwind#check",
        ],
        cache: false,
      },
      typecheck: {
        command: "tsc -p tsconfig.json",
        cache: {
          input: cacheInputs,
          output: [],
        },
      },
      // The other type-level tests resolve the package to ./src; this one
      // resolves it to the built ./dist/index.d.ts, which is what consumers
      // actually see. See test/emitted/requirements.types.ts.
      "typecheck:dist": {
        command: "tsc -p tsconfig.dist.json",
        dependsOn: ["build"],
        cache: {
          input: [...cacheInputs, "dist/**"],
          output: [],
        },
      },
      // Emits `dist/`: the JavaScript with `vp pack` (see the `pack` block
      // below), then one declaration file per source module with `tsc`
      // (tsconfig.build.json, which says why the declarations are not bundled).
      build: {
        command: "vp pack && tsc -p tsconfig.build.json",
        cache: {
          input: cacheInputs,
          output: ["dist/**"],
        },
      },
      "test:unit": {
        command: "vp test run",
        cache: {
          env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
          input: cacheInputs,
          output: [],
        },
      },
      // The root unit suite under one Istanbul coverage map
      // (`coverage/coverage-final.json`), which `fallow audit` reads for exact
      // per-function CRAP scores (`health.coverage` in .fallowrc.json).
      // Without it fallow estimates every function as uncovered, and any
      // function with cyclomatic complexity ≥ 5 fails the gate on its own.
      // Run this before `fallow audit` (the Claude Code PreToolUse fallow gate
      // runs the audit on `git commit` / `git push` but never refreshes this
      // map). Depends on `build` because test/entry-points.test.ts walks
      // `dist/`.
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: ["build"],
        cache: false,
      },
      // Type-checks AND executes every JSDoc `@example`, and generates the API
      // docs under docs/. Not part of `check`: it is a separate CI step, so a
      // broken example fails visibly on its own line. Depends on `build`
      // because docgen 4.x resolves an example's package imports through the
      // package's `exports`, i.e. against `dist/`, not `src/`.
      docgen: {
        command: "docgen",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
  resolve: {
    // Lets the tests import the library by its package name and subpaths,
    // exactly like user code does, resolved to the sources. Anchored
    // patterns, so the root cannot swallow a subpath by prefix.
    alias: [
      {
        find: /^@thomasfosterau\/effect-jsonapi$/,
        replacement: fileURLToPath(new URL("./src/index.ts", import.meta.url)),
      },
      {
        find: /^@thomasfosterau\/effect-jsonapi\/(schema|[A-Z]\w*)$/,
        replacement: `${fileURLToPath(new URL("./src/", import.meta.url))}$1.ts`,
      },
    ],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    coverage: {
      provider: "istanbul",
      reporter: ["text-summary", "json-summary", "json"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["**/*.d.ts", "**/*.test.ts"],
    },
    ...workerOptions,
  },
  // The published JavaScript: one ESM entry per `package.json` export — the
  // root barrel, the schema barrel and every public module (`src/[A-Z]*.ts`,
  // published as `@thomasfosterau/effect-jsonapi/<Module>`, #385) — with the
  // code they share split into hashed chunks, so each module is evaluated
  // once whichever entry reaches it, and `Resource.make` from the root and
  // from `./Resource` is the same function. test/entry-points.test.ts pins
  // the entries to the exports map. `effect` is a peer and stays external.
  // `platform: "neutral"` because the library runs wherever Effect does —
  // Workers included — and must not pick up Node built-ins.
  //
  // No `dts` here: bundled declarations put a module's types in a hashed
  // chunk under mangled names, which a consumer's declaration emit cannot
  // name. The `build` task emits them per module with `tsc` instead.
  pack: {
    entry: ["src/index.ts", "src/schema.ts", "src/[A-Z]*.ts", "!src/**/*.test.ts"],
    format: "esm",
    platform: "neutral",
    dts: false,
    sourcemap: false,
    clean: true,
    fixedExtension: false,
  },
});
