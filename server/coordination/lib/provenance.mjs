// Provenance (SS1/23) — the one place an event may say where it came from.
// Spec: architecture/SPEC-knowledge-eventlog.md · lineage.mjs reads exactly what this writes.
//
// The lineage fold builds edges from two payload fields and nothing else: `derived_from`
// (the inputs a subject was made from) and `caused_by` (the decision or event that brought
// it about). Because those two fields are the entire genealogy of the estate, they are
// constructed here and validated here, rather than spelled out by each writer — the same
// reason proposalSignedEvent hard-codes authorship. A field that every module formats for
// itself drifts, and a drifted edge is silently unresolvable.
//
// Three rules, each of which exists because the alternative reads as evidence:
//
//   AN EDGE MUST BE A SUBJECT ID, NEVER PROSE. "because the collector was manual" is a
//   reason, not a reference. Written into derived_from it becomes an edge that can never
//   resolve, and the lineage view reports it as a dangling parent forever — a permanent
//   defect no instrumentation can clear. Reasons belong in `rationale` or `note`.
//
//   NOTHING IS ITS OWN ANCESTOR. A self-edge would make a subject look provenanced while
//   saying nothing at all, which is worse than an honest blank.
//
//   ABSENT IS NOT EMPTY. When a writer records no provenance the keys are OMITTED, not
//   written as `[]` or `null`. An empty array asserts "derived from nothing" — a positive
//   claim of originality. Leaving the key out says only "not recorded", which is the truth,
//   and it is what lets lineage.mjs separate `unprovenanced` from `linked` honestly.
//
// The asymmetry is deliberate: `derived_from` is a list (a thing may be made from many),
// `caused_by` is single (one decision brought it about). Anything else invites a caller to
// record a set of maybe-causes, which is a guess wearing a fact's clothes.

// A subject id looks like `<kind>:<rest>` — proposal:collector-schedule,
// artifact:sha256:d061…, service:t480:neo4j. The kind is lowercase and the whole thing
// carries no whitespace, which is what separates an id from a sentence.
const SUBJECT_ID = /^[a-z][a-z0-9_-]*:\S+$/;

export function isSubjectId(v) {
  return typeof v === "string" && SUBJECT_ID.test(v.trim());
}

function requireSubjectId(v, field) {
  const s = String(v ?? "").trim();
  if (!s) throw new Error(`provenance: ${field} must not be empty`);
  if (!isSubjectId(s))
    throw new Error(
      `provenance: ${field} must be a subject id like 'proposal:x' or 'artifact:sha256:…', got ${JSON.stringify(v)} — a reason is not a reference; put it in rationale or note`
    );
  return s;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

// Build the provenance fragment for a payload. Returns {} when nothing was recorded, so a
// caller can always spread it without deciding whether the keys should be there.
export function provenance({ derivedFrom = [], causedBy = null, subject = null } = {}) {
  const self = subject == null ? null : String(subject).trim();
  const out = {};

  const parents = [];
  for (const raw of asArray(derivedFrom)) {
    const sid = requireSubjectId(raw, "derived_from[]");
    if (self && sid === self) throw new Error(`provenance: ${sid} cannot be derived from itself`);
    if (!parents.includes(sid)) parents.push(sid); // de-duplicated, order preserved
  }
  if (parents.length) out.derived_from = parents;

  if (causedBy != null && String(causedBy).trim() !== "") {
    const sid = requireSubjectId(causedBy, "caused_by");
    if (self && sid === self) throw new Error(`provenance: ${sid} cannot cause itself`);
    out.caused_by = sid;
  }

  return out;
}

// Merge provenance into a payload. Refuses to overwrite: if a builder has already put
// provenance on the payload, a second, different one is a bug in the caller, not something
// to silently resolve by preferring one of them.
export function withProvenance(payload = {}, prov = {}) {
  for (const key of ["derived_from", "caused_by"]) {
    if (key in prov && key in payload && JSON.stringify(payload[key]) !== JSON.stringify(prov[key]))
      throw new Error(`provenance: refusing to overwrite existing ${key} on this payload`);
  }
  return { ...payload, ...prov };
}
