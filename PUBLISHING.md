# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets)
and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers)
— there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security
rationale behind the pipeline.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump
   (`patch` / `minor` / `major`) and write a user-facing summary, then commit the
   generated file alongside your change. (Changes that don't affect the published
   package — docs, CI, examples — need no changeset.)
2. **Merge to `main`.** The [`release`](./.github/workflows/release.yml) workflow
   runs and, while changesets are pending, opens or updates a **"Version Packages"**
   PR that applies the version bump and rolls the changesets into `CHANGELOG.md`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow
   publishes the new version to npm (with provenance) via the npm CLI and trusted
   publishing, then tags the commit and creates the GitHub release.

The publish step uses the npm CLI (`npm publish`) rather than `pnpm publish`
because pnpm does not yet support npm OIDC trusted publishing
([pnpm#9812](https://github.com/pnpm/pnpm/issues/9812)); `changeset tag` then
emits the `New tag:` lines the Changesets action uses to push the tag and create
the GitHub release.

## The published artifact

`pnpm run check:packaging` (also a CI step) asserts all of the below against the
real tarball: [`publint`](https://publint.dev), [`arethetypeswrong`](https://arethetypeswrong.github.io)
under the `esm-only` profile, and the bundler assertions in
[`scripts/packaging.ts`](./scripts/packaging.ts).

### Entry points

The package root exports every module as a namespace and is the entry point the
README and the API docs are written against. Each module is _also_ published at
its own subpath, named exactly after the module:

```ts
import { Document } from "@thomasfosterau/effect-jsonapi" // the whole library
import * as Document from "@thomasfosterau/effect-jsonapi/Document" // just this module
```

Both resolve to the same file, so a resource definition imported through one is
referentially identical to the same definition imported through the other —
which matters, because `Relationship.one(() => Resource)` resolves its target by
identity.

Subpaths exist for one reason: **ten of the fourteen modules need `effect` and
nothing else**, and reaching them through the root barrel drags
`effect/unstable/httpapi` in with them. While `effect/unstable/*` is pre-stable,
that is a version-compatibility surface a client, a document consumer or a code
generator has no reason to carry — and tree-shaking cannot help, because a
bundler may drop the code but cannot drop the peer.

| Tier        | Modules                                                                                                  | Resolves                             |
| ----------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| Schema-only | `Atomic`, `Client`, `Document`, `Filter`, `Handlers`, `Lid`, `Query`, `Relationship`, `Resource`, `Sort` | `effect`                             |
| HTTP        | `ApiError`, `Endpoint`, `Group`, `Middleware`                                                            | `effect` + `effect/unstable/httpapi` |

The tier table is pinned in [`test/module-graph.test.ts`](./test/module-graph.test.ts)
and asserted in both directions, so moving a module between tiers fails the test
and has to be a decision rather than a drift. `src/internal/` is deliberately not
exported.

### `sideEffects: false`

Every module is pure — schema definitions, codecs, constructors — so the
declaration is accurate, and it lets a bundler drop the modules a consumer
doesn't reach through the root barrel.

### Why `src/` ships

`files` includes `src/` (minus tests) on purpose. The build emits
`declarationMap` and `sourceMap`, whose `sources` point at `../src/*.ts`, so
shipping the sources is what makes "go to definition" land on real code and
stack traces resolve in a consumer's debugger. Dropping `src` while keeping the
maps would leave them dangling; dropping both would trade roughly 560 KB
unpacked (a 308 KB tarball today) for the loss of that.

`src/internal/` rides along as a consequence. That is acceptable because it is
unreachable through the exports map — `@internal` is enforced by packaging, not
only by convention.

## Maintainer setup (one-time)

The package is already published (the initial `0.0.0` bootstrap is done), so the
following steps make the automated flow work end-to-end:

1. **Allow Actions to open the Version Packages PR.** In the repo:
   **Settings → Actions → General → Workflow permissions** → enable
   **"Allow GitHub Actions to create and approve pull requests"**. Without this the
   built-in `GITHUB_TOKEN` is forbidden from opening pull requests and the workflow
   fails at the PR-creation step — even though the job already grants
   `pull-requests: write`.
2. **Configure the trusted publisher.** On npmjs.com, open the package →
   **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/effect-jsonapi`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** **Settings → Environments → `release`** →
   enable **Required reviewers** (yourself) and restrict deployment to the `main`
   branch, so publishing pauses for manual approval.
4. **Protect `main`.** Require pull requests and passing CI before merge, and
   disallow direct pushes, so a release can only be triggered by merging the
   reviewed "Version Packages" PR.
