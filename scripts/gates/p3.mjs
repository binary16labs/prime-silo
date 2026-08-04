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

// 6. Serialisation, proven by REAL CONTENTION. The previous version used an in-flight counter
//    inside a sequential loop, which a verifier showed proves nothing: deleting the host lock
//    entirely left every check green. Two threads now contend for one lock_dir.
const serial = py(`
import json, tempfile, threading, time
from benny.sdlc.bench_ledger import run_serialised, HostLock, LockHeld, emit_lineage, require_ledgered, UnledgeredBench, read_register, append_register, register_entry
peak = {"now": 0, "max": 0}
guard = threading.Lock()
def body(s):
    with guard:
        peak["now"] += 1; peak["max"] = max(peak["max"], peak["now"])
    time.sleep(0.12)
    with guard:
        peak["now"] -= 1
    if s == "boom":
        raise RuntimeError("endpoint refused")
    return s
out = {}
with tempfile.TemporaryDirectory() as d:
    def run(tag): out[tag] = run_serialised([tag + "1", tag + "2"], body, lock_dir=d)
    ths = [threading.Thread(target=run, args=(t,)) for t in ("A", "B")]
    [t.start() for t in ths]; [t.join() for t in ths]
    dropped = [v for v in out["A"] + out["B"] if isinstance(v, Exception)]
    seq = run_serialised(["a", "boom", "c"], body, lock_dir=d)
    try:
        with HostLock(d):
            free_after_failure = True
    except LockHeld:
        free_after_failure = False

# the lineage claim: emitted must come from the CALL, never from an import succeeding
calls = []
emitted = emit_lineage({"run_id": "r1"}, emitter=lambda: (
    lambda rid, e: calls.append(rid), lambda rid, e: calls.append(rid)))
def _boom(rid, e): raise RuntimeError("sink down")
failing = emit_lineage({"run_id": "r1"}, emitter=lambda: (_boom, _boom))

# scenario 1 must REFUSE, not merely report
try:
    require_ledgered([], "run-1"); refused_unledgered = False
except UnledgeredBench:
    refused_unledgered = True

print(json.dumps({
  "peak": peak["max"], "dropped": len(dropped),
  "order": [x if isinstance(x, str) else "ERR" for x in seq],
  "free_after_failure": free_after_failure,
  "emitted": emitted["emitted"], "emit_calls": len(calls),
  "failing_sink_reported_emitted": failing["emitted"],
  "refused_unledgered": refused_unledgered,
}))
`);
if (serial.status !== 0) fail(`the serialisation probe did not run: ${serial.stderr.trim()}`);
const s = JSON.parse(serial.stdout.slice(serial.stdout.lastIndexOf("{")));
if (s.peak !== 1) fail(`two subjects genuinely overlapped under contention (peak ${s.peak})`);
if (s.dropped !== 0) fail(`${s.dropped} contended subject(s) were DROPPED instead of queued`);
if (JSON.stringify(s.order) !== JSON.stringify(["a", "ERR", "c"]))
  fail(`a failing subject aborted the run: ${JSON.stringify(s.order)}`);
if (!s.free_after_failure) fail("a failing subject stranded the host lock");
if (!s.emitted || s.emit_calls !== 2)
  fail("emit_lineage did not actually call the RunEvent emitters it claims to");
if (s.failing_sink_reported_emitted)
  fail("a failing lineage sink was reported as emitted — `emitted` must come from the call");
if (!s.refused_unledgered)
  fail("an unledgered bench was not REFUSED — scenario 1's Then clause says it fails");

const t = spawnSync(PY, ["-m", "pytest", "tests/governance/", "-q"], {
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
  "[p3] log volume can never buy ALIVE (7 magnitudes) while CPU and artifact progress both can; " +
    "a trailing stall is WEDGED not latched-ALIVE; thresholds are rates; real two-thread " +
    "contention shows peak concurrency 1 with nothing dropped; emit_lineage reports emitted only " +
    "when it called; an unledgered bench is REFUSED — verified"
);
console.log("[p3] GATE GREEN");
process.exit(0);
