#!/usr/bin/env node
// Gate P3 — benches are governed runs.
//
// Four guarantees. The fourth is the one this estate has actually been burned by, so the gate
// asserts it as a PROPERTY rather than by sampling a couple of fixtures: hold CPU time and artifact
// mtime flat, vary the log volume across seven orders of magnitude, and the verdict must never be
// ALIVE. A tqdm line is not proof of life.
//
// Contract: delivery/tasks/P3.md
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = path.join(ROOT, "runtime");
const PY = process.env.PYTHON ?? "python";
const fail = (msg) => {
  console.error(`[p3] FAIL: ${msg}`);
  process.exit(1);
};
const py = (code) => spawnSync(PY, ["-c", code], { cwd: RUNTIME, encoding: "utf8" });

for (const rel of ["runtime/benny/sdlc/bench_ledger.py", "runtime/tests/governance/test_bench_ledger.py"]) {
  if (!fs.existsSync(path.join(ROOT, rel))) fail(`required artifact missing: ${rel}`);
}

// 1. THE LOG CARRIES NO WEIGHT. Property-style: the real signals are pinned flat and only the log
//    moves. If any log volume buys ALIVE, the estate's oldest liveness lesson has been unlearned.
const probe = py(`
import json
from benny.sdlc.bench_ledger import ALIVE, UNKNOWN, WEDGED, classify_liveness, topology_fingerprint, register_entry, bench_is_ledgered

log_only = [classify_liveness([
    {"t": 0, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": 0},
    {"t": 60, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": n},
]) for n in (0, 1, 10, 1000, 100000, 10000000, 100000000)]

cpu_only = classify_liveness([
    {"t": 0, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": 0},
    {"t": 60, "cpu_seconds": 90.0, "artifact_mtime": 1.0, "log_lines": 0},
])
io_only = classify_liveness([
    {"t": 0, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": 0},
    {"t": 60, "cpu_seconds": 7.0, "artifact_mtime": 99.0, "log_lines": 0},
])
one = classify_liveness([{"t": 0, "cpu_seconds": 7.0, "artifact_mtime": 1.0, "log_lines": 5}])
blind = classify_liveness([{"t": 0, "log_lines": 1}, {"t": 60, "log_lines": 900}])

q4 = topology_fingerprint({"endpoint": "e", "quantisation": "q4_k_m", "context_length": 4096})
q8 = topology_fingerprint({"endpoint": "e", "quantisation": "q8_0", "context_length": 4096})
reordered = topology_fingerprint({"context_length": 4096, "quantisation": "q4_k_m", "endpoint": "e"})

try:
    register_entry(subject="s", run_id="", topology={}, rubric_hash="h", metrics={})
    refused_blank_run_id = False
except ValueError:
    refused_blank_run_id = True

print(json.dumps({
  "log_only": log_only, "cpu_only": cpu_only, "io_only": io_only,
  "one_sample": one, "blind": blind,
  "quant_differs": q4 != q8, "order_stable": q4 == reordered,
  "refused_blank_run_id": refused_blank_run_id,
  "unledgered_is_false": bench_is_ledgered([], "run-1") is False,
  "ALIVE": ALIVE, "WEDGED": WEDGED, "UNKNOWN": UNKNOWN,
}))
`);
if (probe.status !== 0) fail(`the ledger probe did not run:\n${probe.stderr.trim()}`);
const r = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop());

for (const [i, verdict] of r.log_only.entries())
  if (verdict === r.ALIVE)
    fail(`log volume alone produced ALIVE at sample ${i} — a tqdm line is not proof of life`);
if (!r.log_only.every((v) => v === r.WEDGED))
  fail(`flat CPU + flat artifacts must be WEDGED, got ${JSON.stringify(r.log_only)}`);

// 2. ...and the converse, so the check is not simply "always wedged". A quiet job doing real work
//    must not be killed, or the guarantee is useless in the other direction.
if (r.cpu_only !== r.ALIVE) fail(`advancing CPU must read ALIVE, got ${r.cpu_only}`);
if (r.io_only !== r.ALIVE) fail(`advancing artifact mtime must read ALIVE, got ${r.io_only}`);

// 3. Absence of evidence is not evidence of life.
if (r.one_sample !== r.UNKNOWN) fail(`a single sample must be UNKNOWN, got ${r.one_sample}`);
if (r.blind !== r.UNKNOWN) fail(`missing resource fields must be UNKNOWN, got ${r.blind}`);

// 4. R11 — the record can prove WHICH engine ran.
if (!r.quant_differs) fail("q4_k_m and q8_0 fingerprint the same — the record cannot prove which ran");
if (!r.order_stable) fail("the topology fingerprint depends on dict ordering — it is not a fingerprint");

// 5. R9 — an entry that cannot be traced is refused, and an unledgered bench reads as unledgered.
if (!r.refused_blank_run_id) fail("a register entry with a blank run_id was accepted");
if (!r.unledgered_is_false) fail("an empty register reported a bench as ledgered");

// 6. Serialisation, driven through the REAL run_serialised rather than asserted about.
const serial = py(`
import json, tempfile
from benny.sdlc.bench_ledger import run_serialised, HostLock, LockHeld
inflight = {"now": 0, "max": 0}
def body(s):
    inflight["now"] += 1
    inflight["max"] = max(inflight["max"], inflight["now"])
    inflight["now"] -= 1
    if s == "boom":
        raise RuntimeError("endpoint refused")
    return s
with tempfile.TemporaryDirectory() as d:
    out = run_serialised(["a", "boom", "c"], body, lock_dir=d)
    # the lock must be free after a failing subject, or every later bench blocks forever
    try:
        with HostLock(d):
            free_after_failure = True
    except LockHeld:
        free_after_failure = False
print(json.dumps({
  "max_inflight": inflight["max"],
  "order": [x if isinstance(x, str) else "ERR" for x in out],
  "free_after_failure": free_after_failure,
}))
`);
if (serial.status !== 0) fail(`the serialisation probe did not run:\n${serial.stderr.trim()}`);
const s = JSON.parse(serial.stdout.trim().split(/\r?\n/).pop());
if (s.max_inflight !== 1) fail(`two subjects were in flight at once (max ${s.max_inflight}) — the eGPU is single-tenant`);
if (JSON.stringify(s.order) !== JSON.stringify(["a", "ERR", "c"]))
  fail(`a failing subject aborted the run: ${JSON.stringify(s.order)}`);
if (!s.free_after_failure) fail("a failing subject stranded the host lock — every later bench would block");

const t = spawnSync(PY, ["-m", "pytest", "tests/governance/test_bench_ledger.py", "-q"], {
  cwd: RUNTIME,
  stdio: "inherit"
});
if (t.status !== 0) {
  console.log("[p3] GATE FAILED (acceptance tests)");
  process.exit(1);
}

// P3 sits on P1. Regression, not an acceptable cost.
const p1 = spawnSync(PY, ["scripts/gates/p1.py"], { cwd: ROOT, stdio: "inherit" });
if (p1.status !== 0) fail("scripts/gates/p1.py regressed");

console.log(
  "[p3] log volume can never buy ALIVE (7 magnitudes, all WEDGED) while CPU and artifact progress " +
    "both can; single sample and missing evidence are UNKNOWN; quantisations fingerprint apart; " +
    "subjects strictly serialised and the lock survives a failing subject — verified"
);
console.log("[p3] GATE GREEN");
process.exit(0);
