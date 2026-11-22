// LONGVIEW V8 cycle manifest (EP-Y Y0, PLAN-longview-v8-cycle.md §3–§5).
//
// Every cycle produces the SAME named list of outputs (O1–O12, the OUTPUTS.json
// catalogue) and leaves a manifest, cycles/C<n>.json, that says for each output
// whether it passed, warned, failed or never ran, and hashes every file the
// cycle produced so the next cycle's preflight (Y1) can prove nothing changed.
//
// Rules this module enforces:
//   - An output is judged by its phases' stage-gate verdicts (lib/phase_gate.mjs),
//     using the LAST attempt of each phase across the cycle's runs. A missing phase
//     is not_run; a phase recorded before the stage gate existed is unjudged.
//     Neither ever counts as pass (the C0 lesson: ✓ printed on failed phases).
//   - Cycle numbers only go up, and an existing cycle file is never overwritten.
//   - The manifest names the previous cycle by id + sha256 of its bytes.
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const OUTPUTS_SCHEMA = "longview.outputs/1";
export const CYCLE_SCHEMA = "longview.cycle/1";
export const WORKFLOW = "V8";

// Plan §3. `phases` = the pipeline phases that build the output; `file` = an
// artifact in the cycles dir that another EP-Y task writes; `external` = built
// outside the pipeline, judged only from evidence handed in.
export const OUTPUTS = [
  { id: "O1", name: "Session register", phases: ["inventory", "privacy"], source: "inventory + provenance",
    acceptance: "0 unexplained unknown hosts; quarantine count only (R31)" },
  { id: "O2", name: "Cards (delta)", phases: ["map"], source: "map, prompts@hash",
    acceptance: "debt = 0 (need = inventory - quarantined), never tuned to pass" },
  { id: "O3", name: "Knowledge graph + correlation", phases: ["graph", "enrich"], source: "graph + enrich",
    acceptance: "node/edge counts vs previous cycle, no silent drop" },
  { id: "O4", name: "Code graph", phases: ["code"], source: "code",
    acceptance: "phase status honest (no pass on a failed phase)" },
  { id: "O5", name: "TOGAF SAD", phases: ["sad"], deliverable: "sad", source: "sad (champion V7, challenger V8 on the fixed slice)",
    acceptance: "rubric score + citation validity" },
  { id: "O6", name: "The AI Vampire", phases: ["reduce", "opus", "pdf"], deliverable: "book", source: "reduce -> opus -> pdf (V2 method)",
    acceptance: "coverage %, 5/5 eras, 2/2 machines present" },
  { id: "O7", name: "Reports (portfolio, themes, timeline, PRD)", phases: ["reduce"], source: "reduce",
    acceptance: "each regenerated or explicitly carried" },
  { id: "O8", name: "home_code indexes + CH-01..08 chapters", phases: [], external: "home.mjs build-chapters --verify",
    source: "home_code", acceptance: "runs only after runner.lock is released" },
  { id: "O9", name: "Scorecard (frozen rubric)", phases: [], file: "{cycle}.score.json", builtBy: "Y2",
    source: "scorecard", acceptance: "scored vs previous cycle on the same inputs block" },
  { id: "O10", name: "Retrospective + carry-forward ledger", phases: [], file: "CARRY.jsonl", builtBy: "Y3/Y4",
    source: "carry ledger + retrospective miner", acceptance: "every open item accounted for" },
  { id: "O11", name: "NEXT.json (the queued next cycle)", phases: [], file: "NEXT.json", builtBy: "Y6",
    source: "queue", acceptance: "trigger, expected delta, candidates, preflight list" },
  { id: "O12", name: "Cycle manifest + LATEST.json", phases: [], self: true, builtBy: "Y0",
    source: "lib/cycle.mjs + lib/edition.mjs", acceptance: "all file hashes; previous cycle re-verified (Y1)" }
];

export const sha256Bytes = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sha256File = (p) => sha256Bytes(fs.readFileSync(p));
const rel = (base, p) => path.relative(base, p).replace(/\\/g, "/");

/** Worst verdict wins. not_run and unjudged rank below fail but are never pass. */
const RANK = { fail: 4, not_run: 3, unjudged: 2, warn: 1, pass: 0 };
export const worst = (vs) => vs.reduce((a, v) => (RANK[v] > RANK[a] ? v : a), "pass");

