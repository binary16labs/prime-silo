// Estate map (S0) — what one node holds, in one local index, published as evidence.
// Plan: architecture/SOLUTION-estate-map.md §1, §3, §7 · Contract: delivery/tasks/S0.md
//
// Every node maps its own machine (files, apps, media) into this shape. Two boundaries live here:
//   SCOPE. A sweep records exactly the volumes walked and each collector's status, so a crashed
//   collector's "0 files" is never mistaken for an empty volume (the inventory.mjs doctrine).
//   PRIVACY (R31) is STRUCTURAL (owner decision after four verifier FAILs of pattern redaction):
//     - a file or media item is listed only if its CANONICAL path lies under a public root the
//       owner configured, and no quarantine rule matches it. Everything else adds to totals
//       (category, count, bytes) and leaves no name and no path hash anywhere.
//     - every decision is made on the exact text that would be stored, so no normalisation can
//       remove the part of a value a rule was written for.
//     - error text is never stored; only a validated code.
//   Rules narrow what is public; they can never widen it.
// Collectors: { name, kind: "files"|"apps"|"media", volumes?, collect(ctx) -> iterable of rows }.
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { casStoreStream } from "./staging.mjs";
import { ulid, CURRENT_SCHEMA_VERSION, appendKelEvents } from "./kel.mjs";

export const SNAPSHOT_SCHEMA = "estate-map-snapshot/2";
const KINDS = new Set(["files", "apps", "media"]);
const COLLECTOR_NAME = /^[a-z][a-z0-9._-]{0,63}$/iu;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,31}$/u;
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Storage form of a path: NFC, forward slashes, no "." or repeated separators, ".." resolved and
// never above a root, Win32 namespace prefixes (\\?\C:\, \\?\UNC\server) removed. A path is
// canonicalised BEFORE it is judged, and it is the canonical form that is judged and stored.
export function canonPath(p) {
  const s = String(p ?? "")
    .normalize("NFC")
    .replace(/\\/gu, "/")
    .replace(/^\/\/[?.]\/UNC\//iu, "//")
    .replace(/^\/\/[?.]\/(?=[a-z]:)/iu, "");
  const unc = s.startsWith("//");
  const rooted = s.startsWith("/");
  const out = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    const atRoot = out.length === 0 || /^[a-z]:$/iu.test(out.at(-1));
    if (seg === ".." && atRoot && (rooted || out.length)) continue;
    if (seg === ".." && !atRoot && out.at(-1) !== "..") out.pop();
    else out.push(seg);
  }
  return (unc ? "//" : rooted ? "/" : "") + out.join("/");
}

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

// Matching spellings of a text. Characters are folded (compatibility forms, case beyond ASCII,
// invisible characters, slash direction) but nothing that could carry a rule's term is removed:
// no path resolution happens here, so "CV Builder/.." still contains "cv".
const fold = (s) =>
  String(s)
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, "")
    .toLowerCase()
    .replace(/i\u0307/gu, "i")
    .replace(/ß/gu, "ss")
    .replace(/ς/gu, "σ")
    .replace(/\\/gu, "/")
    .replace(/[. ]+(?=\/|$)/gu, ""); // Win32 ignores trailing dots and spaces in a path segment

// A string RULE may be written as any path spelling ("..\x\Documents", "\\?\C:\...", "./a/./b"),
// so it is canonicalised before folding. Resolving a rule cannot delete anything from a value.
const ruleForm = (r) => fold(canonPath(r)).replace(/^(\.\.\/)+/u, "");

// A RegExp rule runs on a stateless, case-insensitive copy (g/y carry lastIndex between rows;
// Windows names are case-insensitive, so a case-sensitive rule would silently miss).
const statelessRules = new WeakMap();
function stateless(r) {
  if (!statelessRules.has(r))
    statelessRules.set(r, new RegExp(r.source, r.flags.replace(/[gyi]/gu, "") + "i"));
  return statelessRules.get(r);
}

