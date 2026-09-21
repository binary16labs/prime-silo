// Estate map transport and fold (S3) — a node PUSHES its sweep summary to the hub; the hub folds
// the latest sweep per machine into one estate map. Plan: architecture/SOLUTION-estate-map.md §1, §7.
// Contract: delivery/tasks/S3.md (human-signed 2026-09-21 — it widens the N7 register surface).
//
// Direction is the whole security model (EP-N N7): the node initiates, the hub never reaches in, so
// a satellite behind a Public-profile firewall still appears. Authentication, the LAN gate and the
// R31 guard stay in estate_register.mjs; this file owns WHAT may cross the wire and HOW the hub
// folds what arrives.
//
// What may cross: counts, statuses, category labels, volume names and content HASHES. Never a file
// path, a file name or a byte of content. That is enforced by an ALLOWLIST — a payload with a field
// this file does not name is refused whole. A denylist of "content"/"text" would pass the next field
// name anybody invents, and the map is exactly the kind of payload where a stray field is a leak.
//
// Pure functions over injected inputs (no fs, no network) so the gate can test every rule.

// The only fields a map payload may carry, and what each must be.
const SCALAR = {
  machine: /^[a-z0-9][a-z0-9._-]{0,63}$/iu,
  sweep_id: /^[0-9A-Z]{26}$/u,
  finished_at: /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/u,
  digest: /^[0-9a-f]{64}$/u,
  snapshot: /^sha256:[0-9a-f]{64}$/u,
  snapshot_format: /^[a-z0-9.+-]{1,64}$/u
};
const COLLECTOR_FIELDS = {
  name: /^[a-z][a-z0-9._-]{0,63}$/iu,
  kind: /^(files|apps|media)$/u,
  status: /^(ok|errored)$/u,
  error_code: /^[A-Z][A-Z0-9_]{0,63}$/u
};
const TOTAL_FIELDS = { kind: COLLECTOR_FIELDS.kind, category: /^[a-z0-9][a-z0-9_-]{0,63}$/u };
const COUNT_KEYS = [
  "files",
  "bytes",
  "listed_files",
  "apps",
  "listed_apps",
  "media",
  "listed_media"
];
// A volume name is a path, and the only one allowed through: it names WHERE a sweep ran, which the
// hub cannot report without. Bounding its LENGTH is not enough — "F:\\clients\\Acme\\contract.pdf" is
// 30 characters, and with only a length check it was accepted and served back verbatim
// (claude-s3-verifier's D1). So it is constrained to the SHAPE of a volume:
//   a drive root (F:\\) or a UNC share (\\\\host\\share), optionally with up to two segments for a
//   mount point (F:\\mnt\\vol), no segment that looks like a file, and no character that belongs to a
//   path only when somebody is hiding something in it.
// This narrows the channel; it does not close it, because a folder-mounted volume and a folder are
// the same shape. What it guarantees is that a FILE path cannot pass and that depth is bounded.
// The hub's quarantine rules are the second layer, and they must be wired for that layer to exist.
const VOLUME_MAX = 120;
const VOLUME_DEPTH = 2;
// control characters, NUL, percent-encoding and the fullwidth/alternate separators that let a path
// wear a different face than the one the guard reads
const VOLUME_UNSAFE = /[\u0000-\u001f\u007f%\u2044\u2215\u29f5\uff0f\uff3c]/u;
const VOLUME_ROOT = /^(?:[a-z]:|\\\\[^\\/:*?"<>|]{1,63}\\[^\\/:*?"<>|]{1,63})$/iu;
const VOLUME_SEGMENT = /^[^\\/:*?"<>|][^\\/:*?"<>|]{0,63}$/u;
// a volume is not a file: a trailing extension is the clearest signal that this is neither a drive
// nor a mount point but something somebody wanted the hub to store
const VOLUME_LOOKS_LIKE_A_FILE = /\.[a-z0-9]{1,8}$/iu;
// bounded arrays: 50,000 scope entries of 260 characters travelled as one 13 MB payload
const MAX_SCOPE = 64;
const MAX_COLLECTORS = 256;
const MAX_TOTALS = 1024;
// a sweep cannot have finished in the future; a little clock skew between nodes is normal
const FUTURE_SKEW_MS = 5 * 60_000;

