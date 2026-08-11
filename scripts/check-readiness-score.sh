#!/usr/bin/env bash
# check-readiness-score.sh
#
# Ensures production-readiness score consistency across the repository.
# Fails if more than one distinct score value is found without an explicit
# deprecation marker on the older file(s).
#
# This script exists because the same documentation-consistency issue was
# flagged in two separate review rounds and left unresolved both times.
# It is designed to catch that specific failure mode before merge.

set -euo pipefail

# Patterns that look like readiness scores
SCORE_PATTERNS='[0-9]+(\.[0-9]+)?%|[0-9]+\.[0-9]+/10|production.readiness|production-readiness'

# Files to scan (README + all docs markdown)
SCAN_FILES="README.md RELEASE_NOTES*.md docs/*.md"

# Normalize a score to percentage form (e.g., "7.95/10" → "79.5%")
normalize_score() {
  local raw="$1"
  if [[ "$raw" =~ ^([0-9]+\.[0-9]+)/10$ ]]; then
    local val="${BASH_REMATCH[1]}"
    # Multiply by 10 and format (7.95 → 79.5)
    echo "$(awk "BEGIN {printf \"%.1f%%\", $val * 10}")"
  else
    echo "$raw"
  fi
}

# Extract all score-like values, excluding known-deprecated files
declare -A final_scores

for f in $SCAN_FILES; do
  [ -f "$f" ] || continue

  # Skip files that are explicitly deprecated
  if head -5 "$f" | grep -qi 'DEPRECATED\|Superseded'; then
    continue
  fi

  # Only consider files that mention readiness/production-readiness/score
  if ! grep -qi 'readiness\|production.ready\|score' "$f"; then
    continue
  fi

  # Find percentage scores like 97%, 79.5%
  while IFS= read -r raw_score; do
    [ -z "$raw_score" ] && continue
    score="$(normalize_score "$raw_score")"
    if [ -n "${final_scores[$score]:-}" ]; then
      # Avoid duplicate file entries
      if [[ ! "${final_scores[$score]}" =~ "$f" ]]; then
        final_scores[$score]="${final_scores[$score]}|$f"
      fi
    else
      final_scores[$score]="$f"
    fi
  done < <(grep -oE '[0-9]+(\.[0-9]+)?%' "$f" 2>/dev/null)

  # Find X.XX/10 scores
  while IFS= read -r raw_score; do
    [ -z "$raw_score" ] && continue
    score="$(normalize_score "$raw_score")"
    if [ -n "${final_scores[$score]:-}" ]; then
      if [[ ! "${final_scores[$score]}" =~ "$f" ]]; then
        final_scores[$score]="${final_scores[$score]}|$f"
      fi
    else
      final_scores[$score]="$f"
    fi
  done < <(grep -oE '[0-9]+\.[0-9]+/10' "$f" 2>/dev/null)
done

# Count distinct scores
distinct_count=0
for score in "${!final_scores[@]}"; do
  distinct_count=$((distinct_count + 1))
done

if [ "$distinct_count" -le 1 ]; then
  echo "✓ PASS: Readiness score consistent across repository."
  for score in "${!final_scores[@]}"; do
    echo "  ${score} — ${final_scores[$score]//|/, }"
  done
  exit 0
fi

echo "✗ FAIL: Multiple distinct readiness scores found in non-deprecated files."
echo "  The canonical score document is docs/FAANG-AUDIT-REPORT.md."
echo "  All other files must match it or be marked as deprecated."
echo ""
for score in "${!final_scores[@]}"; do
  echo "  ${score} — ${final_scores[$score]//|/, }"
done
echo ""
echo "Fix: Update the stale file(s) to match the canonical score, or add a"
echo "     'DEPRECATED — Superseded by ...' header to the outdated document."
exit 1
