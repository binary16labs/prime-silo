// U8 — the signed copy: read back, never overwriting, never touching the source.
// Temp folders and a temp governance log throughout; the signature is made only in that temp log.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { catalogue } from "../server/coordination/lib/library.mjs";
import { DEFAULT_POLICY, planCopy } from "../server/coordination/lib/estate_plan_copy.mjs";
import { copyRefusal, robocopyArgs, runCopy } from "../server/coordination/lib/estate_copy.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import { appendKelEvent, readKelEvents, ulid, CURRENT_SCHEMA_VERSION } from "../server/coordination/lib/kel.mjs";
import { proposalSignedEvent, unauthorisedRuns } from "../server/coordination/lib/governance.mjs";
import { collectRuns } from "../server/coordination/lib/runs.mjs";
import { hashFile } from "../server/coordination/lib/nas_catalog.mjs";

const made = [];
test.after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "u8-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000);
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
  return f;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const WIN = process.platform === "win32";
// every file under a root: path, size, modified time - the source must read the same after a copy
const snapshot = (root) => {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else {
        const s = fs.statSync(f);
        out.push([path.relative(root, f), s.size, Math.floor(s.mtimeMs)]);
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a[0].localeCompare(b[0]));
};
// robocopy's effect, for the in-process tests: the named files copied with their dates
const fakeCopy = (calls = []) => async (from, to, names) => {
  calls.push({ from, to, names: [...names] });
  fs.mkdirSync(to, { recursive: true });
  for (const n of names) {
    const s = path.join(from, n);
    if (!fs.existsSync(s)) continue;
    fs.copyFileSync(s, path.join(to, n));
    const st = fs.statSync(s);
    fs.utimesSync(path.join(to, n), st.atime, st.mtime);
  }
};
const noCloud = async () => new Set();

const estate = async () => {
  const f = tmp();
  write(f, "Photos/beach.jpg", "beach photo bytes");
  const src = tmp();
  write(src, "notes.txt", "my notes");
  write(src, "a/x.bin", "repeated content");
  write(src, "b/y.bin", "repeated content"); // a repeat: a pointer, never a second copy
  write(src, "c/one.txt", "one");
  write(src, "c/two.txt", "two");
  const fDb = path.join(tmp(), "f.db");
  const sDb = path.join(tmp(), "s.db");
  await catalogue({ root: f, dbPath: fDb });
  await catalogue({ root: src, dbPath: sDb });
  const p = planCopy({ sourceDb: sDb, sourceRoot: src, sourceName: "Downloads", targetDb: fDb, policy: DEFAULT_POLICY });
  return { f, src, items: p.items.map((l) => JSON.parse(l)), staging: path.join(f, "consolidated", ".staging", "copy-test") };
};
const run = (e, extra = {}) =>
  runCopy({ items: e.items, sourceRoot: e.src, targetRoot: e.f, staging: e.staging, cloudOnly: noCloud, copy: fakeCopy(), ...extra });

test("U8: every placed file has the planned fingerprint and the source's date; repeats are pointers; staging ends empty; the source is unchanged", async () => {
  const e = await estate();
  const before = snapshot(e.src);
  const lines = [];
  const r = await run(e, { record: (x) => lines.push(x) });
  assert.equal(r.outcome, "ok");
  for (const it of e.items.filter((i) => i.to)) {
    const placed = path.join(e.f, ...it.to.split("/"));
    assert.equal(await hashFile(placed), it.sha256, it.to);
    assert.equal(Math.floor(fs.statSync(placed).mtimeMs), Math.floor(fs.statSync(path.join(e.src, it.from)).mtimeMs), "the source's modified date");
  }
  assert.equal(r.counts.copied, e.items.filter((i) => i.to).length);
  assert.equal(r.counts.pointers, 1, "y.bin is recorded as a pointer to x.bin's copy");
  assert.ok(lines.some((l) => l.same_as && l.result === "pointer"));
  assert.ok(!fs.existsSync(e.staging), "staging is removed");
  assert.deepEqual(snapshot(e.src), before, "the source's paths, sizes and dates are identical");
});

test("U8: robocopy is asked to copy - never to move, mirror or purge", () => {
  const a = robocopyArgs("C:\\src", "F:\\stage", ["a.txt"]);
  for (const f of ["/COPY:DAT", "/DCOPY:T", "/Z"]) assert.ok(a.includes(f), f);
  assert.ok(!a.some((x) => /^\/(MOV|MOVE|MIR|PURGE)$/iu.test(x)));
  assert.throws(() => robocopyArgs("C:\\src", "F:\\stage", ["/MIR"]), /never/u, "a file name cannot smuggle a flag in");
});

