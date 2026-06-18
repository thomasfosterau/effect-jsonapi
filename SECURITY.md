# Security Policy

## Reporting a vulnerability

Please report security vulnerabilities privately via GitHub's
[**Report a vulnerability**](https://github.com/thomasfosterau/effect-jsonapi/security/advisories/new)
button (Security → Advisories), **not** through public issues.

You can expect an initial response within a few days. Please include a
description, reproduction steps, and the affected version.

## Supply-chain hardening

This package is published with a hardened, automated pipeline designed to resist
supply-chain attacks (e.g. self-propagating npm worms that steal credentials and
publish trojanized versions):

- **No long-lived npm token.** Releases use npm
  [**OIDC Trusted Publishing**](https://docs.npmjs.com/trusted-publishers): GitHub
  Actions proves its identity to npm with a short-lived, workflow-bound OIDC token.
  There is no `NPM_TOKEN` secret to steal from CI.
- **Provenance.** Every published version carries
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
  cryptographically linking the artifact to the exact source commit and workflow.
- **Install scripts disabled in CI.** Both CI and the release workflow install
  dependencies with `npm ci --ignore-scripts`, so a compromised (transitive)
  dependency cannot execute install hooks in a privileged job.
- **Pinned actions.** All GitHub Actions are pinned to full commit SHAs, so a
  hijacked tag cannot inject malicious workflow code.
- **Least privilege.** Workflows default to `permissions: {}`; each job opts into
  only the scopes it needs. CI checks out with `persist-credentials: false`.
- **Manual approval gate.** Publishing runs in a protected `release` environment
  that requires manual approval.
- **Locked dependencies.** Installs use `npm ci` against the committed
  `package-lock.json`; Dependabot proposes updates for review.

## Maintainer setup (one-time)

The release workflow (`.github/workflows/release.yml`) is ready to publish via
trusted publishing once these one-time steps are done:

1. **First publish.** Trusted publishing can only be configured for a package that
   already exists. Publish `0.1.0` once from a trusted machine with 2FA enabled:

   ```bash
   npm ci --ignore-scripts
   npm run build
   npm publish --access public --provenance
   ```

2. **Configure the trusted publisher.** On npmjs.com, open the package →
   **Settings → Trusted Publisher** and add:
   - Provider: **GitHub Actions**
   - Repository: `thomasfosterau/effect-jsonapi`
   - Workflow: `release.yml`
   - Environment: `release`

   Then remove any classic automation tokens for the package.

3. **Protect the `release` environment.** In the repo: **Settings → Environments →
   `release`** → enable **Required reviewers** (yourself) and restrict deployment
   to the `main` branch.

4. **Protect `main`.** Require pull requests and passing CI before merge, and
   disallow direct pushes, so a release can only be triggered by merging the
   reviewed "Version Packages" PR.

After this, releases are fully automated: merging a change adds a changeset, the
workflow opens a "Version Packages" PR, and merging that PR publishes to npm.
