// EP-Y Y3: carry-forward ledger + nothing-lost close check. Temp workspaces only.
//   node tests/longview_carry_ledger_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendCarry, closeCheck, closeCycle, entryProblems, foldCarry, readCarry } from "../scripts/longview/lib/carry.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "y3-"));
let pass = 0;
const check = (name, fn) => {
  fn();
  pass++;
  console.log(`  ok  ${name}`);
};
const L = (o) => JSON.stringify({ ts: "2026-11-22T10:00:00Z", ...o });
const t0 = new Date("2026-11-22T10:00:00Z");

try {
  check("entry rules: done needs ref, dropped needs owner signature, ids/states/cycles shaped", () => {
    const base = { ts: t0.toISOString(), id: "C0-01", cycle: "C0" };
    assert.deepEqual(entryProblems({ ...base, state: "open" }), []);
    assert.match(entryProblems({ ...base, state: "done" }).join(), /ref/);
    assert.deepEqual(entryProblems({ ...base, state: "done", ref: "8a67087b" }), []);
    assert.match(entryProblems({ ...base, state: "dropped" }).join(), /owner's signature/);
    assert.match(entryProblems({ ...base, state: "dropped", signed_by: "claude", signed_quote: "x" }).join(), /owner's signature/);
    assert.deepEqual(entryProblems({ ...base, state: "dropped", signed_by: "owner", signed_quote: "drop it" }), []);
    assert.match(entryProblems({ ...base, state: "closed" }).join(), /state must be/);
    assert.match(entryProblems({ ...base, id: "x1", state: "open" }).join(), /id must/);
  });

  check("fold: last line wins, item text survives later lines, first cycle kept", () => {
    const { items, problems } = foldCarry(
      [L({ id: "C0-01", cycle: "C0", state: "open", item: "thing" }), L({ id: "C0-01", cycle: "C1", state: "carried" })].join("\n")
    );
    assert.equal(problems.length, 0);
    const it = items.get("C0-01");
    assert.equal(it.state, "carried");
    assert.equal(it.cycle, "C1");
    assert.equal(it.item, "thing");
    assert.equal(it.first_cycle, "C0");
  });

  check("close check: everything accounted → ok; counts by kind", () => {
    const text = [
      L({ id: "C0-01", cycle: "C0", state: "open", item: "a" }),
      L({ id: "C0-02", cycle: "C0", state: "open", item: "b" }),
      L({ id: "C0-03", cycle: "C0", state: "open", item: "c" }),
      L({ id: "C0-01", cycle: "C0", state: "done", ref: "87fcf983" }),
      L({ id: "C0-02", cycle: "C1", state: "carried" }),
      L({ id: "C0-03", cycle: "C0", state: "dropped", signed_by: "owner", signed_quote: "drop C0-03" }),
      L({ id: "C1-01", cycle: "C1", state: "open", item: "found in C1" })
    ].join("\n");
    const c = closeCheck(text, "C0");
    assert.equal(c.ok, true);
    assert.deepEqual(c.tally, { open: 0, carried_forward: 1, done: 1, dropped: 1, later: 1 });
  });

  check("NEGATIVE: one item silently left open blocks the close and is named", () => {
    const text = [L({ id: "C0-01", cycle: "C0", state: "open", item: "a" }), L({ id: "C0-02", cycle: "C0", state: "open", item: "b" }), L({ id: "C0-01", cycle: "C0", state: "done", ref: "x" })].join("\n");
    const c = closeCheck(text, "C0");
    assert.equal(c.ok, false);
    assert.deepEqual(c.unaccounted, ["C0-02"]);
  });

  check("NEGATIVE: carried into the SAME cycle is not accounted (must move forward)", () => {
    const text = [L({ id: "C1-01", cycle: "C1", state: "open", item: "a" }), L({ id: "C1-01", cycle: "C1", state: "carried" })].join("\n");
    assert.deepEqual(closeCheck(text, "C1").unaccounted, ["C1-01"]);
  });

  check("NEGATIVE: an old C0 item carried to C1 and left there blocks closing C1", () => {
    const text = [L({ id: "C0-01", cycle: "C0", state: "open", item: "a" }), L({ id: "C0-01", cycle: "C1", state: "carried" })].join("\n");
    assert.equal(closeCheck(text, "C0").ok, true);
    assert.deepEqual(closeCheck(text, "C1").unaccounted, ["C0-01"]);
  });

  check("NEGATIVE: a torn or invalid line blocks the close (it could hide an item)", () => {
    const torn = [L({ id: "C0-01", cycle: "C0", state: "open", item: "a" }), L({ id: "C0-01", cycle: "C0", state: "done", ref: "x" }), '{"id":"C0-02","cyc'].join("\n");
    const c = closeCheck(torn, "C0");
    assert.equal(c.unaccounted.length, 0);
    assert.equal(c.ok, false);
    assert.match(c.problems[0].problem, /unreadable/);
    const bad = [L({ id: "C0-01", cycle: "C0", state: "open", item: "a" }), L({ id: "C0-01", cycle: "C0", state: "dropped" })].join("\n");
    assert.equal(closeCheck(bad, "C0").ok, false);
  });

  check("NEGATIVE: an item moving back a cycle is a ledger problem", () => {
    const text = [L({ id: "C0-01", cycle: "C1", state: "open", item: "a" }), L({ id: "C0-01", cycle: "C0", state: "done", ref: "x" })].join("\n");
    assert.match(foldCarry(text).problems[0].problem, /moves back/);
  });

  // ---- append-only IO
  const ws = path.join(tmp, "ws");
  const dir = path.join(ws, "longview", "cycles");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "CARRY.jsonl");

  check("append: open → carried → done; earlier bytes never change", () => {
    appendCarry(file, { id: "C1-01", cycle: "C1", state: "open", item: "first", owner: "claude" }, t0);
    const b1 = readCarry(file);
    appendCarry(file, { id: "C1-01", cycle: "C2", state: "carried", note: "next" }, t0);
    appendCarry(file, { id: "C1-01", cycle: "C2", state: "done", ref: "abc123" }, t0);
    const b3 = readCarry(file);
    assert.ok(b3.startsWith(b1));
    assert.equal(b3.trim().split("\n").length, 3);
  });

  check("NEGATIVE append: reopen done, duplicate open, unknown id, backwards cycle, no item text — all refused, nothing written", () => {
    const before = readCarry(file);
    assert.throws(() => appendCarry(file, { id: "C1-01", cycle: "C2", state: "carried" }), /already done/);
    assert.throws(() => appendCarry(file, { id: "C1-01", cycle: "C2", state: "open", item: "x" }), /already exists/);
    assert.throws(() => appendCarry(file, { id: "C1-09", cycle: "C1", state: "done", ref: "x" }), /not in the ledger/);
    appendCarry(file, { id: "C1-02", cycle: "C2", state: "open", item: "second" }, t0);
    const mid = readCarry(file);
    assert.throws(() => appendCarry(file, { id: "C1-02", cycle: "C1", state: "carried" }), /move back/);
    assert.throws(() => appendCarry(file, { id: "C1-03", cycle: "C1", state: "open" }), /item text/);
    assert.throws(() => appendCarry(file, { id: "C1-02", cycle: "C2", state: "dropped", signed_by: "claude", signed_quote: "x" }), /owner's signature/);
    assert.equal(readCarry(file), mid);
    assert.ok(mid.startsWith(before));
  });

  check("append after a torn last line starts a fresh line (no merged JSON)", () => {
    fs.appendFileSync(file, '{"torn":');
    appendCarry(file, { id: "C1-04", cycle: "C1", state: "open", item: "after tear" }, t0);
    const { items, problems } = foldCarry(readCarry(file));
    assert.ok(items.has("C1-04"));
    assert.equal(problems.length, 1); // the torn line itself
  });

  check("close: refused with open items (no .closed.json); passes after resolving; never twice", () => {
    const ws2 = path.join(tmp, "ws2");
    const d2 = path.join(ws2, "longview", "cycles");
    fs.mkdirSync(d2, { recursive: true });
    fs.writeFileSync(path.join(d2, "C1.json"), JSON.stringify({ schema: "longview.cycle/1", cycle: "C1" }));
    const f2 = path.join(d2, "CARRY.jsonl");
    appendCarry(f2, { id: "C1-01", cycle: "C1", state: "open", item: "a" }, t0);
    const r1 = closeCycle({ workspace: ws2, cycle: "C1", by: "test" });
    assert.equal(r1.closed, false);
    assert.ok(!fs.existsSync(path.join(d2, "C1.closed.json")));
    appendCarry(f2, { id: "C1-01", cycle: "C1", state: "done", ref: "T-022" }, t0);
    const r2 = closeCycle({ workspace: ws2, cycle: "C1", by: "test", now: t0 });
    assert.equal(r2.closed, true);
    const rec = JSON.parse(fs.readFileSync(r2.path, "utf8"));
    assert.equal(rec.cycle_manifest_sha256.length, 64);
    assert.equal(rec.tally.done, 1);
    assert.throws(() => closeCycle({ workspace: ws2, cycle: "C1" }), /already closed/);
    assert.throws(() => closeCycle({ workspace: ws2, cycle: "C7" }), /does not exist/);
  });

  // ---- CLI end-to-end: forward closes the gap, exit codes honest
  check("CLI: check exits 1 while open; forward needs --note; forward then check exits 0", () => {
    const ws3 = path.join(tmp, "ws3");
    const d3 = path.join(ws3, "workspaces", "w", "longview", "cycles");
    fs.mkdirSync(d3, { recursive: true });
    const f3 = path.join(d3, "CARRY.jsonl");
    appendCarry(f3, { id: "C0-01", cycle: "C0", state: "open", item: "a" }, t0);
    appendCarry(f3, { id: "C0-02", cycle: "C0", state: "open", item: "b" }, t0);
    const cli = (...a) =>
      spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "longview", "cycle.mjs"), ...a], {
        encoding: "utf8",
        env: { ...process.env, BENNY_HOME: ws3, LONGVIEW_WORKSPACE: "w" }
      });
    assert.equal(cli("carry", "check", "C0").status, 1);
    assert.notEqual(cli("carry", "forward", "C0").status, 0);
    const fw = cli("carry", "forward", "C0", "--note", "C0 closes; work continues in C1");
    assert.equal(fw.status, 0, fw.stderr);
    assert.match(fw.stdout, /carried 2 item/);
    const ok = cli("carry", "check", "C0");
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    assert.equal(cli("carry", "check", "C1").status, 1); // they now belong to C1
  });

  console.log(`PASS ${pass} checks`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