test("U8: a name on F: that appeared after the plan keeps its bytes and is refused; the same content counts as already there", async () => {
  const e = await estate();
  const first = e.items.find((i) => i.from === "notes.txt");
  const second = e.items.find((i) => i.from === "c/one.txt");
  write(e.f, first.to, "someone else's notes");
  write(e.f, second.to, "one");
  const r = await run(e);
  assert.equal(fs.readFileSync(path.join(e.f, first.to), "utf8"), "someone else's notes", "never overwritten");
  assert.equal(r.counts.refused, 1);
  assert.equal(r.counts.already, 1);
});

test("U8: a name that appears on F: WHILE the batch is staged is still never overwritten (the link refuses)", async () => {
  const e = await estate();
  const it = e.items.find((i) => i.from === "notes.txt");
  const racing = async (from, to, names) => {
    await fakeCopy()(from, to, names);
    if (names.includes("notes.txt")) write(e.f, it.to, "arrived mid-copy");
  };
  const r = await run(e, { copy: racing });
  assert.equal(fs.readFileSync(path.join(e.f, it.to), "utf8"), "arrived mid-copy");
  assert.equal(r.counts.refused, 1);
  assert.ok(!fs.existsSync(e.staging));
});

test("U8: a source file changed after the plan is skipped; a cloud-only file is never opened", async () => {
  const e = await estate();
  write(e.src, "notes.txt", "my notes, edited after signing");
  const calls = [];
  const r = await run(e, {
    copy: fakeCopy(calls),
    cloudOnly: async (dir) => (path.basename(dir) === "c" ? new Set(["two.txt"]) : new Set())
  });
  assert.equal(r.counts.changed, 1);
  assert.ok(!fs.existsSync(path.join(e.f, e.items.find((i) => i.from === "notes.txt").to)), "the changed file is not placed");
  assert.equal(r.counts.cloud_only, 1);
  assert.ok(!calls.some((c) => c.names.includes("two.txt")), "robocopy is never asked for a cloud-only file");
  assert.ok(!fs.existsSync(e.staging));
});

test("U8: a run killed part-way and run again ends where an unbroken run ends", async () => {
  const clean = await estate();
  await run(clean);
  const e = await estate();
  let n = 0;
  const dies = async (...a) => {
    if (++n === 2) throw new Error("killed");
    return fakeCopy()(...a);
  };
  await assert.rejects(run(e, { copy: dies }), /killed/u);
  const again = await run(e);
  assert.equal(again.outcome, "ok");
  const tree = (root) => snapshot(root).map(([p, s]) => [p, s]);
  assert.deepEqual(tree(path.join(e.f, "consolidated")), tree(path.join(clean.f, "consolidated")));
  assert.ok(again.counts.already >= 1, "what the first run placed counts as already there");
});

test("U8: Stop ends the run between batches with staging cleared; a changed drive at the target stops it", async () => {
  const e = await estate();
  let asks = 0;
  const r = await run(e, { stopped: () => ++asks > 1 });
  assert.equal(r.outcome, "stopped");
  assert.ok(!fs.existsSync(e.staging));
  const s = await run(await estate(), { targetOk: () => false });
  assert.equal(s.outcome, "stopped");
  assert.match(s.why, /drive/u);
});

test("U8: real robocopy stages, and the copy is read back and linked into place", { skip: !WIN }, async () => {
  const e = await estate();
  const r = await runCopy({ items: e.items, sourceRoot: e.src, targetRoot: e.f, staging: e.staging, cloudOnly: noCloud });
  assert.equal(r.outcome, "ok");
  assert.equal(r.counts.copied, e.items.filter((i) => i.to).length);
  const it = e.items.find((i) => i.from === "c/two.txt");
  assert.equal(await hashFile(path.join(e.f, ...it.to.split("/"))), it.sha256);
  assert.ok(!fs.existsSync(e.staging));
});

// --- every refusal names its reason ---------------------------------------------------------------------

