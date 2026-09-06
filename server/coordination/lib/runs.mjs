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
//
// One more asymmetry, and it is the opposite of the one the artifact CLI enforces. That
// command REFUSES to cite a proposal nobody signed, because a citation of authority which
// was never granted is a false claim. A RUN RECORD IS NOT A CITATION — it is an observation
// that something executed. So the writer below records `proposal_id` exactly as claimed and
// refuses nothing:
//
//   A SYSTEM THAT WILL NOT RECORD AN UNAUTHORISED RUN CANNOT DETECT ONE.
//
// Validating authority at write time would guarantee that every run in the ledger passes the
// check, and the gauge would report zero for ever while meaning nothing. Verification belongs
// in the read — buildEvidencePack resolves each claimed proposal through isAuthorised() — so
// a run that cites an unsigned or non-existent proposal is faithfully recorded and then
// correctly counted as a defect.
import fs from "node:fs";
import path from "node:path";
import { ulid, CURRENT_SCHEMA_VERSION } from "./kel.mjs";
import { provenance, withProvenance } from "./provenance.mjs";
import { subjectId as govSubjectId } from "./governance.mjs";

// `execution_recorded` was already reserved in the envelope vocabulary for the L5 execution
// register, and nothing had ever written it. A run record IS that, so it reuses the reserved
// name rather than adding a second word for one concept to a controlled vocabulary.
export const RUN_TYPES = Object.freeze({ recorded: "execution_recorded" });

export const subjectId = Object.freeze({ run: (id) => `run:${id}` });

// Record that something executed, under whatever authority it claims. `proposalId` may be
// null — an unauthorised run is a real event and must be recordable, or see the header.
export function runRecordedEvent({
  runId,
  machine,
  task,
  proposalId = null,
  outcome = "ok",
  kind = "estate",
  at = null,
  detail = {}
}) {
  if (!runId) throw new Error("runRecordedEvent: runId is required");
  if (!machine) throw new Error("runRecordedEvent: machine is required");
  if (!task) throw new Error("runRecordedEvent: task is required — an unnamed run is not evidence");
  const now = new Date().toISOString();
  const sid = subjectId.run(runId);
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: RUN_TYPES.recorded,
    valid_time: at || now,
    txn_time: now,
    time_confidence: at ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house", // machinery reporting what it did; judgement was the signature
    sid,
    subject: { kind: "run", id: sid },
    payload: withProvenance(
      { task, kind, outcome, proposal_id: proposalId, ...detail },
      // The causal edge is the claim "this ran because of that decision", which is true (or
      // false) independently of whether the decision was ever signed. Authorisation is
      // checked at read time; causation is recorded here.
      provenance({ causedBy: proposalId ? govSubjectId.proposal(proposalId) : null, subject: sid })
    )
  };
}

// Runs recorded in the ledger itself. Unlike the two file sources these carry an authorising
// proposal by construction, which is what lets the gauge have anything to measure.
export function fromKel(events = []) {
  const out = [];
  for (const e of events) {
    if (e?.type !== RUN_TYPES.recorded) continue;
    const p = e.payload || {};
    out.push({
      run_id: String(e.subject?.id || "").replace(/^run:/, ""),
      at: e.valid_time || null,
      kind: p.kind || "estate",
      source: "eventlog",
      workspace: p.workspace ?? null,
      status: p.outcome ?? null,
      proposal_id: p.proposal_id ?? null
    });
  }
  return out;
}

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

export function collectRuns({ runRecordsDir = null, openLineagePath = null, events = [] } = {}) {
  return [
    ...(runRecordsDir ? fromRunRecords(runRecordsDir) : []),
    ...(openLineagePath ? fromOpenLineage(openLineagePath) : []),
    ...fromKel(events)
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
