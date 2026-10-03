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
// A drive letter, or a UNC host and share. Both are ALLOWLISTED character by character for the same
// reason the segments below are.
const VOLUME_ROOT =
  /^(?:[A-Za-z]:|\\\\[A-Za-z0-9][A-Za-z0-9._-]{0,62}\\[A-Za-z0-9][A-Za-z0-9 _$-]{0,62})$/u;
// WHAT A SEGMENT MAY CONTAIN, as an allowlist. The first attempt denied the characters that looked
// dangerous and asked whether the last segment "looked like a file". Neither could hold
// (claude-s3-verifier-2's E1): a trailing space or dot made "contract.pdf " a different string and
// the same file to Windows; an extension over eight characters missed; a file name in a
// non-final segment was never examined; and U+2216, U+FE68 and U+29F9 carried a whole multi-level
// path inside one "legal" segment. A denylist of disguises loses to the next disguise.
//
// So: ASCII letters, digits, space, underscore and hyphen, starting and ending with a letter or
// digit. No dot, so no extension can be formed at all; no trailing space or dot, so no two
// spellings of one name; no non-ASCII, so no homoglyph separator.
//
// Written A-Za-z rather than a-z with the `i` flag, because under Unicode case folding `i` admits
// U+017F (long s) as `s` and U+212A (kelvin sign) as `k` — so the rule said "ASCII only" and took
// two characters that are not (claude-s3-verifier-3's F2). No path could hide in them, but
// "F:\uſers" and "F:\users" would be two keys for one volume, and a hub rule written as the
// string "users" would miss the first.
const VOLUME_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9 _-]{0,62}[A-Za-z0-9])?$/u;

