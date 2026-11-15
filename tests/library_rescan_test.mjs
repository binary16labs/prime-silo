// S23 Part 3 — the catalogue keeps itself current. The job asks the estate API which drive is due; the
// hub's one librarian runs it. Every Scenario of S23's schedule maps to a test here.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { catalogue, libraryPath } from "../server/coordination/lib/library.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import LibraryRescanJob from "../server/jobs/library_rescan.js";

const made = [];
test.after(() => {
  for (const d of made)
    fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});
const tmp = () => made[made.push(fs.mkdtempSync(path.join(os.tmpdir(), "s23r-"))) - 1];
const OLD = new Date(Date.now() - 3_600_000);
const write = (root, rel, data) => {
  const f = path.join(root, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
  fs.utimesSync(f, OLD, OLD);
};
const drive = () => {
  const root = tmp();
  write(root, "Photos/a.jpg", "photo a");
  write(root, "Docs/b.txt", "a document");
  return root;
};
const HOUR = 3_600_000;

// a hub over one store, offering the roots given, with NO listing source so nothing here touches es.exe
const hubFor = (roots, store = tmp()) => {
  const home = tmp();
  const api = createEstateApi({
    quarantine: [],
    producer: {
      machine: "T480",
      dbPath: path.join(home, "estate", "estate-map-T480.db"),
      roots: () => roots,
      estateStore: store,
      lister: null
    }
  });
  return { api, store, dir: path.join(store, "library") };
};
const lastPass = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
  try {
    return { ...db.prepare("SELECT * FROM passes ORDER BY started_at DESC LIMIT 1").get() };
  } finally {
    db.close();
  }
};
const passCount = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true, timeout: 10_000 });
  try {
    return db.prepare("SELECT count(*) AS n FROM passes").get().n;
  } finally {
    db.close();
  }
};

test("S23: a due, attached, catalogued drive is rescanned by the hub's one librarian", async () => {
  const root = drive();
  const { api, dir } = hubFor([root]);
  const dbPath = libraryPath(dir, root);
  await catalogue({ root, dbPath });
  const fresh = api.rescanDue({ hours: 24, now: Date.now() });
  assert.deepEqual(fresh.started, [], "just catalogued: not due");
  assert.equal(fresh.skipped[0].why, "not due");

  const due = api.rescanDue({ hours: 24, now: Date.now() + 25 * HOUR });
  assert.deepEqual(due.started, [root], JSON.stringify(due.skipped));
  const r = await due.done;
  assert.equal(r.finished, true);
  assert.equal(
    lastPass(dbPath).started_by,
    "schedule",
    "and the pass says the schedule started it"
  );
});

test("S23: an absent or different drive is never treated as rescanned", async () => {
  const gone = path.join(tmp(), "unplugged-drive");
  const other = drive(); // here, but never catalogued: a different drive at the letter looks like this
  const { api, dir } = hubFor([gone, other]);
  const r = api.rescanDue({ hours: 1, now: Date.now() + 100 * HOUR });
  assert.deepEqual(r.started, [], "no pass runs");
  assert.match(r.skipped.find((s) => s.root === gone)?.why ?? "", /not attached/u);
  assert.match(r.skipped.find((s) => s.root === other)?.why ?? "", /not catalogued/u);
  assert.equal(fs.existsSync(libraryPath(dir, other)), false, "and no new catalogue is made");
});

test("S23: a tick while a pass runs does nothing, and the schedule and the button are single flight", async () => {
  const a = drive();
  const { api, dir } = hubFor([a]);
  const dbPath = libraryPath(dir, a);
  await catalogue({ root: a, dbPath });
  const later = Date.now() + 100 * HOUR;
  const first = api.rescanDue({ hours: 1, now: later });
  assert.deepEqual(first.started, [a]);
  const second = api.rescanDue({ hours: 1, now: later });
  assert.deepEqual(second.started, [], "a second tick during the pass starts nothing");
  assert.match(second.skipped[0].why, /already running/u);
  await first.done;

  // and the Catalogue button meets the same gate while a scheduled pass runs
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const sched = api.rescanDue({ hours: 1, now: later + 100 * HOUR });
    assert.deepEqual(sched.started, [a]);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/estate/library`, {
        method: "POST",
        body: JSON.stringify({ root: a })
      });
      const body = await res.json();
      assert.match(
        body.error ?? "",
        /pass is running/u,
        `the button is refused: ${JSON.stringify(body)}`
      );
      assert.equal(res.ok, false, "and not as a success");
    } finally {
      await sched.done; // never leave a pass writing when this test's folders go
    }
  } finally {
    await new Promise((r) => server.close(r));
  }
  assert.equal(passCount(dbPath), 3, "one first pass and two scheduled ones, never two at once");
});

test("S23: the job is off at 0 and with no store, on otherwise, and only asks the estate API", async () => {
  const params = (values) => ({ get: (k, d) => (k in values ? values[k] : d) });
  const job = new LibraryRescanJob({ jobId: "library_rescan" });
  assert.equal(
    job.isEnabled({ runtimeParams: params({ ESTATE_STORE: "F:/estate-store" }) }),
    false,
    "0 is off"
  );
  assert.equal(
    job.isEnabled({ runtimeParams: params({ ESTATE_LIBRARY_RESCAN_HOURS: 24, ESTATE_STORE: "" }) }),
    false,
    "no store is off"
  );
  const on = { ESTATE_LIBRARY_RESCAN_HOURS: 24, ESTATE_STORE: "F:/estate-store" };
  assert.equal(job.isEnabled({ runtimeParams: params(on) }), true);
  assert.equal(
    job.getSchedule().everyMs,
    15 * 60_000,
    "it checks every 15 minutes which drives are due"
  );

  const asked = [];
  const estate = {
    rescanDue: (q) => (asked.push(q), { started: [], skipped: [{ root: "F:", why: "not due" }] })
  };
  const r = await job.run({ runtimeParams: params(on), services: { estate } }, { now: () => 1234 });
  assert.deepEqual(asked, [{ hours: 24, now: 1234 }], "the job decides nothing itself");
  assert.equal(r.skipped[0].why, "not due");
  const early = await job.run({ runtimeParams: params(on), services: {} });
  assert.match(early.skipped[0].why, /not up yet/u, "before the estate API exists it says so");
});
