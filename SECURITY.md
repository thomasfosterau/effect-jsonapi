# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-jsonapi/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected version.

## Supply-chain hardening

This package is published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI. The publish step is `pnpm publish`, which performs trusted publishing itself as of pnpm 11 (and is what resolves the `catalog:peers` peer range in the published manifest), so no unpinned npm CLI is installed in the job.
- **Provenance (once public).** Nothing in the pipeline requests [npm provenance](https://docs.npmjs.com/generating-provenance-statements) — the statement cryptographically linking an artifact to its source commit and workflow. With no `pnpm_config_provenance`, pnpm attaches it only when the OIDC token reports a public repository and the package is public; this repository is private, so releases carry none today (pnpm warns `ERR_PNPM_PROVENANCE_INSUFFICIENT_INFORMATION`). pnpm 11 reads the setting only from `pnpm_config_*`, so `NPM_CONFIG_PROVENANCE` does nothing, and forcing it on (`--provenance`, `pnpm_config_provenance=true`) would make npm reject a publish from a private repository.
- **Install scripts disabled in CI.** Every workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, so a compromised (transitive) dependency cannot execute install hooks in a privileged job; the release job also turns off pnpm 11's `verify-deps-before-run` (`pnpm_config_verify_deps_before_run: "false"`), which would otherwise re-install _with_ scripts before a later `pnpm run` once a manifest looks newer than the install. In CI and the canary the one lifecycle script that does run is this repository's own `prepare` (`vp config && effect-tsgo patch --typescript --oxlint`, which swaps in the Effect-patched TypeScript and oxlint binaries every gate runs on); the composite setup action runs it as its own visible step (`pnpm run prepare`) rather than by dropping the flag. Those jobs hold only read permissions. The release job runs **no** lifecycle script: it skips that step (`run-prepare: "false"` — the build emits a byte-identical `dist/` without the patch), and publishes with `pnpm publish --ignore-scripts`, so neither the package's `prepublishOnly` (a rebuild the workflow has already done) nor its `prepare` runs while the job holds `id-token: write`. Locally, `pnpm-workspace.yaml`'s `allowBuilds` is the same gate: a dependency's install script runs only if it is listed there.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; Dependabot proposes updates for review.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
