// Run inventory — the denominator the authorisation defect needs.
// Spec: exec_register.mjs (L5) · governance.mjs (Principle 2).
//
// "Unauthorised runs: 0" is meaningless without a list of runs to check. This assembles that
// list from the execution evidence that already exists on disk — Benny RunRecords and the
// LONGVIEW OpenLineage events — so the count is over real executions rather than a promise.
//
// The subtlety that makes the number honest is the CONTROL EFFECTIVE DATE. Every run in this
// estate predates the governance layer, because signing did not exist until it was built. A
// naive check reports 100% unauthorised, which is true, useless, and exactly the wall of red
// that teaches an operator to ignore a gauge. Controls have effective dates for this reason:
// a run from July cannot have been signed by a mechanism that did not exist in July.
//
// So runs are split rather than lumped: PRE-CONTROL runs are counted and reported but are not
// defects, and IN-SCOPE runs — those at or after the epoch — must carry a human signature or
// they are. Hiding the pre-control population would be as dishonest as failing them; both
// halves are surfaced.
import fs from "node:fs";
import path from "node:path";

// Benny swarm executions: one JSON per run, already write-once on disk.
export function fromRunRecords(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (!r.run_id) continue;
      out.push({
        run_id: r.run_id,
        at: r.started_at || r.completed_at || null,
        kind: "swarm",
        source: "runtime/manifests/runs",
        workspace: r.workspace ?? null,
        status: r.status ?? null,
        // Runs predating governance have no proposal; the field exists so that runs created
        // after it can carry one and be checked.
        proposal_id: r.proposal_id ?? null
      });
    } catch {
      /* a malformed record is not a run we can vouch for; skip rather than invent one */
    }
  }
  return out;
}

// LONGVIEW pipeline executions, one run id per (execution, phase) in the OpenLineage feed.
export function fromOpenLineage(file) {
  if (!fs.existsSync(file)) return [];
  let events;
  try {
    events = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const seen = new Map();
  for (const e of events) {
    const id = e?.run?.runId;
    if (!id || seen.has(id)) continue;
    seen.set(id, {
      run_id: id,
      at: e.eventTime || null,
      kind: "pipeline",
      source: "longview/openlineage",
      workspace: e?.run?.facets?.longview_execution?.workspace ?? null,
      status: null,
      proposal_id: null
    });
  }
  return [...seen.values()];
}

export function collectRuns({ runRecordsDir = null, openLineagePath = null } = {}) {
  return [
    ...(runRecordsDir ? fromRunRecords(runRecordsDir) : []),
    ...(openLineagePath ? fromOpenLineage(openLineagePath) : [])
  ].sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")));
}

// When did the control come into force? The honest answer is: when the first proposal was
// recorded, because that is when signing became possible at all. Supplying an explicit epoch
// overrides it — useful if a policy start date differs from the code's.
export function governanceEpochFrom(events = [], explicit = null) {
  if (explicit) return explicit;
  const first = events
    .filter((e) => String(e?.type || "").startsWith("proposal_"))
    .map((e) => e.valid_time)
    .filter(Boolean)
    .sort()[0];
  return first ?? null;
}

// Split the inventory against the epoch. A run with no timestamp is treated as in scope: an
// undateable execution is a governance problem in its own right, and defaulting it to
// "pre-control" would let anything escape simply by losing its date.
export function partitionRuns(runs = [], epoch = null) {
  if (!epoch) return { inScope: [], preControl: [...runs], undated: [] };
  const inScope = [];
  const preControl = [];
  const undated = [];
  for (const r of runs) {
    if (!r.at) {
      undated.push(r);
      inScope.push(r);
    } else if (String(r.at) >= String(epoch)) inScope.push(r);
    else preControl.push(r);
  }
  return { inScope, preControl, undated };
}
