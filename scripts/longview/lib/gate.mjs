// Deterministic card gate (ADR-005 §4). Card acceptance is checkable without a
// judge: schema + bounds + grounding. Errors are returned so a single retry can
// quote them back to the model.
const STRING_LISTS = [
  "applications",
  "capabilities",
  "decisions",
  "outcomes",
  "failures",
  "skills_observed",
  "operator_traits",
  "open_threads",
  "proposed_next",
  "evidence"
];

export function validateCard(card, { sessionId, agent }) {
  const errors = [];
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return ["not a JSON object"];
  }
  if (typeof card.project !== "string" || !card.project.trim()) {
    errors.push("project: non-empty string required");
  }
  if (typeof card.intent !== "string" || card.intent.trim().length < 20) {
    errors.push("intent: string of at least 20 chars required");
  }
  if (typeof card.period !== "string" || !/^\d{4}-\d{2}/.test(card.period)) {
    errors.push("period: 'YYYY-MM' string required");
  }
  for (const key of STRING_LISTS) {
    const v = card[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
      errors.push(`${key}: array of strings required`);
    }
  }
  if (Array.isArray(card.applications) && card.applications.length === 0) {
    errors.push("applications: at least one entry required (use the project name if nothing else)");
  }
  if (Array.isArray(card.evidence) && card.evidence.length === 0) {
    errors.push("evidence: cite at least one artifact/input from the pack");
  }
  const size = JSON.stringify(card).length;
  if (size > 8000) errors.push(`card too large (${size} chars > 8000)`);

  if (errors.length === 0) {
    // Stamp identity server-side — never trust the model with keys.
    card.session_id = sessionId;
    card.agent = agent;
  }
  return errors;
}