// `texts` are the exact strings that would be stored (plus, for a path, the collector's original
// spelling). A match on any spelling of any of them is a match.
export function isQuarantined(texts, rules = []) {
  const values = (Array.isArray(texts) ? texts : [texts]).filter(
    (t) => t !== null && t !== undefined && t !== ""
  );
  if (!values.length || !rules.length) return false;
  const spellings = new Set();
  for (const v of values)
    for (const s of [String(v), fold(v)]) {
      const w = s.replace(/\//gu, "\\");
      for (const x of [s, `${s}/`, w, `${w}\\`]) spellings.add(x);
    }
  const folded = values.map((v) => `${fold(v)}/`);
  return rules.some((r) =>
    r instanceof RegExp
      ? [...spellings].some((s) => stateless(r).test(s))
      : folded.some((f) => f.includes(ruleForm(r)))
  );
}

// Only plain strings and genuine same-realm RegExps are rules. An object, a subclass with its own
// test(), or a RegExp from another realm would silently match nothing, so all are refused, as is a
// string rule that folds to nothing or to a bare separator (it would match everything).
function assertRules(rules) {
  if (!Array.isArray(rules)) throw new TypeError("quarantine must be a list of rules");
  for (const r of rules) {
    const isRegExp = r instanceof RegExp && Object.getPrototypeOf(r) === RegExp.prototype;
    if (!(typeof r === "string" || isRegExp))
      throw new TypeError("quarantine rules must be strings or RegExps");
    if (typeof r === "string" && ["", "/", "//"].includes(ruleForm(r).trim()))
      throw new TypeError("quarantine rule is empty or a bare separator");
  }
}

// Public roots are absolute canonical paths the owner chose to expose by name.
function publicRootsOf(roots, rules) {
  if (!Array.isArray(roots)) throw new TypeError("publicRoots must be a list of paths");
  return roots.map((r) => {
    const c = typeof r === "string" ? canonPath(r) : "";
    if (!/^([a-z]:|\/)/iu.test(c) || isQuarantined(c, rules))
      throw new TypeError("public root must be an absolute path matching no rule");
    return c.toLowerCase().replace(/\/+$/u, "");
  });
}
const underRoot = (canon, roots) => {
  const lower = canon.toLowerCase();
  return roots.some((r) => lower === r || lower.startsWith(`${r}/`));
};

export function errorCode(e, rules = []) {
  const code = e && typeof e === "object" ? e.code : null;
  const ok = typeof code === "string" && ERROR_CODE.test(code) && !isQuarantined(code, rules);
  return ok ? code : "UNKNOWN";
}

// Free text from a collector must be text: an object's toString can say anything, even something
// different on each call. Anything else fails the collector (recorded as an error code only).
function txt(x) {
  if (x === null || x === undefined || x === "") return null;
  if (typeof x === "string" || typeof x === "number") return String(x);
  throw new TypeError("collector row field is not text");
}
const num = (x) => {
  const n = typeof x === "bigint" ? Number(x) : x instanceof Date ? x.getTime() : Number(x);
  return x !== null && x !== "" && Number.isFinite(n) && n >= 0 ? n : null;
};

export function openMap(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  // secure_delete zeroes removed rows; checkpoint() below truncates the WAL, which otherwise keeps
  // page images of rows a later rule or root change deleted.
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA secure_delete = ON;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS sweeps (
      id TEXT PRIMARY KEY, machine TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
      scope TEXT NOT NULL, collectors TEXT, counts TEXT, digest TEXT, snapshot TEXT
    );
    CREATE TABLE IF NOT EXISTS volumes (
      volume TEXT PRIMARY KEY, collector TEXT, status TEXT, sweep_id TEXT, swept_at TEXT
    );
    CREATE TABLE IF NOT EXISTS files (
      volume TEXT NOT NULL, path_key TEXT NOT NULL, path TEXT NOT NULL, category TEXT NOT NULL,
      size INTEGER, mtime_ms INTEGER, sweep_id TEXT NOT NULL, PRIMARY KEY (volume, path_key)
    );
    CREATE INDEX IF NOT EXISTS files_size ON files (size);
    CREATE TABLE IF NOT EXISTS totals (
      kind TEXT NOT NULL, collector TEXT NOT NULL, volume TEXT NOT NULL, category TEXT NOT NULL,
      items INTEGER NOT NULL, bytes INTEGER NOT NULL, sweep_id TEXT NOT NULL,
      PRIMARY KEY (kind, collector, volume, category)
    );
    CREATE TABLE IF NOT EXISTS apps (
      name TEXT NOT NULL, version TEXT NOT NULL DEFAULT '', source TEXT NOT NULL, publisher TEXT,
      location TEXT, sweep_id TEXT NOT NULL, PRIMARY KEY (name, version, source)
    );
    CREATE TABLE IF NOT EXISTS media (
      collector TEXT NOT NULL, path_key TEXT NOT NULL, path TEXT NOT NULL, title TEXT,
      size INTEGER, sweep_id TEXT NOT NULL, PRIMARY KEY (collector, path_key)
    );
  `);
  return db;
}

// When the policy (roots or rules) changes, rows published under the old policy are re-judged and
// removed if no longer public, before anything else happens. A later rule can therefore never be
// defeated by an earlier sweep, even if the collector that listed the row fails this time.
function rescrub(db, roots, rules) {
  const spec = rules.map((r) => (r instanceof RegExp ? `/${r.source}/${r.flags}` : r));
  const policy = sha256(JSON.stringify([roots, spec]));
  if (db.prepare("SELECT value FROM meta WHERE key = 'policy'").get()?.value === policy) return;
  const gone = (p) => !underRoot(p, roots) || isQuarantined(p, rules);
  db.exec("BEGIN");
  const delFile = db.prepare("DELETE FROM files WHERE volume = ? AND path_key = ?");
  for (const r of db.prepare("SELECT volume, path_key, path FROM files").all())
    if (gone(r.path)) delFile.run(r.volume, r.path_key);
  const delMedia = db.prepare("DELETE FROM media WHERE collector = ? AND path_key = ?");
  for (const r of db.prepare("SELECT collector, path_key, path, title FROM media").all())
    if (gone(r.path) || isQuarantined(r.title, rules)) delMedia.run(r.collector, r.path_key);
  const key = "WHERE name = ? AND version = ? AND source = ?";
  for (const r of db.prepare("SELECT name, version, source, publisher, location FROM apps").all()) {
    if (isQuarantined([r.name, r.version, r.publisher, r.location], rules))
      db.prepare(`DELETE FROM apps ${key}`).run(r.name, r.version, r.source);
    else if (r.location && !underRoot(r.location, roots))
      db.prepare(`UPDATE apps SET location = NULL ${key}`).run(r.name, r.version, r.source);
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(policy);
  db.exec("COMMIT");
  checkpoint(db);
}

const checkpoint = (db) => db.exec("PRAGMA wal_checkpoint(TRUNCATE);");

export async function runSweep({
  db,
  machine,
  collectors = [],
  scope = [],
  publicRoots = [],
  quarantine = [],
  now = () => Date.now()
}) {
  // Configuration faults are refused before anything is written; their messages name no data.
  assertRules(quarantine);
  const roots = publicRootsOf(publicRoots, quarantine);
  for (const c of collectors) {
    if (!COLLECTOR_NAME.test(String(c?.name)) || isQuarantined(c.name, quarantine))
      throw new TypeError("collector name must be a plain identifier matching no rule");
    if (!KINDS.has(c.kind)) throw new TypeError("collector kind must be files, apps or media");
  }
  if (scope.some((v) => typeof v !== "string" || !v.trim() || isQuarantined(v, quarantine)))
    throw new TypeError("scope contains an empty or quarantined volume");
  rescrub(db, roots, quarantine);

  const sweepId = ulid();
  const startedAt = new Date(now()).toISOString();
  const inScope = new Set(scope);
  const counts = {
    files: 0,
    bytes: 0,
    listed_files: 0,
    apps: 0,
    listed_apps: 0,
    media: 0,
    listed_media: 0
  };
  const results = [];
  db.prepare("INSERT INTO sweeps (id, machine, started_at, scope) VALUES (?, ?, ?, ?)").run(
    sweepId,
    machine,
    startedAt,
    JSON.stringify(scope)
  );

  const putFile = db.prepare(
    `INSERT INTO files (volume, path_key, path, category, size, mtime_ms, sweep_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(volume, path_key) DO UPDATE SET path = excluded.path, category = excluded.category,
       size = excluded.size, mtime_ms = excluded.mtime_ms, sweep_id = excluded.sweep_id`
  );
  const putApp = db.prepare(
    `INSERT INTO apps (name, version, source, publisher, location, sweep_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name, version, source) DO UPDATE SET publisher = excluded.publisher,
       location = excluded.location, sweep_id = excluded.sweep_id`
  );
  const putMedia = db.prepare(
    `INSERT INTO media (collector, path_key, path, title, size, sweep_id) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(collector, path_key) DO UPDATE SET path = excluded.path, title = excluded.title,
       size = excluded.size, sweep_id = excluded.sweep_id`
  );
  const putTotal = db.prepare(
    `INSERT INTO totals (kind, collector, volume, category, items, bytes, sweep_id) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind, collector, volume, category) DO UPDATE SET items = excluded.items,
       bytes = excluded.bytes, sweep_id = excluded.sweep_id`
  );

  for (const c of collectors) {
    const volumes = c.kind === "files" ? (c.volumes || []).filter((v) => inScope.has(v)) : [""];
    for (const volume of volumes) {
      const result = { name: c.name, kind: c.kind, volume: volume || null, status: "ok", rows: 0 };
      const totals = new Map(); // category -> { items, bytes } for everything not listed by name
      const tally = (category, bytes) => {
        const t = totals.get(category) ?? { items: 0, bytes: 0 };
        t.items++;
        t.bytes += bytes ?? 0;
        totals.set(category, t);
      };
      // Each collector/volume is one transaction: a collector that dies halfway leaves the
      // previous sweep's (already re-judged) rows intact rather than half of a new one.
      db.exec("BEGIN");
      try {
        for await (const row of c.collect({ machine, volume: volume || null })) {
          const size = num(row.size);
          if (c.kind === "files") {
            const raw = txt(row.path) ?? "";
            const p = canonPath(raw);
            const category = categorize(p);
            counts.files++;
            counts.bytes += size ?? 0;
            if (underRoot(p, roots) && !isQuarantined([p, raw], quarantine)) {
              putFile.run(volume, p.toLowerCase(), p, category, size, num(row.mtimeMs), sweepId);
              counts.listed_files++;
            } else tally(category, size);
          } else if (c.kind === "apps") {
            const fields = [row.name, row.version, row.publisher, row.location].map(txt);
            const [name, version, publisher, location] = fields;
            counts.apps++;
            const loc = location && canonPath(location);
            // An app installed somewhere a rule covers is itself private, not just its location.
            if (!name || isQuarantined([name, version, publisher, loc, location], quarantine)) {
              tally("apps", 0);
            } else {
              const public_ = loc && underRoot(loc, roots);
              putApp.run(name, version ?? "", c.name, publisher, public_ ? loc : null, sweepId);
              counts.listed_apps++;
            }
          } else {
            const [rootRaw, relRaw, title] = [row.root, row.path, row.title].map(txt);
            const rel = canonPath(relRaw);
            const absolute = /^([a-z]:|\/)/iu.test(rel) || !rootRaw;
            const full = absolute ? rel : canonPath(`${rootRaw}/${relRaw}`);
            const rawFull = absolute ? relRaw : `${rootRaw}/${relRaw}`;
            const category = categorize(full);
            counts.media++;
            const listed =
              underRoot(full, roots) &&
              !isQuarantined([full, rawFull], quarantine) &&
              !isQuarantined(title, quarantine);
            if (listed) {
              putMedia.run(c.name, full.toLowerCase(), full, title, size, sweepId);
              counts.listed_media++;
            } else tally(category, size);
          }
          result.rows++;
        }
        for (const [category, t] of totals)
          putTotal.run(c.kind, c.name, volume, category, t.items, t.bytes, sweepId);
        // A successful run replaces this collector's previous rows: nothing it no longer lists survives.
        db.prepare(
          "DELETE FROM totals WHERE kind = ? AND collector = ? AND volume = ? AND sweep_id <> ?"
        ).run(c.kind, c.name, volume, sweepId);
        if (c.kind === "files") {
          db.prepare("DELETE FROM files WHERE volume = ? AND sweep_id <> ?").run(volume, sweepId);
          db.prepare(
            `INSERT INTO volumes (volume, collector, status, sweep_id, swept_at) VALUES (?, ?, 'ok', ?, ?)
             ON CONFLICT(volume) DO UPDATE SET collector = excluded.collector, status = 'ok',
               sweep_id = excluded.sweep_id, swept_at = excluded.swept_at`
          ).run(volume, c.name, sweepId, new Date(now()).toISOString());
        } else if (c.kind === "apps") {
          db.prepare("DELETE FROM apps WHERE source = ? AND sweep_id <> ?").run(c.name, sweepId);
        } else {
          db.prepare("DELETE FROM media WHERE collector = ? AND sweep_id <> ?").run(
            c.name,
            sweepId
          );
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        result.status = "errored";
        result.error_code = errorCode(e, quarantine);
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
    counts
  };
  sweep.digest = sweepDigest(db, sweepId);
  db.prepare(
    "UPDATE sweeps SET finished_at = ?, collectors = ?, counts = ?, digest = ? WHERE id = ?"
  ).run(finishedAt, JSON.stringify(results), JSON.stringify(counts), sweep.digest, sweepId);
  checkpoint(db);
  return sweep;
}

// The rows this sweep wrote, in a stable order. The digest is computed over exactly what the
// snapshot publishes, so the two cannot disagree.
function* sweepRows(db, sweepId) {
  const q = (sql) => db.prepare(sql).iterate(sweepId);
  for (const r of q(
    "SELECT volume, path, category, size, mtime_ms FROM files WHERE sweep_id = ? ORDER BY volume, path_key"
  ))
    yield { t: "file", ...r };
  for (const r of q(
    "SELECT kind, collector, volume, category, items, bytes FROM totals WHERE sweep_id = ? ORDER BY kind, collector, volume, category"
  ))
    yield { t: "total", ...r };
  for (const r of q(
    "SELECT name, version, source, publisher, location FROM apps WHERE sweep_id = ? ORDER BY source, name, version"
  ))
    yield { t: "app", ...r };
  for (const r of q(
    "SELECT collector, path, title, size FROM media WHERE sweep_id = ? ORDER BY collector, path_key"
  ))
    yield { t: "media", ...r };
}

function sweepDigest(db, sweepId) {
  const h = crypto.createHash("sha256");
  for (const r of sweepRows(db, sweepId)) h.update(`${JSON.stringify(r)}\n`);
  return h.digest("hex");
}

function* snapshotLines(db, sweep) {
  const { machine, id, scope, collectors, counts, digest } = sweep;
  const header = {
    schema: SNAPSHOT_SCHEMA,
    machine,
    sweep_id: id,
    scope,
    collectors,
    counts,
    digest
  };
  yield `${JSON.stringify(header)}\n`;
  for (const r of sweepRows(db, id)) yield `${JSON.stringify(r)}\n`;
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
