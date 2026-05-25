#!/bin/bash
# Fail open — if jq is missing, don't block commits
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)

# Only intercept git commit commands
if ! echo "$command" | grep -q 'git commit'; then
  exit 0
fi

# Scan staged diff for credential patterns
staged=$(git -C "$(pwd)" diff --cached 2>/dev/null || true)

if [[ -z "$staged" ]]; then
  exit 0
fi

matches=$(echo "$staged" | grep -E '^\+' | grep -E \
  '(tvly-[A-Za-z0-9]{10,}|[0-9]{8,}:AAG[A-Za-z0-9]|sk-ant-[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{20,})' \
  || true)

if [[ -n "$matches" ]]; then
  echo "BLOCKED: Potential credentials detected in staged changes:"
  echo "$matches" | head -10
  echo ""
  echo "Replace real values with placeholders (e.g. 'your_api_key_here') before committing."
  exit 1
fi

exit 0
