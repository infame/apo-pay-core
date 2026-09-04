#!/usr/bin/env bash
# Marks <branch>'s current tip as merge-approved. .githooks/reference-
# transaction (wired via `core.hooksPath`) checks this marker, and the
# actual diff it records against master, before letting anything land on
# master — regardless of whether that lands via `git merge --squash` +
# `git commit`, or anything else.
# Called by the coordinator after both reviewers return VERDICT: APPROVE on
# `git diff master...<branch>`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
TRUNK='master' # keep in sync with .githooks/reference-transaction
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"
if [ "$BRANCH" = "$TRUNK" ]; then
  echo "Refusing to approve '$TRUNK' as a merge source — pass the feature branch name." >&2
  exit 1
fi
SHA=$(git rev-parse "$BRANCH")
mkdir -p .claude
echo "$BRANCH $SHA" > .claude/.merge-approved
echo "approved: $BRANCH ($SHA)"
