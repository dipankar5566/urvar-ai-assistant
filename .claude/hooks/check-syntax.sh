#!/bin/bash
# Fail open — if jq is missing, don't block edits
command -v jq >/dev/null 2>&1 || exit 0

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)

# Only check .js files
if [[ -z "$file_path" || "$file_path" != *.js ]]; then
  exit 0
fi

# File must exist (Write creates it, Edit modifies it — both should exist by PostToolUse)
if [[ ! -f "$file_path" ]]; then
  exit 0
fi

echo "Checking syntax: $file_path"
node --check "$file_path"