/** Last attempt of every phase id across the runs, in run order (runs sorted by start). */
export function lastAttempts(runs) {
  const sorted = [...runs].sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
  const last = new Map();
  for (const r of sorted) for (const p of r.phases || []) last.set(p.id, { ...p, run_started: r.startedAt });
  return last;
}

function phaseVerdict(p) {
  if (!p) return "not_run";
  if (p.gate && p.gate.verdict) return p.gate.verdict; // pass | warn | fail
  return p.ok === false ? "fail" : "unjudged"; // pre-gate record: its ok flag is the child's opinion
}

/**
 * Pure: judge each catalogue output.
 *   last      Map phaseId -> last attempt (lastAttempts)
 *   files     { [relName]: { sha256, bytes, items?, open? } | undefined } for `file` outputs
 *   evidence  { O8: { status: "pass"|"fail"|..., ref } } for external outputs
 */
export function judgeOutputs({ outputs = OUTPUTS, last, files = {}, evidence = {}, cycle }) {
  return outputs.map((o) => {
    const base = { id: o.id, name: o.name };
    if (o.phases.length) {
      const phases = o.phases.map((id) => {
        const p = last.get(id);
        return { id, verdict: phaseVerdict(p), ...(p?.gate?.problem ? { problem: p.gate.problem } : {}) };
      });
      return { ...base, status: worst(phases.map((p) => p.verdict)), phases };
    }
    if (o.external) {
      const ev = evidence[o.id];
      return ev
        ? { ...base, status: ev.status, evidence: ev.ref ?? null }
        : { ...base, status: "pending", check: o.external };
    }
    if (o.file) {
      const name = o.file.replace("{cycle}", cycle);
      const f = files[name];
      return f ? { ...base, status: "present", file: name, ...f } : { ...base, status: "not_built", file: name, built_by: o.builtBy };
    }
    return { ...base, status: "self" };
  });
}

const CYCLE_RE = /^C(\d+)\.json$/;

export function listCycles(cyclesDir) {
  if (!fs.existsSync(cyclesDir)) return [];
  return fs
    .readdirSync(cyclesDir)
    .map((f) => f.match(CYCLE_RE))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
}

export function nextCycleId(cyclesDir) {
  const ns = listCycles(cyclesDir);
  return `C${ns.length ? ns[ns.length - 1] + 1 : 0}`;
}

/** Write OUTPUTS.json only when its content changed. Returns { path, sha256, wrote }. */
export function writeOutputsCatalogue(cyclesDir, outputs = OUTPUTS) {
  fs.mkdirSync(cyclesDir, { recursive: true });
  const p = path.join(cyclesDir, "OUTPUTS.json");
  const body = JSON.stringify({ schema: OUTPUTS_SCHEMA, workflow: WORKFLOW, outputs }, null, 2) + "\n";
  const prev = fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
  if (prev !== body) fs.writeFileSync(p, body);
  return { path: p, sha256: sha256Bytes(body), wrote: prev !== body };
}

function carrySnapshot(p) {
  if (!fs.existsSync(p)) return undefined;
  const buf = fs.readFileSync(p);
  // Latest state per item id (the ledger is append-only; an id may appear several times).
  const state = new Map();
  for (const line of buf.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e.id) state.set(e.id, e.state);
    } catch {
      /* a torn line is Y3's problem; counted below as unreadable */
    }
  }
  const open = [...state.values()].filter((s) => s === "open" || s === "carried").length;
  return { sha256: sha256Bytes(buf), bytes: buf.length, items: state.size, open };
}

/**
 * Build (and optionally write) the cycle manifest.
 *   workspace   workspace root (paths in the manifest are relative to it)
 *   runFiles    pipeline run-record JSON paths that make up this cycle
 *   editionDir  the edition folder this cycle produced (optional)
 *   cycle       explicit id (default: next id); must be above every existing cycle
 *   evidence    external-output evidence (see judgeOutputs)
 *   write       false = dry run (nothing written)
 */
