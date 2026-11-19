# Security

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's [Report a vulnerability](https://github.com/thomasfosterau/effect-jsonapi/security/advisories/new) form, not in a public issue. Include a description, reproduction steps and the affected version.

## Supply chain

- **No long-lived npm token.** Publishing uses trusted publishing (OIDC) from a protected `release` environment that needs the owner's approval; only that job holds `id-token: write`.
- **No dependency scripts in privileged jobs.** The release jobs install with `--ignore-scripts` and set `pnpm_config_verify_deps_before_run: "false"`, so pnpm cannot re-install with scripts before `pnpm run`. Elsewhere, `allowBuilds` in pnpm-workspace.yaml lists the only dependency build scripts that run.
- **Pinned actions.** Workflows use exact release tags, locked to commits by `.github/workflows/actions.lock` and checked by the Lockfile workflow.
- **Least privilege.** Every workflow starts from `permissions: {}`; checkouts do not persist credentials; nothing a pull request (Dependabot's included) can trigger holds a secret. `uvx zizmor --offline .github` audits the workflows.
- **Locked, delayed dependencies.** Installs use the committed lockfile, and pnpm holds new versions for 8 hours (`minimumReleaseAge`).
