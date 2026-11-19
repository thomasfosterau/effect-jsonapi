## Summary

Describe what changed and why. Link the issue it closes, if any.

## Verification

Tick what you ran, in the order of [docs/CONTRIBUTING.md](https://github.com/thomasfosterau/effect-jsonapi/blob/trunk/docs/CONTRIBUTING.md#before-pushing), and quote any failure. Pre-commit covers format + lint; there is no pre-push hook.

- [ ] `vp run build`
- [ ] `vp check`
- [ ] `vp run check` (sources, type-level tests, examples, emitted declarations)
- [ ] `vp run -r test:unit`
- [ ] `vp run docgen` (every JSDoc `@example` compiled and executed)
- [ ] `vp exec fallow audit --base origin/trunk`

## Changeset

Which `.changeset/*.md` this adds and its bump, or why none is needed (docs-, CI- and tooling-only changes need none).

- [ ] A changeset under `.changeset/` for every change to published behaviour

## Notes

Anything reviewers should pay special attention to: exported signatures, declaration-emit shape, the `effect` peer range, spec-compliance behaviour.
