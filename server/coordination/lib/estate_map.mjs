// Estate map (S0) — what one node holds, in one local index, published as evidence.
// Plan: architecture/SOLUTION-estate-map.md §1, §3, §7 · Contract: delivery/tasks/S0.md
//
// Every Prime-Silo node maps its own machine: files, applications, media. This module is the
// shape all of that lands in, and the one place two boundaries are decided so no collector has
// to remember them:
//
//   SCOPE. A sweep records exactly the volumes it walked and, per collector, whether it
//   succeeded. "0 files" from a collector that crashed and "0 files" from an empty volume are
//   different facts; a reader must be able to tell them apart (the inventory.mjs doctrine).
//
//   PRIVACY (R31). A path matching a quarantine rule is replaced by its hash BEFORE it is
//   written anywhere — index, snapshot, event. Collectors never see the rule and cannot forget
//   it. The category survives, so the map still accounts for the bytes.
//
// Collectors are plain objects: { name, kind: "files"|"apps"|"media", volumes?, collect(ctx) },
// where collect returns an (async) iterable of rows. The MFT adapters (S1) and the application
// collector (S2) plug in here; nothing below knows how rows were found.
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { casStoreStream } from "./staging.mjs";
import { ulid, CURRENT_SCHEMA_VERSION, appendKelEvents } from "./kel.mjs";

export const SNAPSHOT_SCHEMA = "estate-map-snapshot/1";
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const normPath = (p) => String(p || "").replace(/\\/gu, "/");

// --- categories: coarse on purpose. The treemap and the storage policy group by these. ---
const EXT_CATEGORY = [
  ["documents", /\.(pdf|docx?|xlsx?|pptx?|odt|ods|rtf|txt|md|csv|epub)$/iu],
  ["images", /\.(jpe?g|png|gif|webp|heic|raw|cr2|nef|tiff?|bmp|svg|psd)$/iu],
  ["video", /\.(mp4|mkv|mov|avi|wmv|m4v|webm|mts)$/iu],
  ["audio", /\.(mp3|flac|wav|m4a|aac|ogg|wma)$/iu],
  ["models", /\.(gguf|safetensors|onnx|pt|pth|ckpt|bin)$/iu],
  ["archives", /\.(zip|7z|rar|tar|gz|tgz|xz|iso|dbk)$/iu],
  ["installers", /\.(exe|msi|msix|appx|dmg|appimage)$/iu],
  ["code", /\.(m?js|cjs|ts|tsx|py|rs|go|java|cs|cpp|c|h|json|ya?ml|toml)$/iu]
];
export function categorize(p) {
  for (const [cat, re] of EXT_CATEGORY) if (re.test(p)) return cat;
  return "other";
}

export function isQuarantined(p, rules = []) {
  const s = normPath(p).toLowerCase();
  return rules.some((r) =>
    r instanceof RegExp ? r.test(normPath(p)) : s.includes(String(r).toLowerCase())
  );
}

// --- the local index ------------------------------------------------------------------------

