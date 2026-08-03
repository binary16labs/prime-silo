// P0 — model rosters: declarative, fail-closed, and pure.
//
// The unit under test in a benchmark is a SUBJECT — a persona→model assignment plus serving
// topology — not a model. That single choice is what lets a heterogeneous roster (one model
// reviewing, another implementing) be ranked as one unit, and makes the incumbent just another
// subject rather than a special case.
//
// PURE by design: no fs, no process, no clock. Every rule below can be broken deterministically by
// a verifier, which is the only reason to trust that any of them are enforced.
//
// Contract: delivery/tasks/P0.md · Design: architecture/SOLUTION-model-plurality.md §4.1, §5.1
// Requirements: R4–R8 (declarative rosters), R10 (frozen rubric).

export const PERSONAS = ["planner", "architect", "implementer", "reviewer", "judge"];
export const WILDCARD = "*";

/**
 * FNV-1a over the rubric text. Small, dependency-free, and deterministic — enough to prove a rubric
 * was not edited after results were seen (R10), which is the only claim it needs to support.
 * Deliberately NOT presented as cryptographic: this detects drift, it does not resist an adversary.
 */
export function rubricHash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < (text ?? "").length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv1a:${h.toString(16).padStart(8, "0")}`;
}

/** Expand a subject's assignment into persona → model label, applying the "*" wildcard. */
export function resolveSubject(subject, personas = PERSONAS.filter((p) => p !== "judge")) {
  const assign = subject?.assign ?? {};
  const out = {};
  for (const persona of personas) out[persona] = assign[persona] ?? assign[WILDCARD] ?? null;
  return out;
}

/**
 * Validate a `model_roster/1` manifest. Returns every error rather than the first, so a roster is
 * fixed in one pass instead of one error at a time.
 *
 * @param roster the parsed manifest
 * @param opts.rubricText when given, its hash must equal roster.rubric_hash (R10)
 */
export function validateRoster(roster, opts = {}) {
  const errors = [];
  const push = (m) => errors.push(m);

  if (roster?.kind !== "model_roster") push(`kind must be "model_roster", got ${roster?.kind}`);
  const models = Array.isArray(roster?.models) ? roster.models : [];
  const subjects = Array.isArray(roster?.subjects) ? roster.subjects : [];
  if (models.length === 0) push("models[] is empty");
  if (subjects.length === 0) push("subjects[] is empty");

  const byLabel = new Map();
  for (const m of models) {
    if (!m?.label) push("a model has no label");
    else if (byLabel.has(m.label)) push(`duplicate model label '${m.label}'`);
    else byLabel.set(m.label, m);
    if (!m?.id) push(`model '${m?.label}' has no id`);
    const tier = Array.isArray(m?.tier) ? m.tier : [];
    if (tier.length === 0) push(`model '${m?.label}' declares no tier[]`);
    for (const t of tier) if (!PERSONAS.includes(t)) push(`model '${m.label}' has unknown tier '${t}'`);
  }

  // R8 — a model may not judge a run it is competing in. Checked on id, not label, because the same
  // weights under two labels is exactly how self-judging would slip through.
  const judgeId = roster?.judge?.model;
  if (judgeId && models.some((m) => m.id === judgeId))
    push(`judge model '${judgeId}' also appears under test — self-judging`);

  for (const s of subjects) {
    if (!s?.label) push("a subject has no label");
    const assign = s?.assign ?? {};
    if (Object.keys(assign).length === 0) push(`subject '${s?.label}' assigns nothing`);
    for (const [persona, label] of Object.entries(assign)) {
      if (persona !== WILDCARD && !PERSONAS.includes(persona))
        push(`subject '${s.label}' assigns unknown persona '${persona}'`);
      if (!byLabel.has(label)) {
        push(`subject '${s.label}' assigns unknown model '${label}'`);
        continue;
      }
      // R5 — a model is only eligible for the personas its tier[] declares. The wildcard must
      // satisfy every persona it will actually be expanded to, or it is a hole in the rule.
      const tier = byLabel.get(label).tier ?? [];
      const targets =
        persona === WILDCARD ? PERSONAS.filter((p) => p !== "judge") : [persona];
      for (const t of targets)
        if (!tier.includes(t))
          push(`subject '${s.label}': model '${label}' is not tiered for '${t}'`);
    }
    // Every non-judge persona must end up assigned; a hole would silently fall back to the
    // registry default and the subject would no longer be the thing that was declared.
    const resolved = resolveSubject(s);
    for (const [persona, label] of Object.entries(resolved))
      if (label === null) push(`subject '${s.label}' leaves '${persona}' unassigned`);
  }

  if (roster?.primary_metric == null) push("primary_metric is not declared — ranking would be ad hoc");

  // R10 — the rubric is frozen before the run; a mismatch invalidates the results.
  if (opts.rubricText != null) {
    const actual = rubricHash(opts.rubricText);
    if (roster?.rubric_hash !== actual)
      push(`rubric_hash mismatch: manifest ${roster?.rubric_hash}, actual ${actual}`);
  }

  return { ok: errors.length === 0, errors };
}
