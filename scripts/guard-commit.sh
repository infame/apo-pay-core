#!/usr/bin/env bash
# PreToolUse hook on Bash. Blocks `git commit` / `git push` unless the current diff
# matches the hash written by approve.sh. Exit 2 = block, message goes to Claude.
set -uo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

if echo "$CMD" | grep -qE '\bgit\s+(commit|push)\b'; then
  cd "$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  MARK=.claude/.review-approved
  if [ ! -f "$MARK" ]; then
    echo "Blocked: no review approval. Run /review or complete the /feature pipeline first." >&2
    exit 2
  fi
  CUR=$({ git diff HEAD; git diff --cached; git ls-files --others --exclude-standard | sort; } \
        | sha256sum | cut -d' ' -f1)
  if [ "$CUR" != "$(cat "$MARK")" ]; then
    echo "Blocked: diff changed since review approval. Re-run review." >&2
    exit 2
  fi
  # one-shot: consume the marker so the next commit needs a fresh review
  rm -f "$MARK"
fi

# Never allow skipping checks
if echo "$CMD" | grep -qE -- '--no-verify|--force|-f\s+origin|reset\s+--hard'; then
  echo "Blocked: destructive or check-skipping git flag." >&2
  exit 2
fi
exit 0
