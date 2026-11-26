#!/usr/bin/env bash
# Fails if any forbidden word (one per line in .kiro/private/forbidden-words.txt, git-ignored)
# appears in tracked/untracked files, branch names or commit messages.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
WORDS_FILE="$ROOT/.kiro/private/forbidden-words.txt"

if [[ ! -f "$WORDS_FILE" ]]; then
  echo "forbidden-words: $WORDS_FILE not found (create it, one word per line)" >&2
  exit 2
fi

PATTERNS="$(mktemp)"
trap 'rm -f "$PATTERNS"' EXIT
grep -v '^[[:space:]]*$' "$WORDS_FILE" | sed 's/[[:space:]]*$//' > "$PATTERNS" || true
[[ -s "$PATTERNS" ]] || { echo "forbidden-words: list is empty" >&2; exit 2; }

found=0
cd "$ROOT"

if git rev-parse --git-dir >/dev/null 2>&1; then
  # Files: tracked + untracked (respects .gitignore, so .kiro/private and .env are skipped)
  if git grep --untracked -n -i -I -F -f "$PATTERNS" -- . ':!.kiro/private' ':!package-lock.json'; then
    found=1
  fi
  # Branch names
  if git branch -a --format='%(refname:short)' | grep -i -F -f "$PATTERNS"; then
    echo "forbidden-words: found in branch names" >&2
    found=1
  fi
  # Commit messages and author info
  if git log --all --format='%H %an %ae %s %b' 2>/dev/null | grep -i -F -f "$PATTERNS"; then
    echo "forbidden-words: found in commit history" >&2
    found=1
  fi
else
  if grep -rniI -F -f "$PATTERNS" . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=private --exclude-dir=dist --exclude-dir=coverage; then
    found=1
  fi
fi

if [[ $found -eq 1 ]]; then
  echo "forbidden-words: FAILED — remove the matches above before committing" >&2
  exit 1
fi
echo "forbidden-words: ok"
