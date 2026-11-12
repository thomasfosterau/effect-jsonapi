@../AGENTS.md @../CONTRIBUTING.md @../README.md

# CLAUDE.md

Claude Code-specific guidance. Everything agent-agnostic (gates, conventions, architecture, branches, tracker) is in the imported [AGENTS.md](../AGENTS.md); this file holds only what applies to Claude Code sessions here. The imports above are resolved relative to this file.

## Agent sessions

The SessionStart hook (`.claude/hooks/session-start.sh`, also the devcontainer's `postCreateCommand`) installs the global Vite+ CLI at the catalog's `vite-plus` pin with the official installer (npm-provenance and SHA-512 checked; it needs `vite.plus` and `viteplus.dev` on the environment's allowlist), links `vp` and `vpx` into `~/.local/bin` (the CLI lives under `$VP_HOME` when set, as in the Vite+ container image, else `~/.local/share/vite-plus`), and runs `vp install --frozen-lockfile` (which applies the tsgo patch). The global `vp` delegates to each checkout's own `vite-plus`, worktrees included. Everything else goes through Vite+: `vp exec fallow …` for fallow, `vpx <file>.ts` for scripts (`tsx` is installed only because docgen runs it itself). Nothing else is put on PATH; if the installer can't run, `vp` falls back to this checkout's `node_modules` copy. It hydrates no secrets; every gate runs offline.

Hooks registered in `.claude/settings.json` (`.claude/settings.local.json` is git-ignored and personal):

- **SessionStart** — `session-start.sh`, above.
- **PostToolUse** (`Write|Edit|MultiEdit`) — runs `vp fmt` on each edited file.
- **PreToolUse** (`Bash`) — `.claude/hooks/fallow-gate.sh` runs the fallow gate (through `vp exec fallow`) before `git commit` / `git push`. Run `vp run test:coverage` first: the gate reads that map and never refreshes it. It runs only in this checkout and its `.claude/worktrees/*`; for any other tree it skips the audit with a notice without running that tree's tooling.

## Worktrees

Agent work happens in git worktrees under `.claude/worktrees/` (git-ignored), one per branch: `git worktree add .claude/worktrees/<slug> -b issue-<n>-<slug> origin/trunk`. Start every command with an explicit `cd` into the worktree (the shell cwd resets between calls) and confirm with `git log -1` before committing.

## What cannot run in a cloud session

- No credential, database, browser or Docker is needed, but the Dev Container workflow (`.github/workflows/devcontainer.yml`) builds the container image and cannot run in a cloud session.
- The session-start installer needs `vite.plus` and `viteplus.dev` on the environment's network allowlist; without them `vp` falls back to the checkout's `node_modules` copy.
- GitHub Actions workflows (CI, Release, Dev Container) run only on GitHub; check them through the PR's checks.
- `uvx zizmor` needs network access to fetch zizmor unless it is already installed.

## Fallow local gate

Before any `git commit` or `git push`, run `fallow audit --format json --quiet --explain --gate-marker agent`. If the verdict is `fail`, fix the reported findings before retrying. Treat JSON runtime errors like `{ "error": true, ... }` as non-blocking. Audit defaults to `gate=new-only`: only findings introduced by the current changeset affect the verdict. The task map for the other fallow commands is in [AGENTS.md](../AGENTS.md#fallow-task-map).
