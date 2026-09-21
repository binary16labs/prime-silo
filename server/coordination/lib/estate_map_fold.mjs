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
// hub cannot report without. It is bounded and judged against the hub's own rules below.
const VOLUME_MAX = 260;

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
  if (quarantined(s, rules)) return "quarantined volume";
  return null;
};

// mapPayloadProblem(payload, rules) — null when the payload may cross the wire, otherwise the
// reason it may not. Names the FIELD, never the value: a rejection message is not a side channel.
export function mapPayloadProblem(payload, rules = []) {
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

  if (!Array.isArray(payload.scope)) return "map scope must be a list";
  for (const v of payload.scope) {
    const bad = volumeProblem(v, rules);
    if (bad) return `map scope contains a ${bad}`;
  }

  if (!Array.isArray(payload.collectors)) return "map collectors must be a list";
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

// machineView(fold, machine) — one machine's volumes and its biggest categories, for
// GET /api/estate/map/:machine. Returns null when the hub has never heard from it: a machine the
// hub cannot name is not an empty machine.
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
    categories: [...byCategory.values()]
      .sort((a, b) => b.bytes - a.bytes || b.items - a.items || a.category.localeCompare(b.category))
      .slice(0, topCategories)
  };
}