export function openMap(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sweeps (
      id TEXT PRIMARY KEY, machine TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      scope TEXT NOT NULL, collectors TEXT, counts TEXT, digest TEXT, snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS volumes (
      volume TEXT PRIMARY KEY, collector TEXT, status TEXT, sweep_id TEXT, swept_at TEXT
    );
    CREATE TABLE IF NOT EXISTS files (
      volume TEXT NOT NULL, path_hash TEXT NOT NULL, path TEXT, category TEXT NOT NULL,
      size INTEGER NOT NULL, mtime_ms INTEGER, private INTEGER NOT NULL DEFAULT 0, sweep_id TEXT NOT NULL,
      PRIMARY KEY (volume, path_hash)
    );
    CREATE INDEX IF NOT EXISTS files_size ON files (size);
    CREATE TABLE IF NOT EXISTS apps (
      name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, publisher TEXT,
      location TEXT, sweep_id TEXT NOT NULL, PRIMARY KEY (name, version, source)
    );
    CREATE TABLE IF NOT EXISTS media (
      root TEXT NOT NULL, path_hash TEXT NOT NULL, path TEXT, title TEXT, size INTEGER,
      private INTEGER NOT NULL DEFAULT 0, sweep_id TEXT NOT NULL, PRIMARY KEY (root, path_hash)
    );
  `);
  return db;
}

// A row as it may be stored and published: the path itself only when no rule claims it.
function redact(rowPath, quarantine) {
  const p = normPath(rowPath);
  const priv = isQuarantined(p, quarantine);
  return { path: priv ? null : p, path_hash: sha256(p.toLowerCase()), private: priv ? 1 : 0 };
}

// --- the sweep ---------------------------------------------------------------------------

export async function runSweep({
  db,
  machine,
  collectors = [],
  scope = [],
  quarantine = [],
  now = () => Date.now()
}) {
  const sweepId = ulid();
  const startedAt = new Date(now()).toISOString();
  const inScope = new Set(scope);
  const digest = crypto.createHash("sha256");
  const counts = { files: 0, bytes: 0, apps: 0, media: 0 };
  const results = [];
  db.prepare("INSERT INTO sweeps (id, machine, started_at, scope) VALUES (?, ?, ?, ?)").run(
    sweepId,
    machine,
    startedAt,
    JSON.stringify(scope)
  );

  const putFile = db.prepare(
    `INSERT INTO files (volume, path_hash, path, category, size, mtime_ms, private, sweep_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(volume, path_hash) DO UPDATE SET path = excluded.path, category = excluded.category,
       size = excluded.size, mtime_ms = excluded.mtime_ms, private = excluded.private, sweep_id = excluded.sweep_id`
  );
  const putApp = db.prepare(
    `INSERT INTO apps (name, version, source, publisher, location, sweep_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, version, source) DO UPDATE SET publisher = excluded.publisher,
       location = excluded.location, sweep_id = excluded.sweep_id`
  );
  const putMedia = db.prepare(
    `INSERT INTO media (root, path_hash, path, title, size, private, sweep_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(root, path_hash) DO UPDATE SET path = excluded.path, title = excluded.title,
       size = excluded.size, private = excluded.private, sweep_id = excluded.sweep_id`
  );

  for (const c of collectors) {
    const volumes = c.kind === "files" ? (c.volumes || []).filter((v) => inScope.has(v)) : [null];
    for (const volume of volumes) {
      const result = { name: c.name, kind: c.kind, volume, status: "ok", rows: 0 };
      // Each collector/volume is one transaction: a collector that dies halfway leaves the
      // previous sweep's rows for that volume intact rather than half of a new one.
      db.exec("BEGIN");
      try {
        for await (const row of c.collect({ machine, volume })) {
          if (c.kind === "files") {
            const r = redact(row.path, quarantine);
            const category = row.category || categorize(row.path);
            putFile.run(
              volume,
              r.path_hash,
              r.path,
              category,
              Number(row.size) || 0,
              row.mtimeMs ?? null,
              r.private,
              sweepId
            );
            digest.update(`f|${volume}|${r.path_hash}|${category}|${row.size}\n`);
            counts.files++;
            counts.bytes += Number(row.size) || 0;
          } else if (c.kind === "apps") {
            putApp.run(
              String(row.name),
              String(row.version || ""),
              c.name,
              row.publisher ?? null,
              row.location ?? null,
              sweepId
            );
            digest.update(`a|${row.name}|${row.version || ""}|${c.name}\n`);
            counts.apps++;
          } else if (c.kind === "media") {
            const r = redact(row.path, quarantine);
            putMedia.run(
              String(row.root),
              r.path_hash,
              r.path,
              r.private ? null : (row.title ?? null),
              row.size ?? null,
              r.private,
              sweepId
            );
            digest.update(`m|${row.root}|${r.path_hash}\n`);
            counts.media++;
          } else {
            throw new Error(`unknown collector kind '${c.kind}'`);
          }
          result.rows++;
        }
        if (c.kind === "files") {
          db.prepare("DELETE FROM files WHERE volume = ? AND sweep_id <> ?").run(volume, sweepId);
          db.prepare(
            `INSERT INTO volumes (volume, collector, status, sweep_id, swept_at) VALUES (?, ?, 'ok', ?, ?)
             ON CONFLICT(volume) DO UPDATE SET collector = excluded.collector, status = 'ok',
               sweep_id = excluded.sweep_id, swept_at = excluded.swept_at`
          ).run(volume, c.name, sweepId, new Date(now()).toISOString());
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        result.status = "errored";
        result.error = String(e?.message || e);
        result.rows = 0;
        if (c.kind === "files")
          db.prepare(
            `INSERT INTO volumes (volume, collector, status, sweep_id, swept_at) VALUES (?, ?, 'errored', ?, ?)
             ON CONFLICT(volume) DO UPDATE SET status = 'errored'`
          ).run(volume, c.name, sweepId, new Date(now()).toISOString());
      }
      results.push(result);
    }
  }

  const finishedAt = new Date(now()).toISOString();
  const sweep = {
    id: sweepId,
    machine,
    startedAt,
    finishedAt,
    scope: [...scope],
    collectors: results,
    counts,
    digest: digest.digest("hex")
  };
  db.prepare(
    "UPDATE sweeps SET finished_at = ?, collectors = ?, counts = ?, digest = ? WHERE id = ?"
  ).run(finishedAt, JSON.stringify(results), JSON.stringify(counts), sweep.digest, sweepId);
  return sweep;
}

// --- publish: the rows of this sweep as a gzipped NDJSON blob in CAS, and one event naming it ---

function* snapshotLines(db, sweep) {
  yield JSON.stringify({
    schema: SNAPSHOT_SCHEMA,
    machine: sweep.machine,
    sweep_id: sweep.id,
    scope: sweep.scope,
    collectors: sweep.collectors,
    counts: sweep.counts,
    digest: sweep.digest
  }) + "\n";
  for (const r of db
    .prepare(
      "SELECT volume, path_hash, path, category, size, mtime_ms, private FROM files WHERE sweep_id = ?"
    )
    .iterate(sweep.id))
    yield JSON.stringify({ t: "file", ...r }) + "\n";
  for (const r of db
    .prepare("SELECT name, version, source, publisher, location FROM apps WHERE sweep_id = ?")
    .iterate(sweep.id))
    yield JSON.stringify({ t: "app", ...r }) + "\n";
  for (const r of db
    .prepare("SELECT root, path_hash, path, title, size, private FROM media WHERE sweep_id = ?")
    .iterate(sweep.id))
    yield JSON.stringify({ t: "media", ...r }) + "\n";
}

export const mapLogFile = (estateRoot, machine) =>
  path.join(estateRoot, "eventlog", `estate-map-${machine}.jsonl`);

export async function publishSweep({ db, sweep, estateRoot }) {
  const blob = await casStoreStream(
    estateRoot,
    Readable.from(snapshotLines(db, sweep)).pipe(zlib.createGzip())
  );
  const sid = `sweep:${sweep.machine}:map:${sweep.finishedAt}`;
  const evt = {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type: "sweep_recorded",
    valid_time: sweep.finishedAt,
    txn_time: new Date().toISOString(),
    time_confidence: "known",
    hlc: `${sweep.finishedAt}-0000-${sweep.machine}`,
    machine: sweep.machine,
    authorship: "house",
    sid,
    subject: { kind: "sweep", id: sid },
    payload: {
      scope: sweep.scope,
      map: true,
      collectors: sweep.collectors.map(({ name, kind, volume, status, rows, error }) => ({
        name,
        kind,
        volume,
        status,
        rows,
        ...(error ? { error } : {})
      })),
      counts: sweep.counts,
      digest: sweep.digest,
      snapshot: `sha256:${blob.hash}`,
      snapshot_format: `${SNAPSHOT_SCHEMA}+ndjson+gzip`
    }
  };
  const appended = appendKelEvents(mapLogFile(estateRoot, sweep.machine), [evt]);
  if (!appended.ok) throw new Error(`estate map event append failed: ${appended.reason}`);
  db.prepare("UPDATE sweeps SET snapshot = ? WHERE id = ?").run(`sha256:${blob.hash}`, sweep.id);
  return { event: evt, snapshot: blob };
}

export async function readSnapshot(blobFile) {
  const text = zlib.gunzipSync(fs.readFileSync(blobFile)).toString("utf8");
  const [header, ...rows] = text
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  return { header, rows };
}
