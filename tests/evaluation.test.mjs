import test from "node:test";
import assert from "node:assert/strict";
import { assessPruneEvidence, pruneEvidenceRequirements } from "../evaluation.js";

test("six-day crypto replay is unproven rather than pruned", () => {
  const result = assessPruneEvidence({
    assetClass: "crypto", result: -1.2, benchmarkReturn: -2.5,
    coverageDays: 6, evaluatedRuns: 1, positiveRuns: 0,
    validationAverage: -0.8, validationRuns: 1, maxDrawdown: 4,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.state, "unproven");
  assert.match(result.evidenceNotes.join(" "), /24 more unique replay days/);
});

test("small positive return is not rejected for missing an arbitrary two percent target", () => {
  const result = assessPruneEvidence({
    assetClass: "equity", result: 0.4, benchmarkReturn: 1.1,
    coverageDays: 30, evaluatedRuns: 3, positiveRuns: 2,
    validationAverage: 0.1, validationRuns: 2, maxDrawdown: 2,
  });
  assert.equal(result.eligible, false);
  assert.equal(result.state, "retained");
});

test("mature repeated losses qualify for pruning", () => {
  const result = assessPruneEvidence({
    assetClass: "crypto", result: -4, benchmarkReturn: 2,
    coverageDays: 45, evaluatedRuns: 4, positiveRuns: 1,
    validationAverage: -1, validationRuns: 3, maxDrawdown: 12,
  });
  assert.equal(result.eligible, true);
  assert.match(result.reasons.join(" "), /underperformed buy-and-hold/);
});

test("material observed paper loss can prune without mature replay history", () => {
  const result = assessPruneEvidence({
    assetClass: "option", result: null, coverageDays: 5, evaluatedRuns: 0,
    paperFillCount: 12, paperPnl: -20, paperReturn: -4,
  });
  assert.equal(result.eligible, true);
  assert.match(result.reasons[0], /paper performance/);
});

test("options and crypto require more evidence than stocks", () => {
  assert.equal(pruneEvidenceRequirements("equity").minimumDays, 20);
  assert.equal(pruneEvidenceRequirements("option").minimumDays, 30);
  assert.equal(pruneEvidenceRequirements("crypto").minimumRuns, 3);
});
