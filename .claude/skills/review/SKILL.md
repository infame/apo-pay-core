---
name: review
description: Review-only pass on the current branch's diff against master, with reviewer and security-reviewer. Use before squash-merging a branch made by hand or outside the /feature pipeline.
---

Determine the current branch (`git rev-parse --abbrev-ref HEAD`). If it is `master`, stop and tell the user review runs against a feature branch, not master itself.

Delegate to `reviewer` and `security-reviewer` in parallel on `git diff master...<branch>` (the branch's changes since it diverged from master — not the working tree, not master's own history). Context for both: $ARGUMENTS (may be empty — then say "no plan provided, review against codebase conventions").

Merge their reports. If both APPROVE, run `./scripts/approve.sh <branch>` and tell the user the branch is cleared to squash-merge into master:
```
git checkout master && git merge --squash <branch> && git commit
```
(`.githooks/reference-transaction` is what actually gates this — it fires on the real ref update regardless of chaining, so this one-liner is safe.) Otherwise list Critical/high items grouped by file and stop — do not fix anything yourself unless the user asks.
