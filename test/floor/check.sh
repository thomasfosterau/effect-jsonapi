#!/usr/bin/env bash
# Type-checks test/floor/consumer.ts against the PUBLISHED shape of this
# package and the lowest effect its peer range admits (#586).
#
#   test/floor/check.sh              # effect as pinned in package.json (4.1.0)
#   EFFECT_VERSION=4.0.6 test/floor/check.sh   # must FAIL: the bug it guards
#
# The package is installed from `pnpm pack`'s tarball, so the consumer sees
# `dist/` through `exports` and the manifest as published (catalog:peers
# replaced). Linking the repository instead would make dist/*.d.ts resolve
# `effect` from the root node_modules (the catalog pin), not from the fixture.
# The fixture is copied to a scratch directory first, so nothing is written
# under the repository, and installed with --ignore-workspace (it is not a
# workspace member). No lockfile: the tarball's integrity changes with every
# build; `effect` and the compiler are pinned exactly instead.
# Needs `vp run build` first. Uses the workspace's native `tsc` (TypeScript 7,
# the type checker of record).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

[ -f "$root/dist/index.d.ts" ] || { echo "dist/ is missing: run 'vp run build' first" >&2; exit 2; }

(cd "$root" && pnpm pack --pack-destination "$work/pack" >/dev/null 2>&1)
tarball="$(ls "$work"/pack/*.tgz)"

cp "$here/package.json" "$here/tsconfig.json" "$here/consumer.ts" "$work/"
cd "$work"
node -e '
  const fs = require("node:fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  pkg.dependencies["@thomasfosterau/effect-jsonapi"] = "file:" + process.argv[1];
  if (process.env.EFFECT_VERSION) pkg.dependencies.effect = process.env.EFFECT_VERSION;
  fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2));
' "$tarball"

pnpm install --ignore-workspace --ignore-scripts --no-frozen-lockfile >/dev/null
echo "effect $(node -p 'require("effect/package.json").version') / $("$root/node_modules/.bin/tsc" --version)"
"$root/node_modules/.bin/tsc" -p tsconfig.json
echo "floor check passed"
