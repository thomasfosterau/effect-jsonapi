# AGENTS.md

Read [README.md](README.md) and [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) first.

- You may open pull requests in this repository. Use the GitHub MCP tools or `gh`, and pass `-R thomasfosterau/effect-jsonapi` when the cwd might be another checkout. Write only to this repository.
- Out-of-scope work you notice: file an issue and move on. Non-idiomatic Effect code (hand-rolled utilities Effect provides, Promise chains, `null` where `Option` fits, …) gets an issue listing the sites and the idiomatic replacement; fix it in your PR only if it's trivial.
- The issue is the spec; later comments override the body. Re-check its claims against `trunk`.
- Report each gate you ran with its result, and say which couldn't run and why.

## Pitfalls

- `vp run docgen` executes examples; `vp check` and `vp run check` passing doesn't mean they run.
- `typecheck:dist`, `test/entry-points.test.ts` and `docgen` read `dist/`: build first.
- A new query family goes in both the flat and the nested struct in `Query.schema` ([docs/architecture.md](docs/architecture.md)).
- Publish only through the Release workflow (`vp run release`; there is no publish script). Release-path registry calls go through `vp pm`, never `npm` / `pnpm` directly; rely on `vp pm publish -r` skipping published versions.

## Fallow

The pre-commit hook runs `vp run fallow:audit` and blocks a commit on findings the change introduces; fix them rather than skipping the hook. Run `fallow dead-code --trace <file>:<export>` before deleting an "unused" export.

`vp install` links the `fallow` skill into `.claude/skills/fallow` from the installed package (approved under `permissions` in `pnpm-workspace.yaml`).