// WHAT THIS GUARANTEES, exactly — the last version's comment claimed more than its code did, which
// is the same fault as the one it was fixing. A path to a FILE cannot pass: a file name needs a dot
// or a character this allowlist excludes, and depth is capped at two segments below the root.
// WHAT IT DOES NOT GUARANTEE: a folder-mounted volume and an ordinary folder are the same shape, so
// "F:\\Users\\id_rsa" is still a well-formed volume name and only the hub's quarantine rules can
// refuse it. That is why the map fails closed without a policy.
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
  const parts = s.replace(/\\+$/u, "").split("\\");
  // a UNC root is "\\\\host\\share", which splits into four parts with two empty leading ones
  const rootParts = s.startsWith("\\\\") ? 4 : 1;
  const root = parts.slice(0, rootParts).join("\\");
  const rest = parts.slice(rootParts);
  if (!VOLUME_ROOT.test(root)) return "volume name";
  if (rest.length > VOLUME_DEPTH) return "volume name";
  // EVERY segment, not just the last: a file name in the middle of a path is still a file name
  if (rest.some((seg) => !VOLUME_SEGMENT.test(seg))) return "volume name";
  if (quarantined(s, rules)) return "quarantined volume";
  return null;
};
// the same judgement, for a hub deciding what it may OFFER to sweep before it sweeps it (S17)
export const volumeNameProblem = (v, rules = []) => volumeProblem(v, rules);

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
//
// STALE MEANS UNHEARD, NOT OLD (S17). This used to key on when the SWEEP finished, while the panel
// said the node "has gone quiet" and the threshold was chosen as "six missed pushes" — but a
// heartbeat re-sends the same sweep, so a node pushing faithfully read stale thirty minutes after
// it swept, and a walker sweep of F: takes longer than that. Staleness now keys on heard_at, which
// only acceptMap writes; a push without one (a fixture, never the wire) is taken as heard when it
// finished. The sweep's age is still reported, as ageMs, and is never called staleness.
// The default IS the shared constant, not a second spelling of thirty minutes. It was a literal
// 1_800_000 here, which is a duplicate of a named value fifty lines below and reads as though the
// two could differ.
//
// THE STRONGER CLAIM THIS COMMENT USED TO MAKE WAS WRONG, and it is corrected here rather than only
// in the log, because a comment wider than its code is exactly this epic's recurring defect: it
// said the duplicate literal was WHY the S3 gate had to assert that server/app.js passed the
// constant. It was not. estate_api.mjs already defaulted to DEFAULT_MAP_MAX_AGE_MS before any of
// this, so app.js's option was redundant either way and the gate's assertion had another reason.
// The de-duplication is still worth having; the causal story attached to it was not measured.
export function foldEstateMap(
  pushes = [],
  { now = Date.now(), maxAgeMs = DEFAULT_MAP_MAX_AGE_MS } = {}
) {
  const machines = {};
  const heard = {}; // machine -> { ms, at }: the last time the hub HEARD it, from any of its pushes
  for (const push of pushes) {
    if (!push?.machine) continue;
    const at = push.heard_at ?? push.finished_at;
    const ms = Date.parse(at ?? "") || 0;
    if (ms > (heard[push.machine]?.ms ?? -1)) heard[push.machine] = { ms, at };
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
    const quiet = now - heard[name].ms > maxAgeMs;
    out[name] = {
      sweep_id: m.sweep_id,
      at: m.at,
      ageMs,
      heard_at: heard[name].at,
      stale: quiet,
      since: quiet ? heard[name].at : null,
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

// How long a node may go quiet before the estate map calls it stale (plan §7: a node that stops
// pushing is shown "stale since T", never empty). Thirty minutes is six missed pushes at the
// satellite agent's default five-minute heartbeat. Named here so a test can assert the VALUE, not
// merely that some value was passed (claude-s3-verifier-2's W13).
export const DEFAULT_MAP_MAX_AGE_MS = 30 * 60 * 1000;

// parseQuarantinePolicy(raw) — the hub's R31 rules from the text of coordination/estate/
// quarantine.json: { "rules": ["cv", "curriculum vitae", "/payroll/i"] }. A string matches as a
// case-insensitive substring; "/…/flags" is read as a regular expression.
//
// Returns null for anything it cannot use, INCLUDING malformed JSON and a "rules" that is not a
// list. null is not an empty policy: a hub with null refuses maps, so a privacy file with a typo
// closes the surface instead of quietly widening it. It lives here rather than in app.js so that a
// test can reach it — in app.js it was reachable only by the gate reading the file as text, and a
// mutation making a malformed policy become an EMPTY one survived (W10).
export function parseQuarantinePolicy(raw) {
  try {
    const rules = JSON.parse(raw).rules;
    if (!Array.isArray(rules)) return null;
    return rules.map((rule) => {
      const re = /^\/(.*)\/([a-z]*)$/u.exec(String(rule));
      return re ? new RegExp(re[1], re[2].includes("u") ? re[2] : `${re[2]}u`) : String(rule);
    });
  } catch {
    return null;
  }
}

// readQuarantinePolicy(file, io) — the hub's policy, read from disk and parsed. Returns null for
// absent, unreadable or unusable, and WARNS for the last two: a policy file that cannot be used
// closes the map surface, and silence there looks exactly like a hub that was never given a policy.
// It lives here, with its io injected, so that the warning is a tested behaviour rather than a line
// a gate can only look at (claude-s3-verifier-2's W-series).
export function readQuarantinePolicy(file, { readFile, warn = console.error } = {}) {
  let raw;
  try {
    raw = readFile(file);
  } catch {
    return null; // absent: no policy, so no map — and nothing to warn about
  }
  const rules = parseQuarantinePolicy(raw);
  if (rules === null) warn(`[estate] ${file} is not a usable quarantine policy — estate maps refused`);
  return rules;
}

// withMap(manifest, map) — attach a map to an outbound manifest only if it may be sent, and say
// why when it may not. The node applies the hub's own guard before the wire, so a bad payload fails
// on the machine that built it; but a map that cannot be sent must not cost the node its SESSION
// registration, which is what aborting the whole announce did (claude-s3-verifier-3's F3). The hub
// keeps exactly this rule on its side — a refused map never stops N7 — so the node mirrors it.
//
// The decision lives here rather than in the agent script because a decision inside a script with
// top-level side effects can only be asserted about as text, and text assertions are what this
// contract's three findings were made of.
export function withMap(manifest, map, rules = []) {
  if (!map) return { manifest, problem: null };
  const problem = mapPayloadProblem(map, rules);
  return problem ? { manifest, problem } : { manifest: { ...manifest, map }, problem: null };
}