const isCount = (v) => Number.isInteger(v) && v >= 0;
const text = (v) => (typeof v === "string" ? v : null);

// Judged with the HUB's quarantine rules, not the node's: a node that forgot a rule, or was asked
// to sweep a volume the hub considers private, must not be able to put that name in the estate map.
function quarantined(value, rules) {
  const s = String(value ?? "");
  return (rules || []).some((r) =>
    r instanceof RegExp ? r.test(s) : s.toLowerCase().includes(String(r).toLowerCase())
  );
}

const volumeProblem = (v, rules) => {
  const s = text(v);
  if (s === null || s === "" || s.length > VOLUME_MAX) return "volume name";
  if (VOLUME_UNSAFE.test(s)) return "volume name";
  const parts = s.replace(/\\+$/u, "").split("\\");
  // a UNC root is "\\\\host\\share", which splits into four parts with two empty leading ones
  const rootParts = s.startsWith("\\\\") ? 4 : 1;
  const root = parts.slice(0, rootParts).join("\\");
  const rest = parts.slice(rootParts);
  if (!VOLUME_ROOT.test(root)) return "volume name";
  if (rest.length > VOLUME_DEPTH) return "volume name";
  if (rest.some((seg) => !VOLUME_SEGMENT.test(seg))) return "volume name";
  if (rest.length && VOLUME_LOOKS_LIKE_A_FILE.test(rest[rest.length - 1])) return "volume name";
  if (quarantined(s, rules)) return "quarantined volume";
  return null;
};

// mapPayloadProblem(payload, rules) — null when the payload may cross the wire, otherwise the
// reason it may not. Names the FIELD, never the value: a rejection message is not a side channel.
export function mapPayloadProblem(payload, rules = [], { now = Date.now() } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "map must be an object";
  const allowed = new Set([
    ...Object.keys(SCALAR),
    "scope",
    "collectors",
    "counts",
    "totals"
  ]);
  for (const key of Object.keys(payload))
    if (!allowed.has(key)) return `map carries an unknown field: ${key}`;
  for (const [key, re] of Object.entries(SCALAR)) {
    if (payload[key] === undefined) {
      if (key === "snapshot_format") continue;
      return `map is missing ${key}`;
    }
    if (!re.test(String(payload[key] ?? ""))) return `map field ${key} is not well formed`;
  }
  // A sweep that finished in the future would win the fold for EVER and never go stale, and every
  // real sweep after it would be silently discarded as older (claude-s3-verifier's D3). It is the
  // one bogus value that is also well formed, so the shape check above cannot catch it.
  const finished = Date.parse(payload.finished_at);
  if (!Number.isFinite(finished)) return "map field finished_at is not well formed";
  if (finished > now + FUTURE_SKEW_MS) return "map finished in the future";

  if (!Array.isArray(payload.scope)) return "map scope must be a list";
  if (payload.scope.length > MAX_SCOPE) return "map scope is too long";
  for (const v of payload.scope) {
    const bad = volumeProblem(v, rules);
    if (bad) return `map scope contains a ${bad}`;
  }

  if (!Array.isArray(payload.collectors)) return "map collectors must be a list";
  if (payload.collectors.length > MAX_COLLECTORS) return "map collectors is too long";
  for (const c of payload.collectors) {
    if (!c || typeof c !== "object" || Array.isArray(c)) return "map collector must be an object";
    for (const key of Object.keys(c))
      if (!["name", "kind", "volume", "status", "rows", "error_code"].includes(key))
        return `map collector carries an unknown field: ${key}`;
    for (const [key, re] of Object.entries(COLLECTOR_FIELDS))
      if (c[key] !== undefined && c[key] !== null && !re.test(String(c[key])))
        return `map collector field ${key} is not well formed`;
    if (!isCount(c.rows)) return "map collector rows must be a count";
    if (c.volume !== null && c.volume !== undefined) {
      const bad = volumeProblem(c.volume, rules);
      if (bad) return `map collector names a ${bad}`;
    }
  }

  if (!payload.counts || typeof payload.counts !== "object" || Array.isArray(payload.counts))
    return "map counts must be an object";
  for (const key of Object.keys(payload.counts)) {
    if (!COUNT_KEYS.includes(key)) return `map counts carries an unknown field: ${key}`;
    if (!isCount(payload.counts[key])) return `map count ${key} must be a count`;
  }

  if (payload.totals !== undefined) {
    if (!Array.isArray(payload.totals)) return "map totals must be a list";
    if (payload.totals.length > MAX_TOTALS) return "map totals is too long";
    for (const t of payload.totals) {
      if (!t || typeof t !== "object" || Array.isArray(t)) return "map total must be an object";
      for (const key of Object.keys(t))
        if (!["kind", "collector", "volume", "category", "items", "bytes"].includes(key))
          return `map total carries an unknown field: ${key}`;
      for (const [key, re] of Object.entries(TOTAL_FIELDS))
        if (!re.test(String(t[key] ?? ""))) return `map total field ${key} is not well formed`;
      if (!COLLECTOR_FIELDS.name.test(String(t.collector ?? "")))
        return "map total field collector is not well formed";
      if (!isCount(t.items) || !isCount(t.bytes)) return "map total items and bytes must be counts";
      if (t.volume !== "" && t.volume !== null && t.volume !== undefined) {
        const bad = volumeProblem(t.volume, rules);
        if (bad) return `map total names a ${bad}`;
      }
    }
  }
  return null;
}

