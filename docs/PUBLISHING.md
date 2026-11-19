# Publishing

Releases use [Changesets](https://github.com/changesets/changesets) and npm [trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC); there is no `NPM_TOKEN`.

## Flow

1. Add a changeset with your change (`vp exec changeset`). Pre-1.0: `minor` for a breaking change, `patch` otherwise, never `major`.
2. On `trunk`, [release.yml](../.github/workflows/release.yml) opens or updates the "chore: version packages" PR and assigns it to the owner.
3. Merging that PR publishes: `pnpm publish --recursive --ignore-scripts` from the protected `release` environment (a no-op when npm already has the version), then `changeset git-tag` and a GitHub release. `pnpm publish` is what rewrites `catalog:peers` into the published peer range.

## One-time setup

1. **Settings → Actions → General**: allow GitHub Actions to create and approve pull requests.
2. **npm → package → Settings → Trusted Publisher**: GitHub Actions, repository `thomasfosterau/effect-jsonapi`, workflow `release.yml`, environment `release`. Remove classic tokens.
3. **Settings → Environments → `release`**: required reviewer (the owner), deployments from `trunk` only.
4. **`trunk` ruleset**: require pull requests and the `ci (node lts)` / `ci (node latest)` checks.

Provenance is attached only once the repository is public; forcing it from a private repository makes npm reject the publish.
