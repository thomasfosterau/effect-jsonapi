# Publishing & releases

Releases are automated with [Changesets](https://github.com/changesets/changesets) and published to npm via [OIDC trusted publishing](https://docs.npmjs.com/trusted-publishers) — there is no `NPM_TOKEN`. See [SECURITY.md](./SECURITY.md) for the security rationale behind the pipeline.

## The release flow

1. **Add a changeset with your change.** Run `pnpm changeset`, pick the bump (`patch` / `minor` / `major`) and write a user-facing summary, then commit the generated file alongside your change. (Changes that don't affect the published package — docs, CI, examples — need no changeset.)
2. **Merge to `main`.** The [`release`](./.github/workflows/release.yml) workflow runs and, while changesets are pending, opens or updates a **"Version Packages"** PR that applies the version bump and rolls the changesets into `CHANGELOG.md`.
3. **Merge the "Version Packages" PR.** With no changesets left, the workflow publishes the new version to npm via `pnpm publish` and trusted publishing (with provenance once the repository is public — see below), then tags the commit and creates the GitHub release.

The publish step uses `pnpm publish --ignore-scripts`, not `npm publish` (`--ignore-scripts` keeps `prepublishOnly` / `prepare` out of the id-token job; the workflow's Build step has already produced `dist/`, and the tarball is byte-identical either way): pnpm 11 performs npm OIDC trusted publishing itself (it mints the short-lived token and no longer delegates to the npm CLI, so the job never upgrades npm — [pnpm#9812](https://github.com/pnpm/pnpm/issues/9812) is closed), and it is what rewrites the `catalog:peers` specifier in `package.json` into the `effect` peer range consumers actually see; npm would publish the literal `catalog:` protocol. `changeset tag` then emits the `New tag:` lines the Changesets action uses to push the tag and create the GitHub release.

The release job sets `pnpm_config_verify_deps_before_run: "false"`. pnpm 11 otherwise checks dependencies before each `pnpm run` / `pnpm exec` and, when a manifest looks newer than the `--ignore-scripts` install, re-installs **with** scripts — running every `allowBuilds` dependency's build script inside the job that holds `id-token: write`. It is set on the job, not in `.github/actions/setup`, because CI and the canary share that action; the release job also passes the action `run-prepare: "false"`, so the repository's `prepare` (`effect-tsgo patch`) does not run there either. (pnpm 11 reads only the `pnpm_config_*` spelling of this setting.)

**Provenance.** Nothing in the pipeline requests [provenance](https://docs.npmjs.com/generating-provenance-statements): pnpm 11 takes settings like `provenance` only from `pnpm_config_*`, so the `NPM_CONFIG_PROVENANCE` this workflow used to set did nothing. With no `pnpm_config_provenance`, pnpm attaches provenance only when the OIDC token reports a **public** repository and the registry reports the package as public, and otherwise skips it (with an `ERR_PNPM_PROVENANCE_INSUFFICIENT_INFORMATION` warning while the repository is private). This repository is private, so releases carry no provenance statement today; they will once it is made public. Forcing it on (`--provenance`, `pnpm_config_provenance=true`) would make npm reject the publish from a private repository.

## Maintainer setup (one-time)

The package is already published (the initial `0.0.0` bootstrap is done), so the following steps make the automated flow work end-to-end:

1. **Allow Actions to open the Version Packages PR.** In the repo: **Settings → Actions → General → Workflow permissions** → enable **"Allow GitHub Actions to create and approve pull requests"**. Without this the built-in `GITHUB_TOKEN` is forbidden from opening pull requests and the workflow fails at the PR-creation step — even though the job already grants `pull-requests: write`.
2. **Configure the trusted publisher.** On npmjs.com, open the package → **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/effect-jsonapi`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** **Settings → Environments → `release`** → enable **Required reviewers** (yourself) and restrict deployment to the `main` branch, so publishing pauses for manual approval.
4. **Protect `main`.** Require pull requests and passing CI before merge, and disallow direct pushes, so a release can only be triggered by merging the reviewed "Version Packages" PR.
