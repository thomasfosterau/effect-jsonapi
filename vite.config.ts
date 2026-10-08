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
import effect from "@mpsuesser/oxlint-plugin-effect";
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
    categories: {
      correctness: "error",
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
      // zero — a new site is a defect, not headroom. Counted at adoption
      // (`vp lint`, 2026-09-18): 693 `require-safety-comment-for-type-
      // assertion`, 524 `casting-awareness`, 282 `prefer-option-over-null`,
      // 269 `avoid-native-object-helpers`, 245 `avoid-non-null-assertion`.
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
      "effect/no-known-value-widening": "warn",
      "effect/no-conditional-empty-object-spread": "warn",
      "effect/avoid-object-type": "warn",
      "effect/no-unknown-parameters": "warn",
      "effect/no-unknown-returns": "warn",
      "effect/no-object-parameters": "warn",
      "effect/prefer-match-over-switch": "warn",
      "effect/use-console-service": "warn",
      "effect/require-effect-concurrency": "warn",
      "effect/use-random-service": "warn",
      "effect/prefer-duration-constructors": "warn",
      "effect/effect-promise-vs-trypromise": "warn",
      "effect/effect-catchall-default": "warn",
      "effect/avoid-data-tagged-error": "warn",
      // `@ts-expect-error` is the assertion mechanism of the type-level tests
      // (see the `*.types.ts` override below, where it is off); in the sources
      // it marks the `ErrorNoStream` guard effect's endpoint constructors
      // cannot prove for a generic error list (src/Endpoint.ts).
      "effect/avoid-ts-ignore": "warn",
      // Naming rules. This is a published API whose names are its contract:
      // `Resource.Schema`-style suffixes, `Any` / `AnySpec` shapes and
      // `maybe*` readers cannot be renamed for a lint rule.
      "effect/no-shape-in-symbol-names": "warn",
      "effect/require-schema-type-alias": "warn",
      "effect/avoid-schema-suffix": "warn",
      "effect/require-is-prefix-for-boolean-schema-field": "warn",
      "effect/maybe-prefix-requires-option": "warn",
      "effect/imperative-loops": "warn",
      "effect/avoid-native-object-helpers": "warn",
      "effect/avoid-non-null-assertion": "warn",
      "effect/avoid-any": "warn",
      "effect/avoid-untagged-errors": "warn",
      "effect/avoid-direct-json": "warn",
      "effect/prefer-arr-match": "warn",
      "effect/no-length-comparison": "warn",
      "effect/prefer-arr-sort": "warn",
      "effect/avoid-try-catch": "warn",
      "effect/yield-in-for-loop": "warn",
      "effect/prefer-effect-is": "warn",
      "effect/avoid-expect-in-if": "warn",
      "effect/effect-run-in-body": "warn",
      "effect/prefer-effect-fn": "warn",
      "effect/avoid-direct-tag-checks": "warn",
      "effect/avoid-option-getorthrow": "warn",
      "effect/no-barrel-imports": "warn",
      "effect/throw-in-effect-gen": "warn",
      "effect/prefer-option-over-null": "warn",
      "typescript/no-explicit-any": "off",
      "typescript/no-empty-object-type": "off",
      "typescript/ban-ts-comment": "off",
      "unicorn/no-empty-file": "off",
      "vite-plus/prefer-vite-plus-imports": "error",
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
      // Build/test configs, the docgen runner and the module-hook fixture are
      // evaluated by Vite / Vitest / Node in bare Node, before any Effect
      // runtime exists — there is no `Config` provider to read from and no
      // `FileSystem` or `ChildProcess` service to call, so `process.env` and
      // `node:*` are the only things that work there.
      {
        files: ["**/vite.config.ts", "scripts/**", "test/fixtures/**", "test/entry-points.test.ts"],
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
        input: cacheInputs,
        output: [],
      },
      // The other type-level tests resolve the package to ./src; this one
      // resolves it to the built ./dist/index.d.ts, which is what consumers
      // actually see. See test/emitted/requirements.types.ts.
      "typecheck:dist": {
        command: "tsc -p tsconfig.dist.json",
        dependsOn: ["build"],
        input: [...cacheInputs, "dist/**"],
        output: [],
      },
      // Emits `dist/` (one bundle per entry point plus its declarations) with
      // `vp pack` — see the `pack` block below.
      build: {
        command: "vp pack",
        input: cacheInputs,
        output: ["dist/**"],
      },
      "test:unit": {
        command: "vp test run",
        env: ["VITEST_MAX_WORKERS", "NODE_OPTIONS"],
        input: cacheInputs,
        output: [],
      },
      // Type-checks AND executes every JSDoc `@example`, and generates the API
      // docs under docs/. Not part of `check`: it is a separate CI step, so a
      // broken example fails visibly on its own line. docgen itself skips the
      // `@example` in a class's own doc comment (#276); the second sub-task
      // checks and runs those through the same pipeline.
      docgen: {
        command: "docgen && tsx scripts/docgen-class-examples.ts",
        cache: false,
      },
    },
  },
  resolve: {
    alias: {
      // Lets the tests import the library by its package name, exactly like
      // user code does. The subpath entry must come first: string aliases
      // match by prefix, so the root entry would otherwise swallow
      // "@thomasfosterau/effect-jsonapi/schema".
      "@thomasfosterau/effect-jsonapi/schema": fileURLToPath(
        new URL("./src/schema.ts", import.meta.url),
      ),
      "@thomasfosterau/effect-jsonapi": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    ...(process.env.VITEST_MAX_WORKERS
      ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
      : {}),
  },
  // The published artifact: one ESM bundle per entry point (`dist/index.js`,
  // `dist/schema.js`, sharing chunks for the schema-tier modules both reach)
  // plus bundled declarations. `effect` is a peer and stays external.
  // `platform: "neutral"` because the library runs wherever Effect does —
  // Workers included — and must not pick up Node built-ins.
  pack: {
    entry: ["src/index.ts", "src/schema.ts"],
    format: "esm",
    platform: "neutral",
    dts: true,
    sourcemap: false,
    clean: true,
    fixedExtension: false,
  },
});