const OK = {
  machine: "T480",
  writer: "t480",
  copying: false,
  targetPass: false,
  plan: { digest: "d", proposal: { id: "p", state: "signed", authorised: true }, copy: { files: 3, bytes: 100 } },
  asked: "p",
  rehashed: "d",
  claimed: "d",
  chainOk: true,
  free: 20e9,
  target: "F:"
};
test("U8: every condition of a run is checked, and each refusal says which", () => {
  assert.equal(copyRefusal(OK), null);
  const cases = [
    [{ machine: "OPTIMUS" }, /only the T480/u],
    [{ copying: true }, /already running/u],
    [{ targetPass: true }, /being catalogued/u],
    [{ plan: { why: "not catalogued yet" } }, /not catalogued yet/u],
    [{ plan: { ...OK.plan, attached: false } }, /away/u],
    [{ asked: "older" }, /changed since/u],
    [{ chainOk: false }, /governance/u],
    [{ plan: { ...OK.plan, proposal: { id: "p", state: "open", authorised: false } } }, /waiting for your signature/u],
    [{ plan: { ...OK.plan, proposal: { id: "p", state: "signed", authorised: false } } }, /not by a human/u],
    [{ plan: { ...OK.plan, proposal: { id: "p", state: "not raised", authorised: false } } }, /not raised/u],
    [{ rehashed: "x" }, /does not match/u],
    [{ claimed: "x" }, /does not match/u],
    [{ free: null }, /cannot be read/u],
    [{ free: 100 + 10e9 - 1 }, /10 GB/u]
  ];
  for (const [change, why] of cases) assert.match(String(copyRefusal({ ...OK, ...change })), why, JSON.stringify(change));
});

// --- the hub --------------------------------------------------------------------------------------------

