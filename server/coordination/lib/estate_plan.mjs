// Estate next-cycle planner (EP-N / N6) — projects the APPROVED/pending drift into the next
// flywheel turn so the owner knows what's coming before it runs: clean sessions -> cards
// (minus the thin rate) -> Stream-A rows -> does the dataset drift cross its rebuild threshold
// -> recommended action (map | rebuild | train). Pure over injected fixtures (drift + dataset
// manifest + eval numbers); the SAME projection renders on the cockpit AND feeds the :8788
// flywheel banner, so both surfaces agree. Spec: architecture/SOLUTION-estate.md §8.3.
// Read-only: never mutates the manifest/eval/dataset and calls no LM host.
import fs from "node:fs";

// planNextCycle(delta, manifest, evalReport, opts)
//   delta       — N4 driftDelta { cleanCount | clean:[sid], quarantined:{count} } (pending sync)
//   manifest    — scripts/train/dataset/manifest.json shape { source.a_v3.jsoncards, streams.A, ... }
//   evalReport  — { a_pct, b_pct, agg_pct } (the A/B gap that says which stream is starved)
//   opts        — { thinRate=0, rebuildThreshold=20, cardsNow=null }
export function planNextCycle(delta = {}, manifest = {}, evalReport = {}, opts = {}) {
  const thinRate = clamp01(opts.thinRate ?? 0);
  const rebuildThreshold = opts.rebuildThreshold ?? 20;
  const cardsNow = opts.cardsNow ?? null;

  const cleanCount = delta.cleanCount ?? (Array.isArray(delta.clean) ? delta.clean.length : 0);
  const projectedCards = Math.round(cleanCount * (1 - thinRate));

  const cardsAtBuild = manifest?.source?.a_v3?.jsoncards ?? null;
  const aRows = (manifest?.streams?.A?.train ?? 0) + (manifest?.streams?.A?.eval ?? 0);
  const rowsPerCard = cardsAtBuild ? aRows / cardsAtBuild : 0;
  const projectedStreamARows = Math.round(projectedCards * rowsPerCard);

  const newCardsSinceBuild =
    cardsNow != null && cardsAtBuild != null ? Math.max(0, cardsNow - cardsAtBuild) : 0;
  const pendingTotal = newCardsSinceBuild + projectedCards;
  const crossesRebuildThreshold = pendingTotal >= rebuildThreshold;

  // The eval says which stream is starved. a_pct/b_pct are % NLL change (negative = improvement);
  // a_pct > b_pct means Stream A improved LESS — it is the bottleneck.
  const aGap =
    evalReport.a_pct != null && evalReport.b_pct != null && evalReport.a_pct > evalReport.b_pct;

  let recommendedAction, reason;
  if (crossesRebuildThreshold) {
    recommendedAction = "rebuild";
    reason = aGap
      ? `Stream A is the bottleneck (A_nll ${evalReport.a_pct}% vs B_nll ${evalReport.b_pct}%); ${pendingTotal} new cards cross the rebuild threshold`
      : `${pendingTotal} new cards cross the rebuild threshold`;
  } else if (cleanCount > 0) {
    recommendedAction = "map";
    reason = `${cleanCount} clean session(s) to sync + map — accrues Stream-A rows toward the next rebuild`;
  } else {
    recommendedAction = "train";
    reason = "no pending drift; the dataset is current with the corpus";
  }

  return {
    newSessions: cleanCount,
    projectedCards,
    projectedStreamARows,
    cardsAtBuild,
    cardsNow,
    newCardsSinceBuild,
    rebuildThreshold,
    crossesRebuildThreshold,
    recommendedAction,
    reason,
    dataGap: aGap ? { stream: "A", a_pct: evalReport.a_pct, b_pct: evalReport.b_pct } : null
  };
}

function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

// readPlanInputs({ manifestFile, evalFile }) — read the dataset manifest (JSON) and parse the v3
// eval numbers from the report markdown. Returns { manifest, evalReport }, each null-safe when the
// file is absent. Read-only. The eval parse mirrors the LONGVIEW flywheel collector so the two agree.
export function readPlanInputs({ manifestFile = null, evalFile = null } = {}) {
  let manifest = {};
  let evalReport = {};
  try {
    if (manifestFile && fs.existsSync(manifestFile)) manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  } catch { /* absent/corrupt manifest → empty (planner degrades, never throws) */ }
  try {
    if (evalFile && fs.existsSync(evalFile)) {
      const md = fs.readFileSync(evalFile, "utf8").replace(/−/g, "-");
      const agg = md.match(/base agg_nll\s*([\d.]+)\s*(?:->|→)\s*tuned\s*([\d.]+)\s*\((-?[\d.]+)%\)/i);
      const a = md.match(/A_nll\s*(-?[\d.]+)%/i);
      const b = md.match(/B_nll\s*(-?[\d.]+)%/i);
      if (agg) evalReport = { base_nll: +agg[1], tuned_nll: +agg[2], agg_pct: +agg[3], a_pct: a ? +a[1] : null, b_pct: b ? +b[1] : null };
    }
  } catch { /* absent/corrupt report → empty */ }
  return { manifest, evalReport };
}
