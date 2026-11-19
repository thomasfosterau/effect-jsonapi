# Claude Code

Read README.md, docs/CONTRIBUTING.md and AGENTS.md (imported below).

- **PreToolUse** (`.claude/settings.json`): a `git commit` / `git push` runs the project's `fallow audit` against `origin/trunk` and is blocked on a `fail` verdict. Run `vp run test:coverage` first so the audit has the coverage map.
- **PostToolUse**: every edited source, JSON, CSS or Markdown file is formatted with `vp fmt`.
- Worktrees go under `.claude/worktrees/` (git-ignored); run `vp install` in a new one.

@../README.md @../docs/CONTRIBUTING.md @../AGENTS.md
