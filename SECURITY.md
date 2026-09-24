# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's [**Report a vulnerability**](https://github.com/thomasfosterau/effect-jsonapi/security/advisories/new) button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a description, reproduction steps, and the affected version.

## Supply-chain hardening

This package is published with a hardened, automated pipeline designed to resist supply-chain attacks (e.g. self-propagating npm worms that steal credentials and publish trojanized versions):

- **No long-lived npm token.** Releases use npm [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub Actions proves its identity to npm with a short-lived, workflow-bound OIDC token. There is no `NPM_TOKEN` secret to steal from CI. The publish step is `pnpm publish`, which supports trusted publishing as of pnpm 11 (and is what resolves the `catalog:peers` peer range in the published manifest).
- **Provenance.** Every published version carries [npm provenance](https://docs.npmjs.com/generating-provenance-statements), cryptographically linking the artifact to the exact source commit and workflow.
- **Install scripts disabled in CI.** Every workflow installs dependencies with `pnpm install --frozen-lockfile --ignore-scripts`, so a compromised (transitive) dependency cannot execute install hooks in a privileged job. The one lifecycle script that does run is this repository's own `prepare` (`vp config && effect-tsgo patch --typescript --oxlint`, which swaps in the Effect-patched TypeScript and oxlint binaries every gate runs on): it is first-party, and the composite setup action runs it as its own visible step (`pnpm run prepare`) rather than by dropping the flag. Locally, `pnpm-workspace.yaml`'s `allowBuilds` is the same gate: a dependency's install script runs only if it is listed there.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment that requires manual approval.
- **Locked dependencies.** Installs use `pnpm install --frozen-lockfile` against the committed `pnpm-lock.yaml`; Dependabot proposes updates for review.

## Release pipeline

The publishing pipeline and its one-time maintainer setup (trusted publisher, protected `release` environment, branch protection) are documented in [PUBLISHING.md](./PUBLISHING.md).