export function buildCycle({ workspace, runFiles = [], editionDir = null, cycle = null, evidence = {}, now = new Date(), write = true }) {
  const cyclesDir = path.join(workspace, "longview", "cycles");
  const existing = listCycles(cyclesDir);
  const id = cycle || nextCycleId(cyclesDir);
  const m = /^C(\d+)$/.exec(id);
  if (!m) throw new Error(`cycle id must look like C<n>, got ${id}`);
  const n = Number(m[1]);
  const cyclePath = path.join(cyclesDir, `${id}.json`);
  if (fs.existsSync(cyclePath)) throw new Error(`append-only: ${id}.json already exists — cycles are never rewritten`);
  if (existing.length && n <= existing[existing.length - 1])
    throw new Error(`cycle numbers only go up: ${id} is not above C${existing[existing.length - 1]}`);
  if (!runFiles.length) throw new Error("a cycle needs at least one pipeline run record");

  const runs = runFiles.map((f) => {
    const buf = fs.readFileSync(f);
    return { file: f, sha256: sha256Bytes(buf), rec: JSON.parse(buf.toString("utf8")) };
  });

  // Files the next preflight re-hashes: run records + the edition (MANIFEST + deliverables).
  const hashed = runs.map((r) => ({ path: rel(workspace, r.file), sha256: r.sha256, bytes: fs.statSync(r.file).size }));
  let edition = null;
  if (editionDir) {
    const mf = path.join(editionDir, "MANIFEST.json");
    if (!fs.existsSync(mf)) throw new Error(`edition has no MANIFEST.json: ${rel(workspace, editionDir)}`);
    const names = fs.readdirSync(editionDir).filter((f) => fs.statSync(path.join(editionDir, f)).isFile()).sort();
    for (const f of names) {
      const p = path.join(editionDir, f);
      hashed.push({ path: rel(workspace, p), sha256: sha256File(p), bytes: fs.statSync(p).size });
    }
    const em = JSON.parse(fs.readFileSync(mf, "utf8"));
    edition = { dir: rel(workspace, editionDir), name: em.edition ?? path.basename(editionDir), role: em.role ?? "champion",
      manifest_sha256: sha256File(mf), methods: em.methods ?? {} };
  }

  const files = {};
  for (const o of OUTPUTS)
    if (o.file) {
      const name = o.file.replace("{cycle}", id);
      const p = path.join(cyclesDir, name);
      if (name === "CARRY.jsonl") files[name] = carrySnapshot(p);
      else if (fs.existsSync(p)) files[name] = { sha256: sha256File(p), bytes: fs.statSync(p).size };
    }

  const catalogue = write ? writeOutputsCatalogue(cyclesDir) : { sha256: sha256Bytes(JSON.stringify({ schema: OUTPUTS_SCHEMA, workflow: WORKFLOW, outputs: OUTPUTS }, null, 2) + "\n") };
  const outputs = judgeOutputs({ last: lastAttempts(runs.map((r) => r.rec)), files, evidence, cycle: id });

  const prevN = [...existing].reverse().find((k) => k < n);
  const previous =
    prevN === undefined ? null : { cycle: `C${prevN}`, file: `longview/cycles/C${prevN}.json`, sha256: sha256File(path.join(cyclesDir, `C${prevN}.json`)) };

  const tally = {};
  for (const o of outputs) tally[o.status] = (tally[o.status] || 0) + 1;

  const manifest = {
    schema: CYCLE_SCHEMA,
    workflow: WORKFLOW,
    cycle: id,
    created: now.toISOString(),
    runs: runs.map((r) => ({
      record: rel(workspace, r.file), sha256: r.sha256, tag: r.rec.tag ?? null, commit: r.rec.commit ?? null,
      head: r.rec.head ?? null, dirty: r.rec.dirty ?? null, started: r.rec.startedAt ?? null, finished: r.rec.finishedAt ?? null,
      outcome: r.rec.outcome ?? null
    })),
    edition,
    outputs_catalogue: { file: "longview/cycles/OUTPUTS.json", schema: OUTPUTS_SCHEMA, sha256: catalogue.sha256 },
    outputs,
    summary: tally,
    hashed,
    previous,
    closed: false, // closing is Y3's nothing-lost check, never this module
    closed_by: null
  };
  if (write) {
    fs.mkdirSync(cyclesDir, { recursive: true });
    fs.writeFileSync(cyclePath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" }); // wx: never clobber
  }
  return { manifest, path: cyclePath, wrote: write };
}
