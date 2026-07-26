const finite = (value) => value != null && Number.isFinite(Number(value));

export function pruneEvidenceRequirements(assetClass) {
  if (assetClass === "option") return { minimumDays: 30, minimumRuns: 1 };
  if (assetClass === "crypto") return { minimumDays: 30, minimumRuns: 1 };
  return { minimumDays: 20, minimumRuns: 1 };
}

export function assessPruneEvidence({
  assetClass, result, benchmarkReturn, coverageDays = 0, evaluatedRuns = 0,
  positiveRuns = 0, validationAverage = null, validationRuns = 0,
  maxDrawdown = 0, paperFillCount = 0, paperPnl = 0, paperReturn = null,
}) {
  const requirements = pruneEvidenceRequirements(assetClass);
  const reasons = [], evidenceNotes = [];
  const hasResult = finite(result), hasBenchmark = finite(benchmarkReturn);
  const excessReturn = hasResult && hasBenchmark ? Number(result) - Number(benchmarkReturn) : null;

  const materialPaperLoss = paperFillCount >= 10
    && ((finite(paperReturn) && Number(paperReturn) <= -1) || (!finite(paperReturn) && Number(paperPnl) < 0));
  if (materialPaperLoss) reasons.push("Material negative paper performance after 10+ attributed fills");

  const matureHistory = hasResult
    && coverageDays >= requirements.minimumDays
    && evaluatedRuns >= requirements.minimumRuns;
  if (!hasResult) evidenceNotes.push("No usable historical return yet");
  if (coverageDays < requirements.minimumDays) evidenceNotes.push(`Needs ${requirements.minimumDays - coverageDays} more unique replay day${requirements.minimumDays - coverageDays === 1 ? "" : "s"}`);
  if (evaluatedRuns < requirements.minimumRuns) evidenceNotes.push(`Needs ${requirements.minimumRuns - evaluatedRuns} more independent replay run${requirements.minimumRuns - evaluatedRuns === 1 ? "" : "s"}`);

  if (matureHistory) {
    if (Number(result) < 0 && (!hasBenchmark || Number(excessReturn) < 0)) {
      reasons.push(hasBenchmark ? "Lost money and underperformed buy-and-hold" : "Negative return across sufficient replay evidence");
    }
    if (validationRuns >= 2 && finite(validationAverage) && Number(validationAverage) <= -0.5) reasons.push("Repeated unseen validation is materially negative");
    if (evaluatedRuns >= 3 && Number(positiveRuns) / evaluatedRuns < 0.4) reasons.push("Profitable in fewer than 40% of replay runs");
    if (Number(maxDrawdown) > Math.max(10, Math.abs(Number(result)) * 2)) reasons.push("Drawdown is disproportionate to return");
  }

  const eligible = reasons.length > 0;
  return {
    eligible,
    state: eligible ? "underperforming" : matureHistory ? "retained" : "unproven",
    label: eligible ? "Underperforming" : matureHistory ? "Retained" : "Insufficient evidence",
    reasons, evidenceNotes, matureHistory, excessReturn, requirements,
  };
}
