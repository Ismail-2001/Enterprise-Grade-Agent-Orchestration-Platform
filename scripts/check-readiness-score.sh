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
#
# Extended (2026-08-12) to also catch factual contradictions:
# - "penetration testing (not performed)" when pentest WAS done
# - "19 cases" when golden-dataset.json has 37
# - "secret scanning (not configured)" when Gitleaks IS configured
# - Unqualified "multi-tenant production" claims

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

contradictions=0

echo ""
echo "Checking factual contradictions..."

# Check 1: SECURITY.md must not claim "penetration testing (not performed)"
if grep -q 'penetration testing (not performed)' SECURITY.md 2>/dev/null; then
  echo "✗ FAIL: SECURITY.md claims 'penetration testing (not performed)' but pentest was completed with 6 remediations."
  contradictions=$((contradictions + 1))
fi

# Check 2: SECURITY.md must not claim "secret scanning (not configured)"
if grep -q 'secret scanning.*not configured' SECURITY.md 2>/dev/null; then
  echo "✗ FAIL: SECURITY.md claims 'secret scanning (not configured)' but Gitleaks IS configured."
  contradictions=$((contradictions + 1))
fi

# Check 3: Eval count must match golden-dataset.json
if [ -f evals/golden-dataset.json ]; then
  actual_count=$(node -e "const d=require('./evals/golden-dataset.json'); console.log(d.cases?.length||d.length||0)" 2>/dev/null || echo "0")
  if [ "$actual_count" != "0" ]; then
    # Check README
    readme_evals=$(grep -oE '[0-9]+ eval cases' README.md 2>/dev/null | grep -oE '[0-9]+' | head -1)
    if [ -n "$readme_evals" ] && [ "$readme_evals" != "$actual_count" ]; then
      echo "✗ FAIL: README claims '$readme_evals eval cases' but golden-dataset.json has $actual_count."
      contradictions=$((contradictions + 1))
    fi
  fi
fi

# Check 4: "multi-tenant production" must be qualified everywhere
if grep -qi 'multi-tenant production' README.md 2>/dev/null; then
  if ! grep -qi 'multi-tenant production.*not load-tested\|multi-tenant production.*out of scope\|multi-tenant production.*pilot only' README.md 2>/dev/null; then
    echo "✗ FAIL: README contains 'multi-tenant production' without qualification."
    contradictions=$((contradictions + 1))
  fi
fi

# Check 5: production-readiness-final.md must be marked deprecated
if ! head -5 docs/production-readiness-final.md 2>/dev/null | grep -qi 'DEPRECATED\|Superseded'; then
  echo "✗ FAIL: docs/production-readiness-final.md is not marked as deprecated."
  contradictions=$((contradictions + 1))
fi

if [ "$contradictions" -gt 0 ]; then
  echo ""
  echo "✗ FAIL: $contradictions factual contradiction(s) found."
  exit 1
fi

echo "✓ PASS: No factual contradictions found."
echo ""
echo "All checks passed."
exit 0
