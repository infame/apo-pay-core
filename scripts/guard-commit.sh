#!/usr/bin/env bash
# PreToolUse hook on Bash. This is an ergonomic pre-check only — it does NOT
# gate landing on main (that's .githooks/reference-transaction, a real git
# hook wired via `core.hooksPath`, since it's the only thing that sees the
# actual ref update regardless of how git was invoked: directly, through a
# wrapper script, an alias, or with --no-verify, which skips pre-commit but
# not reference-transaction).
#
# All this script does is stop a command from discarding uncommitted work or
# skipping every git hook outright, on any branch. Exit 2 = block, message
# goes to Claude.
set -uo pipefail
INPUT=$(cat)
CMD=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# -i for case-insensitivity: git config keys (core.hooksPath and friends)
# are case-insensitive, so a bare literal match here is trivially evaded by
# re-casing it.
if echo "$CMD" | grep -qE '\bgit\b' \
   && echo "$CMD" | grep -qiE -- '--no-verify|--force|-f\s+origin|reset\s+--hard|core\.hookspath|--git-dir|--work-tree|--exec-path|GIT_DIR=|GIT_CONFIG_KEY|GIT_CONFIG_COUNT|branch\s+-[mM]\b'; then
  echo "Blocked: destructive, hook-skipping, or hook-disabling git flag." >&2
  exit 2
fi
exit 0
