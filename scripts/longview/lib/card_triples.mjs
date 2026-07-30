// longview_v2 — deterministic card → knowledge-graph triples.
//
// The map phase already ran one LLM pass per card to distil the raw session into
// a structured card (concepts[], applications[], capabilities[], …). deep_synthesis
// then ran a SECOND, slower LLM pass to re-derive entities from the card's prose.
// That second pass is pure redundancy: every entity it looks for is already an
// array on the card. This module turns a card into the exact KnowledgeTriple shape
// `save_knowledge_triples` persists — deterministically, in ~0ms, no model call.
//
// Topology (what the user asked for: "cards at the centre, nodes and layers coming
// off with concept connections"):
//   (:Project)  ── INVOLVES ──▶      (:Concept)      one per card concept
//               ── USES ──────▶      (:Tool)         applications
//               ── DEMONSTRATES ─▶   (:Capability)   capabilities
//               ── APPLIES ───▶      (:Skill)        skills_observed
//   (anchor concept) ── CO_OCCURS_WITH ──▶ (other concepts)   intra-card web (star, O(n))
// The Source node (the card) + SOURCED_FROM edges are added server-side by
// save_knowledge_triples, so each card is also a hub in the provenance view.
// enrich() later merges duplicate Concepts across cards into shared hubs — that is
// what turns per-card stars into the cross-session graph.

const MODEL_ID = "longview-v2-structured";
const STRATEGY = "structured-fragment";

// Sentence-shaped fields are deliberately NOT turned into nodes: they are long and
// near-unique, so they would shatter the graph into thousands of dead-end nodes.
// They stay in the card markdown (vectors) for retrieval instead.

function clean(x) {
  return String(x == null ? "" : x)
    .replace(/\s+/g, " ")
    .trim();
}

// A node label must be a discrete entity, not a sentence. Reject empties, overlong
// strings, and anything that reads like a sentence (keeps the concept graph tight).
function isEntity(s) {
  const v = clean(s);
  if (v.length < 2 || v.length > 80) return false;
  if (/[.!?]$/.test(v)) return false; // trailing punctuation ⇒ sentence
  if (v.split(/\s+/).length > 8) return false; // too many words ⇒ phrase, not entity
  return true;
}

function dedupeEntities(arr, cap) {
  const seen = new Map(); // lowercase → first-seen original casing
  for (const raw of arr || []) {
    const v = clean(raw);
    if (!isEntity(v)) continue;
    const k = v.toLowerCase();
    if (!seen.has(k)) seen.set(k, v);
    if (seen.size >= cap) break;
  }
  return [...seen.values()];
}

// Build the deterministic triple set for one assembled card.
// Returns { triples, stats } — stats feeds the transparency/ETA layer.
export function buildCardTriples(card, { sid } = {}) {
  const project = clean(card.project) || "unknown";
  const cite = (field) => `card ${sid || card.session_id || "?"} · ${field}`;

  const concepts = dedupeEntities(card.concepts, 12);
  // applications include the project name itself in the assembled card — drop it so
  // the project hub does not USES→itself.
  const apps = dedupeEntities(card.applications, 8).filter(
    (a) => a.toLowerCase() !== project.toLowerCase()
  );
  const caps = dedupeEntities(card.capabilities, 8);
  const skills = dedupeEntities(card.skills_observed, 8);

  const triples = [];
  const push = (subject, subject_type, predicate, object, object_type, field) => {
    if (!subject || !object || subject.toLowerCase() === object.toLowerCase()) return;
    triples.push({
      subject,
      subject_type,
      predicate,
      object,
      object_type,
      citation: cite(field),
      confidence: 1.0,
      model_id: MODEL_ID,
      strategy: STRATEGY,
      source_type: "document"
    });
  };

  // Project hub → discrete entities (the radiating spokes).
  for (const c of concepts) push(project, "Project", "INVOLVES", c, "Concept", "concepts");
  for (const a of apps) push(project, "Project", "USES", a, "Tool", "applications");
  for (const cap of caps)
    push(project, "Project", "DEMONSTRATES", cap, "Capability", "capabilities");
  for (const s of skills) push(project, "Project", "APPLIES", s, "Skill", "skills_observed");

  // Intra-card concept web: star from the anchor (first, most-salient) concept.
  // O(n) not O(n²) — keeps edge count linear while still giving "concept connections".
  if (concepts.length > 1) {
    const anchor = concepts[0];
    for (const c of concepts.slice(1)) {
      push(anchor, "Concept", "CO_OCCURS_WITH", c, "Concept", "concepts");
    }
  }

  // Dedupe by the same normalized key save_knowledge_triples uses.
  const seen = new Set();
  const unique = [];
  for (const t of triples) {
    const k = `${t.subject.toLowerCase()}|${t.predicate.toLowerCase()}|${t.object.toLowerCase()}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(t);
  }

  const nodes = new Set([project.toLowerCase()]);
  for (const t of unique) {
    nodes.add(t.subject.toLowerCase());
    nodes.add(t.object.toLowerCase());
  }

  return {
    triples: unique,
    stats: {
      project,
      concepts: concepts.length,
      nodes: nodes.size,
      edges: unique.length,
      empty: concepts.length === 0 && apps.length === 0 && caps.length === 0 && skills.length === 0
    }
  };
}

export default buildCardTriples;
