// S0 — estate map model. Each Scenario in delivery/tasks/S0.md maps to a test here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openMap,
  runSweep,
  publishSweep,
  readSnapshot,
  mapLogFile,
  categorize
} from "../server/coordination/lib/estate_map.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { resolveBlob } from "../server/coordination/lib/staging.mjs";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "estate-map-"));
  return {
    db: openMap(path.join(base, "map", "estate-map-t480.db")),
    estate: path.join(base, "estate-store")
  };
}

const files = (volume, rows, { volumes = [volume] } = {}) => ({
  name: "fixture-files",
  kind: "files",
  volumes,
  async *collect({ volume: v }) {
    for (const r of rows) if (r.path.startsWith(v)) yield r;
  }
});

const blobFile = (estate, snapshot) => resolveBlob(estate, snapshot.replace(/^sha256:/u, ""));

test("Scenario: a sweep with a failing collector still publishes, and says which failed", async () => {
  const { db, estate } = setup();
  const good = files("F:", [
    { path: "F:/media/Movies/a.mkv", size: 1000, mtimeMs: 1 },
    { path: "F:/nas/models/qwen.gguf", size: 5000, mtimeMs: 2 }
  ]);
  const broken = {
    name: "registry-apps",
    kind: "apps",
    collect: async function* () {
      throw new Error("reg query denied");
    }
  };

  const sweep = await runSweep({ db, machine: "t480", collectors: [good, broken], scope: ["F:"] });
  const { event, snapshot } = await publishSweep({ db, sweep, estateRoot: estate });

  const { header, rows } = await readSnapshot(snapshot.path);
  assert.equal(header.counts.files, 2);
  assert.deepEqual(
    rows
      .filter((r) => r.t === "file")
      .map((r) => r.path)
      .sort(),
    ["F:/media/Movies/a.mkv", "F:/nas/models/qwen.gguf"]
  );

  const apps = event.payload.collectors.find((c) => c.kind === "apps");
  assert.equal(apps.status, "errored");
  assert.match(apps.error, /reg query denied/u);
  assert.equal(event.payload.collectors.find((c) => c.kind === "files").status, "ok");

  const log = readKelEvents(mapLogFile(estate, "t480"));
  assert.ok(log.ok);
  assert.equal(log.events[0].payload.snapshot, `sha256:${snapshot.hash}`);
});

test("Scenario: quarantined paths never leave the node as paths", async () => {
  const { db, estate } = setup();
  const secret = "C:/Users/x/Documents/cv-2026.docx";
  const sweep = await runSweep({
    db,
    machine: "optimus",
    collectors: [
      files("C:", [
        { path: secret, size: 42000 },
        { path: "C:/Users/x/Documents/notes.txt", size: 10 }
      ])
    ],
    scope: ["C:"],
    quarantine: ["cv"]
  });
  const { snapshot, event } = await publishSweep({ db, sweep, estateRoot: estate });

  const row = db.prepare("SELECT * FROM files WHERE private = 1").get();
  assert.equal(row.path, null);
  assert.equal(row.category, "documents");
  assert.match(row.path_hash, /^[0-9a-f]{64}$/u);

  const everywhere = [
    JSON.stringify(db.prepare("SELECT * FROM files").all()),
    fs.readFileSync(mapLogFile(estate, "optimus"), "utf8"),
    JSON.stringify(await readSnapshot(snapshot.path)),
    JSON.stringify(event)
  ].join("\n");
  assert.ok(!everywhere.includes("cv-2026"), "the quarantined path leaked");
  assert.ok(everywhere.includes("notes.txt"), "an unquarantined path must still be mapped");
  assert.equal(sweep.counts.bytes, 42010, "private bytes are still accounted for");
});

test("Scenario: the scope travels with the result", async () => {
  const { db, estate } = setup();
  const collector = files(
    "F:",
    [
      { path: "F:/a.bin", size: 1 },
      { path: "C:/b.bin", size: 1 }
    ],
    { volumes: ["C:", "F:"] }
  );
  const sweep = await runSweep({ db, machine: "t480", collectors: [collector], scope: ["F:"] });
  const { event } = await publishSweep({ db, sweep, estateRoot: estate });
  assert.deepEqual(event.payload.scope, ["F:"]);
  assert.deepEqual(
    event.payload.collectors.map((c) => c.volume),
    ["F:"]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE volume = 'C:'").get().n, 0);
});

test("a collector that dies mid-volume keeps the previous sweep's rows for that volume", async () => {
  const { db } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/keep.bin", size: 7 }])],
    scope: ["F:"]
  });
  const dying = {
    name: "flaky",
    kind: "files",
    volumes: ["F:"],
    async *collect() {
      yield { path: "F:/new.bin", size: 1 };
      throw new Error("MFT read interrupted");
    }
  };
  const sweep = await runSweep({ db, machine: "t480", collectors: [dying], scope: ["F:"] });
  assert.equal(sweep.collectors[0].status, "errored");
  assert.deepEqual(
    db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/keep.bin"]
  );
  assert.equal(
    db.prepare("SELECT status FROM volumes WHERE volume = 'F:'").get().status,
    "errored"
  );
});

test("the snapshot re-reads from CAS by its hash, and a re-sweep of a removed file drops it", async () => {
  const { db, estate } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [
      files("F:", [
        { path: "F:/x.gguf", size: 3 },
        { path: "F:/gone.mp4", size: 4 }
      ])
    ],
    scope: ["F:"]
  });
  const sweep = await runSweep({
    db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/x.gguf", size: 3 }])],
    scope: ["F:"]
  });
  const { snapshot } = await publishSweep({ db, sweep, estateRoot: estate });
  const { header, rows } = await readSnapshot(blobFile(estate, `sha256:${snapshot.hash}`));
  assert.equal(header.sweep_id, sweep.id);
  assert.deepEqual(
    rows.map((r) => r.path),
    ["F:/x.gguf"]
  );
  assert.equal(categorize("F:/x.gguf"), "models");
});