// buildMapPayload(sweep, extras) — the push payload built from what runSweep/publishSweep already
// produced. Nothing is read from disk and no path is copied: the fields are enumerated, so a future
// field added to a sweep cannot start travelling by accident.
export function buildMapPayload(sweep = {}, { snapshot, snapshotFormat, totals = [] } = {}) {
  const payload = {
    machine: sweep.machine,
    sweep_id: sweep.id,
    finished_at: sweep.finishedAt ?? sweep.finished_at,
    scope: [...(sweep.scope || [])],
    collectors: (sweep.collectors || []).map((c) => ({
      name: c.name,
      kind: c.kind,
      volume: c.volume ?? null,
      status: c.status,
      rows: c.rows,
      ...(c.error_code ? { error_code: c.error_code } : {})
    })),
    counts: Object.fromEntries(COUNT_KEYS.map((k) => [k, sweep.counts?.[k] ?? 0])),
    totals: totals.map((t) => ({
      kind: t.kind,
      collector: t.collector,
      volume: t.volume ?? "",
      category: t.category,
      items: t.items,
      bytes: t.bytes
    })),
    digest: sweep.digest
  };
  if (snapshot) payload.snapshot = snapshot;
  if (snapshotFormat) payload.snapshot_format = snapshotFormat;
  return payload;
}

// --- the fold ------------------------------------------------------------------------------------

const stamp = (p) => Date.parse(p?.finished_at ?? "") || 0;

// A push is newer than what the hub holds when its sweep finished later. Equal timestamps are
// broken by sweep id so the fold is deterministic whichever order the pushes arrived in — two
// sweeps of one machine in the same millisecond must not depend on network ordering.
export function isNewer(candidate, held) {
  if (!held) return true;
  const a = stamp(candidate);
  const b = stamp(held);
  if (a !== b) return a > b;
  return String(candidate?.sweep_id ?? "") > String(held?.sweep_id ?? "");
}

