# Team workflow

This repo uses a subagent team. Roles live in `.claude/agents/`.

- Non-trivial task → run `/feature <task>`. It goes architect → implementer → test-runner → reviewer + security-reviewer → loop → report.
- Hand-made changes → `/review` before committing.
- `git commit` is blocked by a hook until the current diff has been approved by both reviewers (`scripts/approve.sh` writes the marker; it is consumed by the commit).
- Never bypass the hook with `--no-verify`.

# Project conventions
- Stack: TypeScript (strict, ESM), pnpm workspaces monorepo, Node.js >=24. Per repo `@apo/pay-core` (`packages/pay-core`): Zod for validation, Vitest for tests. Planned but not yet wired: Hono (HTTP), PostgreSQL via Drizzle (only in-memory adapters exist today) — see `docs/todo/00-overview.md` §3 for the full target stack.
- Module layout: hexagonal (ports & adapters). `src/domain` + `src/app` (use-cases) depend only on interfaces in `src/ports`; concrete implementations live in `src/adapters`. Domain never imports a vendor SDK. See `docs/adr/0002-ports-and-adapters.md`.
- Error handling: typed `DomainError` subclasses with a `code` discriminator (`packages/pay-core/src/domain/errors.ts`), not string/generic errors.
- Logging: not yet decided/implemented.
- Tests: `pnpm test` (root, runs `vitest run` across packages) or `pnpm --filter @apo/pay-core test`.
- Typecheck: `pnpm run typecheck` (root) or `pnpm --filter @apo/pay-core typecheck`.
- Lint: no root `lint` script exists yet, and no eslint config is committed. `scripts/post-edit.sh` best-effort-runs `prettier --write` + `eslint --max-warnings=0` on each file after Edit/Write — currently a no-op until a config is added.

# Product loop
- `/product` — product agent proposes hypothesis cards; owner scores them 1–5.
- `/spec H<n>` — approved hypothesis → GitHub issue with acceptance criteria, label `agent-ready`.
- `PRODUCT.md` is the single source of product truth for agents. Keep it current.
- Verdict precedence in review: security-reviewer > reviewer > test-runner.
