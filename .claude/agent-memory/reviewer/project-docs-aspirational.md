---
name: project-docs-aspirational
description: docs/todo/*.md and docs/adr/*.md describe the TARGET stack, not current state, and docs/todo is untracked-but-on-disk — verify against package.json/src before treating them as ground truth in review
metadata:
  type: project
---

`docs/todo/00-overview.md` (Russian, umbrella spec for the whole
`autonomous-payment-orchestrator` constellation) and the ADRs under `docs/adr/`
describe the **target** architecture, not what is built. Known divergences
observed 2026-09-03: overview §4 prescribes a `<repo>/test/` directory while
pay-core colocates `*.test.ts` next to sources in `src/`; Hono, Postgres/Drizzle,
Turborepo, Testcontainers and Inngest are all listed but not installed. (The
older "Node 22 vs engines >=24" divergence was fixed in the on-disk overview.)

`docs/todo/` and `.idea/` are deliberately **local-only**: `.gitignore` ignores
them and they were untracked with `git rm --cached`, but the files stay on disk
for agents to read. So "file not in git" is not the same as "file missing" here.

**Why:** the specs were written up-front for a portfolio monorepo and only
`packages/pay-core` has been implemented so far, so the docs run ahead of the
code by design; the owner keeps the sprawling Russian specs out of the public
repo while agents still consume them from the filesystem.

**How to apply:** when a diff cites a doc as justification, check the claim
against `package.json` / `pnpm-workspace.yaml` / actual `src` before accepting
it. Conversely, do not flag code as "violating the ADR/spec" until confirming
the relevant piece is meant to exist yet. Because `docs/todo/` is untracked,
flag any **tracked** file (README, ADR) that hyperlinks into it — those links
404 for anyone cloning. `CLAUDE.md` §"Project conventions" is the
verified-actual-state counterpart — if a diff makes it drift from reality, that
is a real defect. See [[repo-lint-not-wired]].