// foldEstateMap(pushes, opts) — the estate map: the latest sweep per machine, and within it the
// latest listing per volume. A machine that has stopped pushing keeps everything it last said and
// is marked stale SINCE a time (§7: a node that stops pushing is never shown empty).
export function foldEstateMap(pushes = [], { now = Date.now(), maxAgeMs = 1_800_000 } = {}) {
  const machines = {};
  for (const push of pushes) {
    if (!push?.machine) continue;
    const held = machines[push.machine];
    if (!isNewer(push, held?.latest)) {
      // An older sweep never overwrites a newer one — but a volume the newer sweep did not cover
      // is still real, so its last known listing is kept rather than dropped.
      if (held) mergeVolumes(held, push, false);
      continue;
    }
    machines[push.machine] = machines[push.machine] ?? { volumes: {} };
    const m = machines[push.machine];
    m.latest = push;
    m.sweep_id = push.sweep_id;
    m.at = push.finished_at;
    m.counts = push.counts;
    m.digest = push.digest;
    m.snapshot = push.snapshot ?? null;
    m.scope = [...(push.scope || [])];
    mergeVolumes(m, push, true);
  }

  const out = {};
  for (const [name, m] of Object.entries(machines)) {
    const ageMs = now - (Date.parse(m.at ?? "") || 0);
    out[name] = {
      sweep_id: m.sweep_id,
      at: m.at,
      ageMs,
      stale: ageMs > maxAgeMs,
      since: ageMs > maxAgeMs ? m.at : null,
      counts: m.counts,
      digest: m.digest,
      snapshot: m.snapshot,
      scope: m.scope,
      volumes: m.volumes,
      totals: m.latest?.totals ?? []
    };
  }
  return { machines: out, at: now };
}

// Per-volume state from a push's collectors. `fresh` is false for a push older than the one already
// folded: it may fill a volume the newer sweep never covered, but never overwrite one it did.
function mergeVolumes(machine, push, fresh) {
  for (const c of push.collectors || []) {
    if (c.kind !== "files" || !c.volume) continue;
    const held = machine.volumes[c.volume];
    if (held && (!fresh || !isNewer(push, { finished_at: held.at, sweep_id: held.sweep_id })))
      continue;
    machine.volumes[c.volume] = {
      collector: c.name,
      status: c.status,
      rows: c.rows,
      at: push.finished_at,
      sweep_id: push.sweep_id,
      ...(c.error_code ? { error_code: c.error_code } : {})
    };
  }
}

// machineView(fold, machine) — one machine's volumes and what it WITHHELD, for
// GET /api/estate/map/:machine. Returns null when the hub has never heard from it: a machine the
// hub cannot name is not an empty machine.
//
// The category breakdown is named `withheld` and not "top categories", because that is what S0's
// totals table holds: runSweep tallies a category ONLY for a row it did not list (outside the
// public roots, or matching a quarantine rule). Serving it as the machine's biggest categories
// would have told the owner "your biggest category is code" while meaning "the biggest category of
// what we hid from you" — a real number under a wrong name, which is worse than no number. A full
// breakdown of what IS listed needs S0 to record listed-row totals; that is estate_map.mjs's
// allowlist, not this contract's, and is carried forward.
export function machineView(fold = {}, machine, { topCategories = 10 } = {}) {
  const m = fold.machines?.[machine];
  if (!m) return null;
  const byCategory = new Map();
  for (const t of m.totals || []) {
    const cur = byCategory.get(t.category) ?? { category: t.category, items: 0, bytes: 0 };
    cur.items += t.items;
    cur.bytes += t.bytes;
    byCategory.set(t.category, cur);
  }
  return {
    machine,
    sweep_id: m.sweep_id,
    at: m.at,
    stale: m.stale,
    since: m.since,
    counts: m.counts,
    snapshot: m.snapshot,
    volumes: m.volumes,
    withheld: {
      // counts.files minus counts.listed_files is the same number from the other side
      items: [...byCategory.values()].reduce((n, c) => n + c.items, 0),
      categories: [...byCategory.values()]
        .sort(
          (a, b) => b.bytes - a.bytes || b.items - a.items || a.category.localeCompare(b.category)
        )
        .slice(0, topCategories)
    }
  };
}
