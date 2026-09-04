# Team workflow

This repo uses a subagent team. Roles live in `.claude/agents/`.

- Non-trivial task → run `/feature <task>`. It goes architect → implementer → test-runner → reviewer + security-reviewer → loop → report.
- Hand-made changes → `/review` before committing.
- `git commit` is blocked by a hook until the current diff has been approved by both reviewers (`scripts/approve.sh` writes the marker; it is consumed by the commit).
- Never bypass the hook with `--no-verify`.

# Project conventions
<!-- Fill in: stack, test command, lint command, module layout, error-handling pattern, logging -->
- Stack: TypeScript / Node.js / PostgreSQL
- Tests: `npm test`
- Typecheck: `npm run typecheck`
- Lint: `npm run lint`

# Product loop
- `/product` — product agent proposes hypothesis cards; owner scores them 1–5.
- `/spec H<n>` — approved hypothesis → GitHub issue with acceptance criteria, label `agent-ready`.
- `PRODUCT.md` is the single source of product truth for agents. Keep it current.
- Verdict precedence in review: security-reviewer > reviewer > test-runner.
