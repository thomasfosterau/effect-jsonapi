## Summary

Describe what changed and why. If this closes an issue, add `Closes #N` so it auto-closes on merge to `main`.

## Validation

Tick what you ran. Pre-commit covers format + lint; there is no pre-push hook.

- [ ] `vp check`
- [ ] `vp run check` (sources, type-level tests, examples, emitted declarations)
- [ ] `vp run -r test:unit`
- [ ] `vp run build`
- [ ] `vp run docgen` (every JSDoc `@example` compiled and executed)
- [ ] `fallow audit --base origin/main`
- [ ] A changeset under `.changeset/` for every published-package change

## Notes

Anything reviewers should pay special attention to: exported signatures, declaration-emit shape, the `effect` peer range, spec-compliance behaviour.
