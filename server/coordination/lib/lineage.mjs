// Lineage (SS1/23) — the whole estate folded by subject, and an honest account of the gaps.
// Spec: architecture/SPEC-knowledge-eventlog.md · kel.mjs · evidence.mjs
//
// "Total lineage of everything" is the goal, so the first job of this module is to stop that
// phrase from becoming a lie. Lineage cannot be computed from a wish; it can only be read off
// events that were actually written. What this file does, therefore, is fold every verified
// ledger by subject id, and then measure — as a first-class output, not a footnote — how much
// of the picture is genuinely attested and how much is simply missing.
//
// Three design decisions carry the weight:
//
//   CHAINS ARE PER-LEDGER, AND A BREAK QUARANTINES ONLY ITS OWN LEDGER. The logs are separate
//   hash chains (heartbeat-t480 cannot be concatenated with governance), so each is verified
//   alone. A subject whose events came from a failing ledger is marked quarantined and kept
//   OUT of the attested count — visible, but never counted as evidence.
//
//   PROVENANCE EDGES ARE DECLARED, NEVER INFERRED. An edge exists only where an event says
//   `payload.derived_from` or `payload.caused_by`. Guessing edges from name similarity or
//   timestamp proximity would manufacture exactly the audit trail the regulation exists to
//   test, and a manufactured one looks identical to a real one.
//
//   AN EMPTY RESULT IS NOT A CLEAN RESULT. Zero broken chains across zero ledgers is not
//   health; a subject with no upstream edge is unprovenanced, not self-evidently original.
//   Both are reported as gaps, in the same vocabulary the evidence pack uses.
import { foldProjection } from "./kel.mjs";

// Coverage vocabulary, kept identical to evidence.mjs so one reviewer reads one language.
export const ATTESTED = "attested";
export const QUARANTINED = "quarantined";
export const NOT_MEASURABLE = "not measurable";

const parse = (t) => {
  const n = Date.parse(t);
  return Number.isNaN(n) ? null : n;
};