async function hubU8({ freeBytes = 10 ** 12, machine = "T480", inline = true } = {}) {
  const e = await estate();
  const home = tmp();
  const store = tmp();
  const gov = path.join(tmp(), "governance.jsonl");
  const offered = [
    { root: e.src, kind: "user", role: "downloads", in_onedrive: false, removable: false, sections: [] },
    { root: e.f, kind: "drive", role: null, removable: true, sections: [] }
  ];
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine,
      dbPath: path.join(home, "estate", `estate-map-${machine}.db`),
      roots: () => offered.map((x) => x.root),
      offered: () => offered,
      estateStore: store,
      lister: null,
      cloudOnly: async () => ({ cloud: new Set(), unknown: [] }),
      target: e.f,
      governanceLog: gov,
      policyFile: path.join(tmp(), "storage-policy.json"),
      freeBytes,
      ...(inline ? { copyWith: { cloudOnly: noCloud, copy: fakeCopy() } } : {})
    }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/api/estate`;
  const call = async (p, body) => {
    const res = await fetch(base + p, body ? { method: "POST", body: JSON.stringify(body) } : {});
    const text = await res.text();
    return { status: res.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
  };
  for (const root of [e.f, e.src]) {
    await call("/library", { root });
    for (let i = 0; i < 500 && (await call("/library")).json.running; i++) await wait(10);
  }
  const plan = async () => {
    for (let i = 0; i < 600; i++) {
      const s = (await call("/library/plan")).json;
      if (s.sources?.length && s.sources.every((x) => !x.computing)) return s;
      await wait(20);
    }
    throw new Error("the plan never settled");
  };
  return { e, gov, home, store, call, plan, close: () => new Promise((r) => server.close(r)) };
}
// the owner's act, made only in the temp log
const sign = (h, id) => appendKelEvent(h.gov, proposalSignedEvent({ proposalId: id, machine: "T480", signer: "owner (test)" }));
const finished = async (h) => {
  for (let i = 0; i < 600; i++) {
    const c = (await h.call("/library/plan")).json.copy;
    if (c && !c.running && c.last) return c.last;
    await wait(20);
  }
  throw new Error("the copy never finished");
};

test("U8: an unsigned proposal writes nothing and says why; an agent's signature is not a signature", async () => {
  const h = await hubU8();
  try {
    const p = (await h.plan()).sources[0];
    let r = await h.call("/library/copy", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not raised/u);
    await h.call("/library/plan/raise", { source: p.id });
    r = await h.call("/library/copy", { source: p.id });
    assert.match(r.json.error, /waiting for your signature/u);
    const agent = { ...proposalSignedEvent({ proposalId: p.proposal.id, machine: "T480", signer: "an agent" }), authorship: "frontier", id: ulid(), schema_version: CURRENT_SCHEMA_VERSION };
    appendKelEvent(h.gov, agent);
    r = await h.call("/library/copy", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /not by a human/u);
    assert.ok(!fs.existsSync(path.join(h.e.f, "consolidated")), "nothing was written to F:");
  } finally {
    await h.close();
  }
});

test("U8: a signed proposal is copied; one run record carries counts and never a path; the gauge has a population", async () => {
  const h = await hubU8();
  try {
    const p = (await h.plan()).sources[0];
    await h.call("/library/plan/raise", { source: p.id });
    sign(h, p.proposal.id);
    assert.equal((await h.plan()).sources[0].proposal.authorised, true);
    const stale = await h.call("/library/copy", { source: p.id, proposal: "copy-an-earlier-plan" });
    assert.equal(stale.status, 409);
    assert.match(stale.json.error, /changed since/u, "the proposal on the owner's screen must be the current one");
    const r = await h.call("/library/copy", { source: p.id, proposal: p.proposal.id });
    assert.equal(r.status, 202, r.text);
    const last = await finished(h);
    assert.equal(last.outcome, "ok");
    assert.equal(last.counts.copied, p.copy.files);
    const events = readKelEvents(h.gov).events;
    const runs = events.filter((x) => x.type === "execution_recorded");
    assert.equal(runs.length, 1, "one run record");
    assert.equal(runs[0].payload.proposal_id, p.proposal.id);
    for (const word of ["notes", "x.bin", "one.txt", h.e.src, h.e.f]) assert.ok(!JSON.stringify(runs[0]).includes(word), `no path in the ledger: ${word}`);
    const all = collectRuns({ events });
    assert.deepEqual(unauthorisedRuns(events, all), [], "the signed run is authorised");
    assert.equal(unauthorisedRuns(events, [...all, { run_id: "rogue", proposal_id: null }]).length, 1, "a run with no signature is flagged");
    const record = fs.readFileSync(path.join(h.store, "library", "copies", `${last.run_id}.jsonl`), "utf8");
    assert.ok(record.includes("notes.txt"), "the per-file record is kept beside the catalogues");
  } finally {
    await h.close();
  }
});

test("U8: the hub runs the copy in a worker, with robocopy and the folder probe; a second copy waits", { skip: !WIN }, async () => {
  const h = await hubU8({ inline: false });
  try {
    const p = (await h.plan()).sources[0];
    await h.call("/library/plan/raise", { source: p.id });
    sign(h, p.proposal.id);
    assert.equal((await h.call("/library/copy", { source: p.id })).status, 202);
    const again = await h.call("/library/copy", { source: p.id });
    assert.ok(again.status === 409 && /already running/u.test(again.json.error), "one copy at a time");
    const last = await finished(h);
    assert.equal(last.outcome, "ok", JSON.stringify(last));
    assert.equal(last.counts.copied, p.copy.files);
    assert.equal(fs.readFileSync(path.join(h.e.f, "consolidated", "Downloads", "c", "one.txt"), "utf8"), "one");
    assert.equal((await h.call("/library/copy/stop", {})).status, 409, "nothing left to stop");
  } finally {
    await h.close();
  }
});

test("U8: a file list that no longer re-hashes to the signed digest is refused", async () => {
  const h = await hubU8();
  try {
    const p = (await h.plan()).sources[0];
    await h.call("/library/plan/raise", { source: p.id });
    sign(h, p.proposal.id);
    // tamper with the saved list the hub would copy from (the plans live beside the hub's map)
    const plans = path.join(h.home, "estate", "plans");
    const lists = fs.readdirSync(plans).filter((x) => x.endsWith(".items.jsonl"));
    assert.equal(lists.length, 1);
    fs.appendFileSync(path.join(plans, lists[0]), `${JSON.stringify({ from: "extra.txt", to: "consolidated/Downloads/extra.txt", sha256: "0".repeat(64), size: 1 })}\n`);
    const r = await h.call("/library/copy", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /does not match/u);
  } finally {
    await h.close();
  }
});

test("U8: only the T480 copies, and only with room for the copy and 10 GB besides", async () => {
  const other = await hubU8({ machine: "OPTIMUS" });
  try {
    const p = (await other.plan()).sources[0];
    await other.call("/library/plan/raise", { source: p.id });
    sign(other, p.proposal.id);
    const r = await other.call("/library/copy", { source: p.id });
    assert.equal(r.status, 403);
    assert.match(r.json.error, /only the T480/u);
  } finally {
    await other.close();
  }
  const tight = await hubU8({ freeBytes: 5e9 });
  try {
    const p = (await tight.plan()).sources[0];
    await tight.call("/library/plan/raise", { source: p.id });
    sign(tight, p.proposal.id);
    const r = await tight.call("/library/copy", { source: p.id });
    assert.equal(r.status, 409);
    assert.match(r.json.error, /10 GB/u);
  } finally {
    await tight.close();
  }
});
