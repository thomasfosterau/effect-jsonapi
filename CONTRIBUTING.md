# Contributing to effect-jsonapi

Thank you for your interest in contributing to `@thomasfosterau/effect-jsonapi`! This document
provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- Node.js 20.x or higher
- [pnpm](https://pnpm.io) — the repo pins a version via the `packageManager` field, so
  `corepack enable` will provision the right one automatically

### Getting Started

1. Fork the repository
2. Clone your fork:

   ```bash
   git clone https://github.com/YOUR_USERNAME/effect-jsonapi.git
   cd effect-jsonapi
   ```

3. Install dependencies:

   ```bash
   pnpm install --frozen-lockfile
   ```

4. Run the full check suite (type-check, lint, format, tests):

   ```bash
   pnpm run check
   ```

## Development Workflow

The repository is validated by the same commands in CI. Run them locally before opening a PR.

| Command                 | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `pnpm run build`        | Compile `src` to `dist` with `tsc`.                            |
| `pnpm run typecheck`    | Type-check sources, tests, examples and the type-level tests.  |
| `pnpm run lint`         | Lint with [oxlint](https://oxc.rs) (warnings fail).            |
| `pnpm run lint:fix`     | Apply oxlint's automatic fixes.                                |
| `pnpm run format`       | Format the codebase with [oxfmt](https://oxc.rs).              |
| `pnpm run format:check` | Verify formatting without writing changes.                     |
| `pnpm test`             | Run the test suite once with vitest.                           |
| `pnpm run test:watch`   | Run vitest in watch mode.                                      |
| `pnpm run docgen`       | Type-check & run every JSDoc `@example`; generate API docs.    |
| `pnpm run check`        | Run typecheck + lint + format:check + test (the full CI gate). |

## Code Style

- Use TypeScript for all code.
- Formatting is enforced by oxfmt (`.oxfmtrc.json`) — run `pnpm run format` before committing.
- Linting is enforced by oxlint (`.oxlintrc.json`).
- Use Effect's `Schema` patterns; derive everything from a single resource definition where possible.
- Document public APIs with JSDoc (see [Documentation](#documentation)).

## Documentation

Public API documentation follows the same JSDoc conventions as the `effect` package, so the surface
reads consistently and is ready for API-doc generation. When you add or change a public export:

- **Module header.** Each module starts with a JSDoc block describing the module, ending with a
  `@since` tag.
- **Every public export** gets a JSDoc block containing, in order:
  1. A concise description of what it is and when to reach for it.
  2. An `@example` for the principal, user-facing APIs (constructors, combinators, guards). Examples
     must be self-contained — include the imports — and use the public `JsonApi.*` surface exactly as
     a consumer would (e.g. `JsonApi.Resource(...)`, `JsonApi.Endpoint.fetch(...)`). Ground examples
     in real, type-checked usage from `examples/` and `test/` rather than inventing.
     [`@effect/docgen`](https://github.com/Effect-TS/docgen) compiles **and runs** every example
     (via `pnpm run docgen`, also in CI), so each one must be a complete program that type-checks and
     executes without throwing. Define every value an example references (use a function parameter or
     `Effect.gen` for context like handlers/clients you don't want to construct), and don't use
     `declare const` (it emits no runtime value).
  3. A `@since` tag (use the version the symbol was introduced; `0.1.0` for the initial surface).
  4. A `@category` tag. Use a consistent vocabulary: `constructors`, `combinators`, `models`,
     `schemas`, `guards`, `accessors`, `layers`, `services`, `errors`, `constants`, `type-level`,
     `utils`.
- Keep the existing prose when refining docs — improve clarity, don't delete useful explanation.
- Implementation-only exports that aren't part of the public surface should be marked `@internal`.

Run `pnpm run check` before committing; it type-checks the sources, tests and examples, so a broken
example pattern that you copied into a doc will usually surface there.

## Testing

- Add tests for new behaviour. Unit tests live alongside their source files (e.g. `src/Resource.test.ts`);
  each worked example is a standalone workspace package under `examples/` that carries its own
  end-to-end tests (e.g. `examples/northwind/test/`). `pnpm run check` runs them all across the workspace.
- Type-level expectations are asserted in `*.types.ts` files (checked by `pnpm run typecheck` via
  `@ts-expect-error`), not at runtime.
- Ensure `pnpm run check` passes before submitting a PR.

## Changesets

This project uses [Changesets](https://github.com/changesets/changesets) to manage versions and
changelogs. If your change affects the published package, add a changeset describing it:

```bash
pnpm run changeset
```

Pick the appropriate bump (`patch` / `minor` / `major`) and write a user-facing summary. The
changeset file is committed alongside your change; releases are published automatically when the
"Version Packages" PR is merged into `main`. See [PUBLISHING.md](./PUBLISHING.md) for the full
release flow and one-time maintainer setup.

## Commit Messages

- Use clear and descriptive commit messages.
- Start with a verb in present tense (e.g., "Add", "Fix", "Update").
- Reference issue numbers when applicable.

## Pull Request Process

1. Create a new branch for your feature/fix:

   ```bash
   git checkout -b feature/my-new-feature
   ```

2. Make your changes and commit them with clear messages.

3. Add a changeset if the published package is affected (see above).

4. Push to your fork and open a Pull Request against `main`.

5. Ensure your PR:
   - Has a clear description of the changes
   - Includes tests for new functionality
   - Passes `pnpm run check`
   - Updates documentation if needed

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Environment details (Node.js version, OS, `effect` version)
- Relevant code samples or error messages

## Feature Requests

Feature requests are welcome! Please:

- Check if the feature has already been requested
- Provide a clear use case
- Explain how it aligns with the JSON:API specification

## Scope

This library provides a type-safe, spec-compliant JSON:API v1.1 layer on top of Effect's `HttpApi`:
resources, errors, endpoints, typed query parameters, content-negotiation middleware and the atomic
operations extension. Contributions should keep compliance a property of construction — derived from
resource definitions rather than left to developer discipline — and compose with vanilla `HttpApi`,
`HttpApiBuilder`, `HttpApiClient`, `HttpApiTest` and `OpenApi`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
