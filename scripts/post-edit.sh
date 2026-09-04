#!/usr/bin/env bash
# PostToolUse hook on Edit|Write. Fast feedback on the touched file only.
# Non-blocking (exit 0); output is shown to Claude.
set -uo pipefail
INPUT=$(cat)
FILE=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')
[ -z "$FILE" ] && exit 0
case "$FILE" in
  *.ts|*.tsx|*.js|*.mjs)
    command -v npx >/dev/null || exit 0
    npx --no-install prettier --write "$FILE" >/dev/null 2>&1 || true
    npx --no-install eslint --max-warnings=0 "$FILE" 2>&1 | tail -n 30 || true
    ;;
esac
exit 0
