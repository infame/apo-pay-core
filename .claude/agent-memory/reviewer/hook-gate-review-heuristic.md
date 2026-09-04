---
name: hook-gate-review-heuristic
description: The trunk gate is .githooks/reference-transaction, a real git hook — not scripts/guard-commit.sh's text pattern-matching. Reusable hand-test list and the gaps found across 5 review rounds.
metadata:
  type: project
---

Branch `chore/branch-review-workflow` (2026-09-04) rewrote the "only approved squash-merges land on master" gate. Rounds 1-2 tried to enforce it by pattern-matching the Bash command string in a PreToolUse hook (`scripts/guard-commit.sh`); both shipped hand-tested and both had real bypasses found only by *running* crafted commands (compound `checkout && merge && commit` read a stale branch; `git -C .`, `-c`, wrapper scripts, `branch -f`, `update-ref` all slipped the text matcher). **A command-text hook cannot be the enforcement boundary; it can only ever be ergonomic.**

**Current design:** the gate is `.githooks/reference-transaction`, wired via the hooks-path config (one-time per clone, see README). Git invokes it on *every* update to `refs/heads/master` regardless of how git was invoked. `scripts/guard-commit.sh` is deliberately thin: destructive flags plus the one thing no git hook can defend against — options/env vars that turn git hooks off.

**How to apply when reviewing changes to either:**
- A diff that makes `scripts/guard-commit.sh` responsible for gating master is a regression to the broken model — flag it.
- A diff touching `.githooks/reference-transaction` must be hand-tested with real git in a throwaway clone, not by reading. Install the hook at `.git/hooks/reference-transaction` in the test repo — the repo's own guard blocks any command mentioning the hooks-path config key, including the README's legitimate setup step.
- States: `preparing`/`prepared`/`committed`/`aborted`; only a nonzero exit during `prepared` aborts. Consume the one-shot marker on `committed`, never on `prepared`.
- Don't trust stdin `$OLD` for the trunk's current tip (`branch -f` reports all-zeros); ask git directly with `rev-parse --verify --quiet`.

**Reusable hand-test list** (all re-verified green on round 5, commit de90a81):
plain commit on master with no marker (block) · squash without approval (block) · approved squash (lands, marker consumed) · *second* branch landing after trunk advanced (lands — this is what tree-equality got wrong; diff-hash against the current tip on both sides is the fix) · approved merge + extra file on top (block) · `branch -f` / `update-ref` onto master with no marker (block) · `update-ref` **with** approval (lands and consumes — confirms `committed` fires on non-commit paths) · plain `reset` and `checkout master` after approval (marker survives) · `merge --no-ff` whose content matches the approval (block: parent count) · fast-forward multi-commit jump (block) · deleting master (block, all-zero NEW fails closed).

**Gaps found and fixed across rounds** (each was invisible on read, visible on run): the hooks-path and git-dir overrides disabling hooks → text layer; `sha256sum` missing on macOS made both hashes empty = fail OPEN → hash with `git hash-object --stdin` + explicit empty check; bare `rev-parse` returning the literal ref name; case-sensitive config-key match; `committed` burning the approval on harmless no-ops → two-phase `prepared` writes `.claude/.merge-approved.landing`, `committed` consumes only on a match; "one commit" checked only the first parent → explicit `rev-list --parents -n1 | wc -w` = 2 (root=1, invalid/zero-oid=0, all fail closed; word-splitting is safe, output is only hex oids).

**Known residual limits — don't re-litigate these, they're accepted:**
- Marker file and both scripts are plain files a Bash-capable agent can overwrite; raw writes into the ref files bypass the ref-store API entirely. Guardrail, not a boundary.
- Fast-forwarding master from a remote is blocked (no remote configured here, so latent).
- If the hook process dies between `prepared` and `committed`/`aborted`, the pending file dangles; the next no-op transaction on master silently eats a fresh, unrelated approval. Fail-closed (re-approve), just silent.
- The text layer over-blocks `-m`/`-M` renames everywhere while missing the `--move` long form; it's ergonomic-only, so this is a warning, never a blocker.

See [[repo-lint-not-wired]] for the other place this repo's tooling and docs drift apart.