// Events order by transaction time, then HLC — the same rule foldProjection uses, so a trail
// and its folded state can never disagree about what came first.
function byTime(a, b) {
  const d = (parse(a.txn_time) ?? 0) - (parse(b.txn_time) ?? 0);
  if (d !== 0) return d;
  return String(a.hlc || "") < String(b.hlc || "") ? -1 : String(a.hlc) > String(b.hlc) ? 1 : 0;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

// Upstream subjects this event declares. Nothing is inferred: if the writer did not record
// where a thing came from, this returns nothing and the subject is counted unprovenanced.
export function declaredParents(evt) {
  const p = evt?.payload || {};
  return [...asArray(p.derived_from), ...asArray(p.caused_by)]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
}

// --- the fold: every verified ledger, indexed by subject -------------------------------
//
// `ledgers` is the shape collectLedgers() returns: { name, file, ok, badLine, events }.
export function buildLineage(ledgers = []) {
  const subjects = new Map();

  const touch = (sid) => {
    if (!subjects.has(sid))
      subjects.set(sid, {
        sid,
        kind: "unknown",
        events: [],
        ledgers: new Set(),
        machines: new Set(),
        authorship: { human: 0, frontier: 0, house: 0 },
        parents: new Set(),
        children: new Set(),
        quarantined: false
      });
    return subjects.get(sid);
  };

  for (const l of ledgers) {
    for (const evt of l.events || []) {
      const sid = String(evt?.subject?.id || evt?.sid || "").trim();
      if (!sid) continue; // an event with no subject cannot be placed in any lineage
      const s = touch(sid);
      s.events.push({ ...evt, _ledger: l.name });
      s.ledgers.add(l.name);
      if (evt.machine) s.machines.add(evt.machine);
      if (evt.subject?.kind) s.kind = evt.subject.kind;
      // R38: authorship is exactly human | frontier | house. Anything else is a writer bug,
      // so it is left uncounted rather than quietly folded into one of the three.
      if (Object.prototype.hasOwnProperty.call(s.authorship, evt.authorship))
        s.authorship[evt.authorship] += 1;
      // A ledger that does not verify contaminates every subject it touches. The subject is
      // kept — hiding it would lose the fact that it exists — but it never counts as evidence.
      if (!l.ok) s.quarantined = true;
      for (const parent of declaredParents(evt)) {
        if (parent === sid) continue; // a subject is not its own provenance
        s.parents.add(parent);
      }
    }
  }

  // Second pass: children, and dangling parents (an edge pointing at a subject we hold no
  // events for). A dangling edge is a defect — it claims a provenance we cannot inspect.
  const dangling = [];
  for (const s of subjects.values()) {
    for (const parent of s.parents) {
      if (subjects.has(parent)) subjects.get(parent).children.add(s.sid);
      else dangling.push({ sid: s.sid, missing_parent: parent });
    }
  }

  for (const s of subjects.values()) {
    s.events.sort(byTime);
    s.first = s.events[0]?.txn_time ?? null;
    s.last = s.events.at(-1)?.txn_time ?? null;
  }

  return { subjects, dangling };
}

// --- coverage: what we can actually stand behind ---------------------------------------
export function lineageCoverage({ subjects, dangling }, ledgers = []) {
  const all = [...subjects.values()];
  const attested = all.filter((s) => !s.quarantined);
  const quarantined = all.filter((s) => s.quarantined);
  const broken = ledgers.filter((l) => !l.ok);

  // Unprovenanced = attested, but declaring no upstream at all. This is NOT the same as
  // "originated here": we simply do not know, and that difference is the whole point.
  const unprovenanced = attested.filter((s) => s.parents.size === 0);

  const kinds = {};
  for (const s of all) kinds[s.kind] = (kinds[s.kind] || 0) + 1;

  const authorship = { human: 0, frontier: 0, house: 0 };
  for (const s of attested)
    for (const k of Object.keys(authorship)) authorship[k] += s.authorship[k];

  return {
    ledgers: {
      total: ledgers.length,
      verified: ledgers.length - broken.length,
      broken: broken.length,
      broken_names: broken.map((l) => ({ name: l.name, badLine: l.badLine, reason: l.reason }))
    },
    subjects: { total: all.length, attested: attested.length, quarantined: quarantined.length },
    kinds,
    authorship,
    provenance: {
      // The share of attested subjects whose origin is recorded. With no writer yet emitting
      // derived_from/caused_by this is 0, and that zero is the most useful number here: it
      // says the estate has integrity but not yet genealogy.
      linked: attested.length - unprovenanced.length,
      unprovenanced: unprovenanced.length,
      dangling: dangling.length,
      ratio: attested.length ? (attested.length - unprovenanced.length) / attested.length : null
    },
    // Completeness against the world — how much of what EXISTS is in the ledger at all —
    // needs an external inventory to compare against. Nothing enumerates the estate's files,
    // tasks and installs today, so this is declared unmeasurable rather than assumed clean.
    completeness: {
      state: NOT_MEASURABLE,
      why: "no external inventory of estate objects exists to compare the ledger against; ledger-internal integrity is measured, ledger-to-world completeness is not"
    }
  };
}

// --- one subject's trail, with the projection after each step (time travel) -------------
//
// Step n shows what the system believed once event n had been recorded, computed by folding
// the prefix with the same projector the rest of the system uses. Re-deriving it here with a
// bespoke reducer would let the replay drift from the live state, which is the one thing a
// time-travel view must never do.
//
// That projector is LAST-WRITE-WINS per subject, not an accumulation — fold a signed proposal
// and you get {signer, note}, with the title from the earlier raised event gone. The field is
// therefore called `projection`, not `state`: calling it state would invite a reader to
// believe the earlier facts had been retracted, when they are merely not what this projector
// returns. The per-step `payload` below is the event's own record and is never lossy; domain
// readers that need accumulation (buildGovernance, buildArtifacts) do it themselves.
export function subjectTrail(index, sid, { converters = {} } = {}) {
  const s = index.subjects.get(sid);
  if (!s) return null;
  const steps = s.events.map((evt, i) => {
    const proj = foldProjection(s.events.slice(0, i + 1), { converters });
    const at = proj.get(sid);
    return {
      n: i + 1,
      id: evt.id,
      type: evt.type,
      ledger: evt._ledger,
      machine: evt.machine ?? null,
      authorship: evt.authorship ?? null,
      valid_time: evt.valid_time ?? null,
      txn_time: evt.txn_time ?? null,
      time_confidence: evt.time_confidence ?? null,
      payload: evt.payload ?? {},
      parents: declaredParents(evt),
      // what the system's own projector returns as of this step (last-write-wins, see above)
      projection: at ? at.payload : null
    };
  });
  return {
    sid,
    kind: s.kind,
    quarantined: s.quarantined,
    ledgers: [...s.ledgers],
    machines: [...s.machines],
    authorship: s.authorship,
    parents: [...s.parents],
    children: [...s.children],
    first: s.first,
    last: s.last,
    steps
  };
}

// Summary rows for the index view. Sorted most-recently-touched first: lineage is read when
// something has just happened, and the thing that just happened is what you came to look at.
export function lineageIndex({ subjects }) {
  return [...subjects.values()]
    .map((s) => ({
      sid: s.sid,
      kind: s.kind,
      events: s.events.length,
      ledgers: [...s.ledgers],
      machines: [...s.machines],
      authorship: s.authorship,
      parents: s.parents.size,
      children: s.children.size,
      quarantined: s.quarantined,
      first: s.first,
      last: s.last
    }))
    .sort((a, b) => String(b.last || "").localeCompare(String(a.last || "")));
}
