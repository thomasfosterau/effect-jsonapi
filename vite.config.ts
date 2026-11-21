import { fileURLToPath } from "node:url";
import { recommended } from "@effect/tsgo/oxlint-presets";
import effect from "@enfect/oxlint";
import { defineConfig } from "vite-plus";

// Auto tracking minus node_modules churn, with the lockfile back so a
// dependency upgrade still invalidates a cached task.
const cacheInputs = [
  { auto: true },
  "!node_modules/**",
  "!examples/**",
  { pattern: "!node_modules/**", base: "workspace" as const },
  { pattern: "pnpm-lock.yaml", base: "workspace" as const },
];

const workerOptions = process.env.VITEST_MAX_WORKERS
  ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) }
  : {};

export default defineConfig({
  // Lint without fixes, so a type-aware autofix never lands unverified.
  staged: {
    "*.{js,mjs,ts,json,md,yml,yaml}": [
      "vp check --fix --no-lint",
      "vp check --no-fmt --no-error-on-unmatched-pattern",
    ],
  },
  fmt: {
    // CHANGELOG.md is written by Changesets; docs/api/ is docgen output.
    ignorePatterns: ["**/dist/**", "CHANGELOG.md", "docs/api/**"],
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
    // test/emitted/ and test/floor/ resolve the package through `dist/` or a
    // scratch install, so they are checked by their own tasks.
    ignorePatterns: [
      "**/dist/**",
      "**/node_modules/**",
      "**/coverage/**",
      "test/emitted/**",
      "test/floor/**",
    ],
    extends: [recommended, effect.configs.recommended],
    // `typeCheck` is off: tsrs's type check reports the Effect language
    // service's warnings (tsconfig.base.json's `diagnosticSeverity`) as errors,
    // ignoring `ignoreEffectWarningsInTscExitCode`. `vp run check` stays the
    // type gate.
    options: { typeAware: true, typeCheck: false },
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
      // Fires on every `as`, including the narrowings the conditional-type
      // machinery structurally requires.
      "effect/casting-awareness": "warn",
      // Never bind effect's `Record` module as `Record` (use `R`): it hides
      // the built-in from `no-unsafe-dictionary-type`.

      // ---- Staged rollout ------------------------------------------------
      // These sit at `warn` because existing code predates them. A new site
      // is a defect, not headroom: flip a rule back to `error` (delete its
      // line) when its count reaches zero.
      "effect/require-safety-comment-for-type-assertion": "warn",
      "effect/no-chained-type-assertions": "warn",
      "effect/prefer-effect-is": "warn",
      "typescript/no-unsafe-type-assertion": "warn",
      "typescript/no-unnecessary-type-parameters": "warn",
      "typescript/no-generated-empty-object-type": "warn",
      "effecttsgo/any-unknown-in-error-context": "warn",
      "effecttsgo/unsafe-effect-type-assertion": "warn",
      // Raised from the preset's `warn` so a new site fails the gate.
      "effecttsgo/multiple-effect-provide": "error",
      "effecttsgo/catch-conditional-refail-to-catch-if": "error",
      "effecttsgo/global-error-in-effect-failure": "error",
      "effecttsgo/schema-class-missing-brand": "error",
      "effecttsgo/unnecessary-typeof-type": "error",
      "effecttsgo/prefer-typed-schema-decoder": "error",
      "effecttsgo/schema-number": "error",
      "typescript/no-explicit-any": "error",
      // The HTTP surface this library is built on is `@stability unstable`.
      "effecttsgo/unstable-api-usage": "off",
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
      // Reports prose comments that mention `expect(` as commented-out tests.
      "vitest/no-commented-out-tests": "off",
      // `@effect/vitest`'s runners are test blocks too.
      "vitest/no-standalone-expect": [
        "error",
        {
          additionalTestBlockFunctions: [
            "it.effect",
            "it.live",
            "it.layer",
            "it.effect.each",
            "it.live.each",
          ],
        },
      ],
    },
    overrides: [
      // Tests and example programs are their own entry points.
      {
        files: ["**/*.test.ts", "examples/**"],
        rules: {
          "effecttsgo/strict-effect-provide": "off",
        },
      },
      // Type-level tests exist to be *checked*, not run: every binding is a
      // compile-time assertion that no runtime code reads.
      {
        files: ["**/*.types.ts"],
        rules: {
          "eslint/no-unused-vars": "off",
          "effect/avoid-ts-ignore": "off",
        },
      },
      // effect's `HttpApiEndpoint` constructors guard `error` with a deferred,
      // unexported conditional type (`ErrorNoStream`) no generic error list
      // can satisfy, so each call carries an expect-error directive.
      {
        files: ["src/Endpoint.ts"],
        rules: {
          "effect/avoid-ts-ignore": "off",
        },
      },
      // Run in bare Node, outside any Effect runtime.
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
          "effect/use-filesystem-service": "off",
          "effect/use-path-service": "off",
          "effect/use-command-executor-service": "off",
        },
      },
      // Sequential requests on purpose, and prototype-pollution probes.
      {
        files: ["**/*.test.ts"],
        rules: {
          "eslint/no-await-in-loop": "off",
          "eslint/no-extend-native": "off",
        },
      },
      {
        files: ["test/declaration-emit.test.ts"],
        rules: {
          "effect/use-temp-file-scoped": "off",
        },
      },
    ],
    jsPlugins: [
      {
        name: "vite-plus",
        specifier: "vite-plus/oxlint-plugin",
      },
    ],
  },
  run: {
    tasks: {
      // What CI runs. A shell chain, not `dependsOn`, so the gates run in
      // order and stop at the first failure.
      ci: {
        command: [
          "node --version",
          "vp run build",
          "vp check",
          "vp run --concurrency-limit 2 check",
          "vp run -r test:unit",
          "vp run docgen",
          "pnpm audit --audit-level high",
          "vp run typecheck:floor",
        ].join(" && "),
        cache: false,
      },
      // Every type gate: sources and type-level tests, the emitted
      // declarations, and the examples.
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
      // test/emitted/ against the built declarations consumers see.
      "typecheck:dist": {
        command: "tsc -p tsconfig.dist.json",
        dependsOn: ["build"],
        cache: {
          input: [...cacheInputs, "dist/**"],
          output: [],
        },
      },
      // A consumer of the packed package on the lowest `effect` the peer range
      // admits (test/floor/check.sh). Needs network.
      "typecheck:floor": {
        command: "bash test/floor/check.sh",
        dependsOn: ["build"],
        cache: false,
      },
      // JavaScript with `vp pack`, then per-module declarations with `tsc`.
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
      // The coverage map `fallow audit` reads; `build` because
      // test/entry-points.test.ts walks `dist/`.
      "test:coverage": {
        command: "vp test run --coverage",
        dependsOn: ["build"],
        cache: false,
      },
      // Blocks a commit on a `fail` verdict (.vite-hooks/pre-commit).
      "fallow:audit": {
        command: "vp exec fallow audit --base origin/trunk --quiet",
        dependsOn: ["test:coverage"],
        cache: false,
      },
      fallow: {
        command: "vp exec fallow --summary",
        cache: false,
      },
      // The Changesets steps release.yml runs: bump versions and changelogs,
      // then publish what npm does not have yet (`vp pm publish -r`, which
      // rewrites `catalog:` specifiers and publishes under OIDC) and tag it
      // (`changeset git-tag`, which reports the tag to changesets/action through
      // `CHANGESETS_OUTPUT`). Lifecycle scripts stay off in the privileged
      // publish job; a failed publish stops before tagging.
      version: {
        command: "changeset version && vp fmt && vp install --lockfile-only",
        cache: false,
      },
      release: {
        command: [
          "vp pm publish -r --access public --no-git-checks -- --ignore-scripts",
          "changeset git-tag",
        ],
        dependsOn: ["build"],
        cache: false,
      },
      // What `release` would publish, without publishing or tagging.
      "release:dry-run": {
        command: "vp pm publish -r --access public --dry-run --no-git-checks -- --ignore-scripts",
        dependsOn: ["build"],
        cache: false,
      },
      // Compiles and runs every JSDoc `@example` against `dist/`; writes the
      // API reference to docs/api/.
      docgen: {
        command: "docgen",
        dependsOn: ["build"],
        cache: false,
      },
    },
  },
  resolve: {
    // Tests import the package by name, resolved to `src/`.
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
  // One ESM entry per export, shared code in chunks. No `dts`: bundled
  // declarations put types in hashed chunks a consumer's declaration emit
  // cannot name, so `build` emits them per module with `tsc`.
  pack: {
    deps: {
      // tsdown <0.23 compatibility: resolve external dependency subpaths.
      // Remove to preserve subpath imports as written (the new default).
      // https://tsdown.dev/options/dependencies#deps-resolvedepsubpath
      resolveDepSubpath: true,
    },
    entry: ["src/index.ts", "src/schema.ts", "src/[A-Z]*.ts", "!src/**/*.test.ts"],
    format: "esm",
    platform: "neutral",
    dts: false,
    sourcemap: false,
    clean: true,
    fixedExtension: false,
  },
});
