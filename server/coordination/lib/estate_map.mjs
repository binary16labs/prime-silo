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
//   PRIVACY (R31). Two verifiers found leaks by attacking instances: a RegExp flag, error text,
//   a trailing slash, an encoded path. So privacy is decided by three choke points, not by
//   remembering each field:
//     1. canonPath — ONE normaliser for every path and every string rule (NFC, slashes, "." and
//        "..", repeated separators). A rule and a path cannot disagree about spelling.
//     2. every free-text field of a row is tested; one match makes the whole row private.
//     3. no error TEXT is ever stored or published — only a validated error code. There is
//        nothing left to redact, so no encoding of a path inside a message can slip through.
//   Collector names must be plain identifiers and a quarantined volume is refused outright,
//   so the strings the sweep itself writes carry no user data either.
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
const KINDS = new Set(["files", "apps", "media"]);
const COLLECTOR_NAME = /^[a-z][a-z0-9._-]{0,63}$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// --- 1. the one normaliser ----------------------------------------------------------------------

export function canonPath(p) {
  const s = String(p ?? "")
    .normalize("NFC")
    .replace(/\\/gu, "/");
  const unc = s.startsWith("//");
  const rooted = s.startsWith("/");
  const out = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length && out.at(-1) !== ".." && !/^[a-z]:$/iu.test(out.at(-1)))
      out.pop();
    else out.push(seg);
  }
  return (unc ? "//" : rooted ? "/" : "") + out.join("/");
}

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
export const CATEGORIES = Object.freeze([...EXT_CATEGORY.map(([c]) => c), "other"]);
export function categorize(p) {
  for (const [cat, re] of EXT_CATEGORY) if (re.test(p)) return cat;
  return "other";
}

// Rules are strings (case-insensitive substring of the canonical form) or RegExps (tested against
// the canonical form). A RegExp with g or y carries lastIndex between calls, so it is evaluated
// on a stateless copy, never on the caller's object.
const statelessRules = new WeakMap();
function stateless(r) {
  if (!r.global && !r.sticky) return r;
  if (!statelessRules.has(r))
    statelessRules.set(r, new RegExp(r.source, r.flags.replace(/[gy]/gu, "")));
  return statelessRules.get(r);
}

export function isQuarantined(value, rules = []) {
  if (value === null || value === undefined || value === "") return false;
  const n = canonPath(value);
  const lower = n.toLowerCase();
  return rules.some((r) =>
    r instanceof RegExp ? stateless(r).test(n) : lower.includes(canonPath(r).toLowerCase())
  );
}

// --- 3. errors are codes, never text --------------------------------------------------------

export function errorCode(e) {
  const code = e && typeof e === "object" ? e.code : null;
  return typeof code === "string" && ERROR_CODE.test(code) ? code : "UNKNOWN";
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
      location TEXT, private INTEGER NOT NULL DEFAULT 0, sweep_id TEXT NOT NULL,
      PRIMARY KEY (name, version, source)
    );
    CREATE TABLE IF NOT EXISTS media (
      root TEXT NOT NULL, path_hash TEXT NOT NULL, path TEXT, title TEXT, size INTEGER,
      private INTEGER NOT NULL DEFAULT 0, sweep_id TEXT NOT NULL, PRIMARY KEY (root, path_hash)
    );
  `);
  return db;
}

const hashOf = (value) => sha256(canonPath(value).toLowerCase());

// --- 2. whole-row redaction, one function per kind -----------------------------------------

function fileRow(row, rules) {
  const p = canonPath(row.path);
  const priv = isQuarantined(p, rules) || isQuarantined(row.category, rules);
  const category = CATEGORIES.includes(row.category) ? row.category : categorize(p);
  return { path: priv ? null : p, path_hash: hashOf(p), category, private: priv ? 1 : 0 };
}

function appRow(row, rules) {
  const fields = [row.name, row.version, row.publisher, row.location];
  if (fields.some((f) => isQuarantined(f, rules)))
    return {
      name: `private:${hashOf(row.name)}`,
      version: "",
      publisher: null,
      location: null,
      private: 1
    };
  return {
    name: String(row.name ?? ""),
    version: String(row.version ?? ""),
    publisher: row.publisher ?? null,
    location: row.location ? canonPath(row.location) : null,
    private: 0
  };
}

function mediaRow(row, rules) {
  // Rules see the full location (root + path): a relative path under a quarantined root is
  // private even though the path alone matches nothing.
  const root = canonPath(row.root);
  const rel = canonPath(row.path);
  const full = /^([a-z]:|\/)/iu.test(rel) || !root ? rel : canonPath(`${root}/${rel}`);
  const rootPrivate = isQuarantined(root, rules);
  const priv = rootPrivate || isQuarantined(full, rules) || isQuarantined(row.title, rules);
  return {
    root: rootPrivate ? `private:${hashOf(root)}` : root,
    path_hash: hashOf(full),
    path: priv ? null : full,
    title: priv ? null : (row.title ?? null),
    private: priv ? 1 : 0
  };
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
  // Configuration faults are refused before anything is written, and their messages name no data.
  for (const c of collectors) {
    if (!COLLECTOR_NAME.test(String(c?.name)))
      throw new TypeError("collector name must be a plain identifier");
    if (!KINDS.has(c.kind)) throw new TypeError("collector kind must be files, apps or media");
  }
  if (scope.some((v) => typeof v !== "string" || !v || isQuarantined(v, quarantine)))
    throw new TypeError("scope contains an empty or quarantined volume");

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
    `INSERT INTO apps (name, version, source, publisher, location, private, sweep_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, version, source) DO UPDATE SET publisher = excluded.publisher,
       location = excluded.location, private = excluded.private, sweep_id = excluded.sweep_id`
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
          const size = Number(row.size) || 0;
          if (c.kind === "files") {
            const r = fileRow(row, quarantine);
            putFile.run(
              volume,
              r.path_hash,
              r.path,
              r.category,
              size,
              row.mtimeMs ?? null,
              r.private,
              sweepId
            );
            digest.update(`f|${volume}|${r.path_hash}|${r.category}|${size}\n`);
            counts.files++;
            counts.bytes += size;
          } else if (c.kind === "apps") {
            const a = appRow(row, quarantine);
            putApp.run(a.name, a.version, c.name, a.publisher, a.location, a.private, sweepId);
            digest.update(`a|${a.name}|${a.version}|${c.name}\n`);
            counts.apps++;
          } else {
            const m = mediaRow(row, quarantine);
            putMedia.run(
              m.root,
              m.path_hash,
              m.path,
              m.title,
              row.size ?? null,
              m.private,
              sweepId
            );
            digest.update(`m|${m.root}|${m.path_hash}|${size}\n`);
            counts.media++;
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
        result.error_code = errorCode(e);
        result.rows = 0;
        if (c.kind === "files")
          db.prepare(
            `INSERT INTO volumes (volume, collector, status, sweep_id, swept_at) VALUES (?, ?, 'errored', ?, ?)
             ON CONFLICT(volume) DO UPDATE SET status = 'errored', sweep_id = excluded.sweep_id`
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
    .prepare(
      "SELECT name, version, source, publisher, location, private FROM apps WHERE sweep_id = ?"
    )
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
      collectors: sweep.collectors.map(({ name, kind, volume, status, rows, error_code }) => ({
        name,
        kind,
        volume,
        status,
        rows,
        ...(error_code ? { error_code } : {})
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
