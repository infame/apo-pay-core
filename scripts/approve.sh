#!/usr/bin/env bash
# Marks the CURRENT diff as review-approved. guard-commit.sh checks this marker.
# Called by the coordinator after both reviewers return VERDICT: APPROVE.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
mkdir -p .claude
{ git diff HEAD; git diff --cached; git ls-files --others --exclude-standard | sort; } \
  | sha256sum | cut -d' ' -f1 > .claude/.review-approved
echo "approved: $(cat .claude/.review-approved)"
