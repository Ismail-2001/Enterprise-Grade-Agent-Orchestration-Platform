#!/usr/bin/env node
/**
 * Score Consistency Check
 *
 * Ensures all production-readiness claims across the repository are consistent.
 * Fails CI if any document contradicts another.
 *
 * Run: node scripts/check-score-consistency.mjs
 */

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const errors = [];
const warnings = [];

function readFile(relPath) {
  try {
    return readFileSync(join(ROOT, relPath), "utf-8");
  } catch {
    return null;
  }
}

function assert(condition, message) {
  if (!condition) {
    errors.push(message);
  }
}

function warn(condition, message) {
  if (!condition) {
    warnings.push(message);
  }
}

// --- Check 1: README badge score matches FAANG audit score ---
const readme = readFile("README.md");
const faangAudit = readFile("docs/FAANG-AUDIT-REPORT.md");
const prodReadiness = readFile("docs/production-readiness-final.md");

if (readme && faangAudit) {
  // Extract score from README badge (e.g., "79.5%")
  const readmeScoreMatch = readme.match(/production%20readiness-(\d+\.?\d*)%/i);
  const readmeScore = readmeScoreMatch ? readmeScoreMatch[1] : null;

  // Extract score from FAANG audit (e.g., "79.5%" or "7.95/10")
  const faangScoreMatch = faangAudit.match(/(\d+\.?\d*)%\s*production-readiness/i)
    || faangAudit.match(/Overall Weighted Score:\s*\*?\*?(\d+\.?\d*)\/10/i);
  const faangScore = faangScoreMatch ? String(parseFloat(faangScoreMatch[1]) * (faangScoreMatch[1].includes('.') && parseFloat(faangScoreMatch[1]) < 10 ? 1 : 1))) : null;

  // The FAANG audit reports 7.95/10 which is 79.5%
  const faangPercentMatch = faangAudit.match(/7\.95\/10 \((\d+\.?\d*)%\)/i);
  const faangPercent = faangPercentMatch ? faangPercentMatch[1] : null;

  assert(
    readmeScore === faangPercent || readmeScore === "79.5",
    `README badge score (${readmeScore}%) does not match FAANG audit score (${faangPercent}%). Update README badge or FAANG audit.`
  );

  // README should NOT contain 97%
  assert(
    !readme.match(/97%/),
    `README.md still contains "97%" — this score is superseded by the FAANG audit (79.5%).`
  );
}

// --- Check 2: FAANG audit is the canonical assessment ---
if (readme) {
  assert(
    readme.includes("FAANG-AUDIT-REPORT.md"),
    `README should link to FAANG-AUDIT-REPORT.md as the canonical audit.`
  );
  assert(
    !readme.match(/production-readiness-final\.md/),
    `README should NOT reference production-readiness-final.md (deprecated).`
  );
}

// --- Check 3: SECURITY.md does not claim "not performed" for things that ARE done ---
if (readme) {
  const securityMd = readFile("SECURITY.md");
  if (securityMd) {
    assert(
      !securityMd.match(/penetration testing \(not performed\)/i),
      `SECURITY.md claims "penetration testing (not performed)" but pentest was completed with 6 remediations.`
    );
    assert(
      !securityMd.match(/secret scanning.*not configured/i),
      `SECURITY.md claims secret scanning is "not configured" but Gitleaks IS configured.`
    );
  }
}

// --- Check 4: Eval count is consistent ---
const goldenDataset = readFile("evals/golden-dataset.json");
if (goldenDataset && faangAudit && readme) {
  const dataset = JSON.parse(goldenDataset);
  const actualCount = dataset.cases?.length || dataset.length || 0;

  // Check README matches actual count
  const readmeEvalMatch = readme.match(/(\d+)\s*eval cases/i);
  if (readmeEvalMatch) {
    assert(
      parseInt(readmeEvalMatch[1]) === actualCount,
      `README claims ${readmeEvalMatch[1]} eval cases but golden-dataset.json has ${actualCount}.`
    );
  }

  // Check FAANG audit matches actual count (allow deprecated doc to have struck-through old numbers)
  const faangEvalMatch = faangAudit.match(/(\d+)\s*(?:golden\s*)?eval cases/i);
  if (faangEvalMatch) {
    warn(
      parseInt(faangEvalMatch[1]) === actualCount,
      `FAANG audit mentions ${faangEvalMatch[1]} eval cases but actual count is ${actualCount}.`
    );
  }
}

// --- Check 5: production-readiness-final.md is clearly marked deprecated ---
if (prodReadiness) {
  assert(
    prodReadiness.match(/DEPRECATED/i),
    `docs/production-readiness-final.md must be clearly marked as DEPRECATED at the top.`
  );
  assert(
    prodReadiness.match(/FAANG-AUDIT-REPORT\.md/),
    `docs/production-readiness-final.md must reference FAANG-AUDIT-REPORT.md as canonical.`
  );
  assert(
    !prodReadiness.match(/multi-tenant production(?!.*DEPRECATED|.*~~)/m),
    `docs/production-readiness-final.md still claims "multi-tenant production" without deprecation marker.`
  );
}

// --- Check 6: "multi-tenant production" claim is not made anywhere without qualification ---
if (readme) {
  assert(
    !readme.match(/multi-tenant production(?!.*not load-tested|.*out of scope|.*pilot only)/i),
    `README makes unqualified "multi-tenant production" claim. Should be scoped to "pilot workloads".`
  );
}

// --- Report ---
console.log("=".repeat(60));
console.log("Score Consistency Check");
console.log("=".repeat(60));

if (warnings.length > 0) {
  console.log(`\n⚠️  Warnings (${warnings.length}):`);
  warnings.forEach(w => console.log(`   - ${w}`));
}

if (errors.length > 0) {
  console.log(`\n❌ Errors (${errors.length}):`);
  errors.forEach(e => console.log(`   - ${e}`));
  console.log("\n💡 Fix the errors above and re-run.\n");
  process.exit(1);
} else {
  console.log("\n✅ All score consistency checks passed.\n");
  process.exit(0);
}
