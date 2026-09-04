---
name: review
description: Review-only pass on the current uncommitted diff with reviewer and security-reviewer. Use for changes made by hand or outside the /feature pipeline.
---

Delegate to `reviewer` and `security-reviewer` in parallel on the current working-tree diff. Context for both: $ARGUMENTS (may be empty — then say "no plan provided, review against codebase conventions").

Merge their reports. If both APPROVE, run `./scripts/approve.sh` and tell the user the diff is cleared for commit. Otherwise list Critical/high items grouped by file and stop — do not fix anything yourself unless the user asks.
