# claude-team boilerplate

Multi-agent pipeline for Claude Code: architect → implementer → test-runner → two reviewers → loop until approved → report. Commits are physically blocked by a hook until the current diff is approved.

## Setup

```bash
cp -r .claude scripts CLAUDE.md /path/to/your/repo/
cat .gitignore.append >> /path/to/your/repo/.gitignore
cd /path/to/your/repo && chmod +x scripts/*.sh
```

Requires `jq`. Fill in the "Project conventions" section in `CLAUDE.md` — subagents read it at startup.

If `.claude/agents/` didn't exist before the session started — restart `claude`.

## Usage

```
/feature add idempotency-key support to POST /payments
/review                       # review of hand-made changes before committing
@architect ...                # any role can be invoked directly
```

## What's where

| File | Role |
|---|---|
| `agents/architect.md` | planning, read-only, opus, project memory |
| `agents/implementer.md` | code + tests, inherits the session model, doesn't commit |
| `agents/reviewer.md` | review, read-only, project memory, strict verdict format |
| `agents/security-reviewer.md` | security review, read-only |
| `agents/test-runner.md` | haiku, runs typecheck/lint/tests, returns only failures |
| `agents/product.md` | PM: hypotheses from `PRODUCT.md` + code + issues, specs from approved ones; project memory, learns from your scores |
| `skills/product/SKILL.md` | `/product` — hypothesis cards → you score 1–5 → logged in PRODUCT.md |
| `skills/spec/SKILL.md` | `/spec H3` — hypothesis → issue with acceptance criteria and the `agent-ready` label |
| `PRODUCT.md` | The single source of product truth for agents. Vision, metrics, roadmap, Rejected, hypothesis log |
| `skills/feature/SKILL.md` | the pipeline itself — orchestration and iteration limits |
| `skills/review/SKILL.md` | review without the pipeline |
| `scripts/guard-commit.sh` | PreToolUse hook: blocks `git commit/push` without approval, blocks `--no-verify`/`--force` |
| `scripts/approve.sh` | writes the hash of the approved diff; the hook checks it and consumes the marker on commit |
| `scripts/post-edit.sh` | PostToolUse: prettier + eslint on the changed file |
| `settings.json` | hooks, allow/deny, subagent nesting depth |

## Roles: who reports to whom

Two role groups, and they don't mix:

- **Product loop** (`product`): what to build. Input — `PRODUCT.md`, signals, code. Output — hypotheses and specs. The human is the judge here: the agent generates, you score.
- **Engineering loop** (`architect → implementer → test-runner → reviewer + security-reviewer`): how to build it. Input — an issue with a spec. Output — a PR.

There's deliberately no separate "project manager / task manager" role: orchestration is the `/feature` skill (ordering, iteration limits) and the dispatcher (which task to pick up). Making it an agent would just add another layer of judgment between you and the work, with no new information.

Verdict precedence when they disagree: security-reviewer > reviewer > test-runner > implementer. No numeric weights — at this scale they wouldn't add anything, and comparing configurations is a job for an eval harness.

## The whole loop

```
/product  →  you score  →  /spec H<n>  →  issue [agent-ready]  →  /feature or dispatcher  →  PR  →  you merge
```

## What to tune for yourself

- Models: `model:` in the frontmatter. `fable` for the architect/review, if available.
- `isolation: worktree` for the implementer — if you want it to work in a separate repo copy. Off by default, so reviewers see the diff in the same checkout.
- Iteration limits — in `skills/feature/SKILL.md` (2 attempts on tests, 3 review rounds).
- Commands in `post-edit.sh` and `test-runner.md` — tune for your own package.json.
- `permissions.allow` — extend it for your own commands so subagents don't ask for permission.
- Want the reviewer to delegate checking each finding itself — give it `Agent` back in tools (currently cut, so it stays strictly read-only).

## Known limitations

- The hook fixes the diff by hash: any edit after approval (even formatting) requires a fresh `/review`. This is intentional.
- Subagents don't see the main session's conversation — all context has to go into the delegating message. `/feature` does this; for manual `@`-invocations, pass it yourself.
- If the session is in `bypassPermissions` or `auto`, subagents' `permissionMode` is ignored — the hooks still run.
