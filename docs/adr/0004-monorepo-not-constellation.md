# 4. One monorepo, not a constellation of repos

Date: 2026-09-10

## Status

Accepted

## Context

The original plan (recorded only in the local, untracked planning doc for
this project, not in a prior ADR) was a "constellation" of five separate
GitHub repositories — `pay-core`, `durable-ledger`, `agent-orchestrator`,
`agent-evals`, `orchestra` — each with its own `apo-<name>` GitHub repo,
signaling five distinct, addressable projects to anyone browsing a GitHub
profile.

The actual scaffold never matched that plan: `pnpm-workspace.yaml` (`packages:
- "packages/*"`), the root `package.json` name
(`autonomous-payment-orchestrator`), and the `@apo/*` package scope were all
monorepo-shaped from the first commit. `pay-core` was built as
`packages/pay-core` inside that workspace and, when it briefly lived in its
own GitHub repo, needed the entire agent-team tooling — `.claude/agents`,
`.claude/skills`, `scripts/guard-commit.sh`, `.githooks/reference-transaction`,
`CLAUDE.md` — copied in and re-wired (`core.hooksPath`, a fresh
`.claude/.merge-approved` gate) before it could be worked on safely. That
tooling is not small: getting the trunk-protection git hook alone from a
naive first draft to something that couldn't be trivially bypassed took
several review rounds. Paying that cost once per component (five times) buys
nothing technical — the review gate, the branch workflow, and the
architect/implementer/reviewer roles are identical across every component in
this project, not component-specific.

## Decision

One repository: `infame/autonomous-payment-orchestrator`. Every component is
a package in the existing pnpm workspace: `packages/pay-core` (done),
`packages/durable-ledger`, `packages/agent-orchestrator`,
`packages/agent-evals`, `packages/orchestra`, as they're built. The
`apo-<name>`-per-repo naming convention is dropped along with the plan that
motivated it.

## Consequences

- One `CLAUDE.md`, one `.githooks/reference-transaction` gate, one
  `.claude/agents`/`.claude/skills` set for the whole project instead of five
  copies that would drift independently — the exact failure mode a small
  wording change already caused twice this session, in a single repo.
- Cross-component integration work (`durable-ledger` calling `pay-core`'s
  HTTP API and classifying its errors, later `agent-orchestrator` calling
  `durable-ledger`) happens against code checked out one directory over,
  not a separately-cloned, separately-versioned dependency.
- The portfolio signal shifts from "five repositories" to "one repository
  with clearly bounded packages, ADRs, and a real branch/review workflow" —
  a different signal, not a lesser one: recognizing that duplicating
  infrastructure five times over was the wrong call, and reversing it before
  paying that cost four more times, is itself the kind of judgment call this
  project's ADRs exist to record.
- `packages/pay-core/README.md`'s references to `apo-pay-core`,
  `apo-durable-ledger`, etc. as separate repos are stale as of this decision
  and are corrected in the same change that adds this ADR.
- Nothing about `pay-core`'s own code, ports, or adapters changes — this is
  purely a repository/workspace-boundary decision.
