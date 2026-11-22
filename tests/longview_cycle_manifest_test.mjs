// EP-Y Y0: cycle manifest, OUTPUTS catalogue, champion/challenger LATEST.json.
// Temp workspaces only — never touches a real workspace.
//   node tests/longview_cycle_manifest_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OUTPUTS, buildCycle, judgeOutputs, lastAttempts, nextCycleId, worst, writeOutputsCatalogue } from "../scripts/longview/lib/cycle.mjs";
import { foldLatest, methodFor, writeEdition } from "../scripts/longview/lib/edition.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "y0-"));
let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok  ${name}`);
};
const g = (verdict) => ({ verdict, contract: "outputs", problem: verdict === "fail" ? "probe failure" : null, warnings: [], checks: [] });
const ph = (id, verdict) => ({ id, ok: verdict !== "fail", gate: g(verdict) });
const ALL = ["inventory", "privacy", "map", "graph", "enrich", "code", "sad", "reduce", "opus", "pdf"];

function workspace(name) {
  const ws = path.join(tmp, name);
  fs.mkdirSync(path.join(ws, "longview", "pipeline"), { recursive: true });
  return ws;
}
function record(ws, name, rec) {
  const p = path.join(ws, "longview", "pipeline", `${name}.json`);
  fs.writeFileSync(p, JSON.stringify({ tag: "v0", commit: "c0ffee", head: "c0ffee", ...rec }));
  return p;
}
const byId = (m, id) => m.outputs.find((o) => o.id === id);

try {
  check("catalogue: O1..O12 in order, ids unique", () => {
    assert.deepEqual(OUTPUTS.map((o) => o.id), Array.from({ length: 12 }, (_, i) => `O${i + 1}`));
  });

  check("worst(): fail > not_run > unjudged > warn > pass", () => {
    assert.equal(worst(["pass", "warn"]), "warn");
    assert.equal(worst(["pass", "unjudged"]), "unjudged");
    assert.equal(worst(["warn", "not_run"]), "not_run");
    assert.equal(worst(["not_run", "fail", "pass"]), "fail");
    assert.equal(worst([]), "pass");
  });

  check("last attempt wins across runs (a failed code phase later re-run to pass)", () => {
    const last = lastAttempts([
      { startedAt: "2026-11-22T06:00:00Z", phases: [ph("code", "pass")] },
      { startedAt: "2026-11-21T11:00:00Z", phases: [ph("code", "fail"), ph("map", "pass")] }
    ]);
    assert.equal(last.get("code").gate.verdict, "pass");
    assert.equal(last.get("map").gate.verdict, "pass");
  });

  check("NEGATIVE: a failed phase fails its output; a missing one is not_run; never pass", () => {
    const last = lastAttempts([{ startedAt: "t", phases: ALL.filter((p) => p !== "enrich").map((p) => ph(p, p === "code" ? "fail" : "pass")) }]);
    const out = judgeOutputs({ last, cycle: "C1" });
    const s = Object.fromEntries(out.map((o) => [o.id, o.status]));
    assert.equal(s.O4, "fail");
    assert.equal(s.O3, "not_run"); // graph passed, enrich never ran
    assert.equal(s.O1, "pass");
    assert.equal(s.O8, "pending");
    assert.equal(s.O9, "not_built");
    assert.equal(s.O12, "self");
    assert.match(out.find((o) => o.id === "O4").phases[0].problem, /probe failure/);
  });

  check("NEGATIVE: a pre-gate record with ok:true is unjudged, not pass", () => {
    const last = lastAttempts([{ startedAt: "t", phases: [{ id: "sad", ok: true, exit: 0 }] }]);
    assert.equal(judgeOutputs({ last, cycle: "C1" }).find((o) => o.id === "O5").status, "unjudged");
  });

  check("cycle ids: none → C0; after C0 → C1", () => {
    const d = path.join(tmp, "ids");
    fs.mkdirSync(d);
    assert.equal(nextCycleId(d), "C0");
    fs.writeFileSync(path.join(d, "C0.json"), "{}");
    fs.writeFileSync(path.join(d, "C0.score.json"), "{}"); // not a cycle file
    assert.equal(nextCycleId(d), "C1");
  });

  check("OUTPUTS.json written once, then unchanged (no OneDrive/F: churn)", () => {
    const d = path.join(tmp, "cat");
    assert.equal(writeOutputsCatalogue(d).wrote, true);
    const r2 = writeOutputsCatalogue(d);
    assert.equal(r2.wrote, false);
    assert.equal(JSON.parse(fs.readFileSync(r2.path, "utf8")).outputs.length, 12);
  });

  // ---- end-to-end on a temp workspace: edition → cycle → previous → append-only
  const ws = workspace("ws");
  const dataOut = path.join(ws, "data_out");
  fs.mkdirSync(dataOut, { recursive: true });
  fs.writeFileSync(path.join(dataOut, "TOGAF_EPIC_V7_SAD_binary16.md"), "# SAD\n");
  fs.mkdirSync(path.join(ws, "longview", "cycles"), { recursive: true });
  fs.writeFileSync(path.join(ws, "longview", "cycles", "C0.json"), JSON.stringify({ schema: "longview.cycle/0-seed", cycle: "C0" }));
  fs.writeFileSync(
    path.join(ws, "longview", "cycles", "CARRY.jsonl"),
    ['{"id":"C0-01","state":"open"}', '{"id":"C0-02","state":"open"}', '{"id":"C0-01","state":"done"}'].join("\n") + "\n"
  );
  const common = { dataOut, inventory: [], cardsDir: path.join(ws, "cards"), generated: "2026-11-22T12:00:00Z", release: {}, agent: {}, promptVersion: "p" };
  const { editionDir } = writeEdition({ ...common, opusDir: "iterations/2026-11-22-t480", produced: ["sad"] });
  const run = record(ws, "r1", { startedAt: "2026-11-22T10:00:00Z", finishedAt: "2026-11-22T12:00:00Z", outcome: "ok", phases: ALL.map((p) => ph(p, "pass")) });

  let c1;
  check("cycle C1: previous = C0 by sha, edition + record hashed, carry counted", () => {
    const r = buildCycle({ workspace: ws, runFiles: [run], editionDir, evidence: { O8: { status: "pass", ref: "build-chapters --verify 12:05Z" } } });
    c1 = r.manifest;
    assert.equal(c1.schema, "longview.cycle/1");
    assert.equal(c1.cycle, "C1");
    assert.equal(c1.previous.cycle, "C0");
    assert.equal(c1.previous.sha256.length, 64);
    assert.equal(c1.edition.name, "2026-11-22-t480");
    assert.equal(c1.edition.role, "champion");
    const paths = c1.hashed.map((h) => h.path);
    assert.ok(paths.includes("longview/pipeline/r1.json"));
    assert.ok(paths.includes("data_out/iterations/2026-11-22-t480/MANIFEST.json"));
    assert.ok(paths.includes("data_out/iterations/2026-11-22-t480/TOGAF_EPIC_V7_SAD_binary16.md"));
    assert.ok(paths.every((p) => !path.isAbsolute(p) && !p.includes("\\")));
    assert.equal(byId(c1, "O8").status, "pass");
    const carry = byId(c1, "O10");
    assert.equal(carry.status, "present");
    assert.equal(carry.items, 2);
    assert.equal(carry.open, 1); // C0-01 is done by its later line
    assert.equal(c1.closed, false);
    assert.ok(fs.existsSync(path.join(ws, "longview", "cycles", "OUTPUTS.json")));
  });

  check("NEGATIVE: an existing cycle file is never overwritten", () => {
    const before = fs.readFileSync(path.join(ws, "longview", "cycles", "C1.json"), "utf8");
    assert.throws(() => buildCycle({ workspace: ws, runFiles: [run], cycle: "C1" }), /append-only/);
    assert.equal(fs.readFileSync(path.join(ws, "longview", "cycles", "C1.json"), "utf8"), before);
  });

  check("NEGATIVE: cycle numbers only go up (C1 exists → explicit C0 refused even if C0 file were absent)", () => {
    fs.renameSync(path.join(ws, "longview", "cycles", "C0.json"), path.join(ws, "C0.moved"));
    assert.throws(() => buildCycle({ workspace: ws, runFiles: [run], cycle: "C0" }), /only go up/);
    fs.renameSync(path.join(ws, "C0.moved"), path.join(ws, "longview", "cycles", "C0.json"));
  });

  check("NEGATIVE: no run record → refused; edition without MANIFEST → refused", () => {
    assert.throws(() => buildCycle({ workspace: ws, runFiles: [] }), /at least one/);
    const bad = path.join(ws, "data_out", "iterations", "no-manifest");
    fs.mkdirSync(bad, { recursive: true });
    assert.throws(() => buildCycle({ workspace: ws, runFiles: [run], editionDir: bad }), /no MANIFEST/);
    assert.ok(!fs.existsSync(path.join(ws, "longview", "cycles", "C2.json")));
  });

  check("dry run writes nothing", () => {
    const r = buildCycle({ workspace: ws, runFiles: [run], write: false });
    assert.equal(r.manifest.cycle, "C2");
    assert.equal(r.manifest.previous.cycle, "C1");
    assert.ok(!fs.existsSync(r.path));
  });

  check("a cycle from two runs takes each phase's last attempt", () => {
    const failed = record(ws, "r2a", { startedAt: "2026-11-23T01:00:00Z", phases: [ph("code", "fail"), ph("enrich", "fail")] });
    const fixed = record(ws, "r2b", { startedAt: "2026-11-23T03:00:00Z", phases: [ph("code", "pass")] });
    const m = buildCycle({ workspace: ws, runFiles: [fixed, failed], write: false }).manifest;
    assert.equal(byId(m, "O4").status, "pass");
    assert.equal(byId(m, "O3").status, "fail"); // enrich still failed; graph not_run
    assert.equal(m.runs.length, 2);
  });

  // ---- LATEST.json champion / challenger
  check("LATEST: champion keeps flat 11-21 fields; challenger listed beside it, never instead", () => {
    const latestPath = path.join(dataOut, "LATEST.json");
    const before = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    assert.equal(before.sad.edition, "2026-11-22-t480");
    assert.equal(before.sad.role, "champion");
    writeEdition({ ...common, opusDir: "iterations/2026-11-22-sad-v8", produced: ["sad"], role: "challenger" });
    const after = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    assert.equal(after.sad.edition, "2026-11-22-t480"); // champion unchanged
    assert.equal(after.sad.method, "TOGAF EPIC V7 SAD");
    assert.equal(after.sad.challengers.length, 1);
    assert.equal(after.sad.challengers[0].edition, "2026-11-22-sad-v8");
    assert.equal(after.sad.challengers[0].method, "TOGAF EPIC V8 SAD (challenger)");
    const em = JSON.parse(fs.readFileSync(path.join(dataOut, "iterations", "2026-11-22-sad-v8", "MANIFEST.json"), "utf8"));
    assert.equal(em.role, "challenger");
    assert.equal(em.methods.sad.id, "togaf_epic_v8");
    // a new champion edition keeps the challenger list
    writeEdition({ ...common, opusDir: "iterations/2026-11-29-t480", produced: ["sad"] });
    const later = JSON.parse(fs.readFileSync(latestPath, "utf8"));
    assert.equal(later.sad.edition, "2026-11-29-t480");
    assert.equal(later.sad.challengers.length, 1);
  });

  check("LATEST: re-running the same challenger edition replaces it, no duplicates", () => {
    const l = foldLatest(foldLatest({}, "sad", { edition: "x" }, "challenger"), "sad", { edition: "x", generated: "2" }, "challenger");
    assert.equal(l.sad.challengers.length, 1);
    assert.equal(l.sad.challengers[0].generated, "2");
    assert.equal(l.sad.edition, null); // no champion invented
  });

  check("NEGATIVE: unknown role / no challenger method → refused before anything is written", () => {
    assert.throws(() => methodFor("sad", "winner"), /champion\|challenger/);
    assert.throws(
      () => writeEdition({ ...common, opusDir: "iterations/book-challenger", produced: ["book"], role: "challenger" }),
      /no challenger method for book/
    );
    assert.ok(!fs.existsSync(path.join(dataOut, "iterations", "book-challenger")));
  });

  console.log(`PASS ${pass} checks`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
