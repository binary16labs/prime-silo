// Model-collapse guard (L11 / EP-L) — verifier gate + house-fraction cap. Pure; no I/O.
// Design: SOLUTION §4.6 (R38 guard) + §8 (dogfood doctrine). The loop trains on VALIDATED METHOD,
// never raw self-output: a house-authored session becomes a training row only after a verifier pass
// (frozen rubric or recorded frontier sign-off), and house-origin rows are fraction-capped per turn.
// Without both, sessions→train→model→sessions drifts into distillation-of-self and collapses.
// Human/frontier rows are NEVER capped — only house-origin is bounded. Extends R24/R25; R38.
import crypto from "node:crypto";

export const HOUSE = "house";

const defAuthorship = (r) => r.authorship ?? r.source?.authorship ?? "human";
const defSid = (r) => r.source?.sid ?? r.sid;

// --- verifier gate: unverified house output never becomes a training row -----
// A row is admitted unless it is house-origin AND its session has no recorded verifier pass.
// (human/frontier rows are always admitted here — this guard is contamination-only.)
export function verifierGate(
  rows,
  { verifiedSids = new Set(), authorshipOf = defAuthorship, sidOf = defSid } = {}
) {
  const kept = [];
  const excluded = [];
  for (const r of rows) {
    if (authorshipOf(r) === HOUSE && !verifiedSids.has(sidOf(r))) excluded.push(r);
    else kept.push(r);
  }
  return { kept, excluded };
}

// --- deterministic down-sample (rebuildable) --------------------------------
// Selection is a pure function of the rows: rank by sha256(id) and keep the lowest `n`. No RNG, so
// delete+rebuild is byte-identical (the register-rebuild discipline, applied to dataset assembly).
function deterministicSample(rows, n, idOf) {
  return [...rows]
    .map((r) => ({
      r,
      k: crypto
        .createHash("sha256")
        .update(String(idOf(r)))
        .digest("hex")
    }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
    .slice(0, n)
    .map((x) => x.r);
}

// --- house-fraction cap: bound house-origin rows per turn --------------------
// `maxHouseRows` = an absolute per-turn ceiling; `capFraction` = house may be at most that fraction of
// the FINAL total (human/frontier fill the rest, uncapped). With neither, this is a pass-through.
export function applyAuthorshipCap(
  rows,
  { maxHouseRows, capFraction, authorshipOf = defAuthorship, idOf = (r) => r.id } = {}
) {
  const house = rows.filter((r) => authorshipOf(r) === HOUSE);
  const other = rows.filter((r) => authorshipOf(r) !== HOUSE);

  let cap;
  if (maxHouseRows != null) cap = maxHouseRows;
  else if (capFraction != null)
    // house ≤ f·total, total = house + other ⇒ house ≤ f·other/(1−f)
    cap =
      capFraction >= 1
        ? house.length
        : Math.floor((capFraction * other.length) / (1 - capFraction));
  else return { kept: rows, capped: 0 };

  if (house.length <= cap) return { kept: rows, capped: 0 };
  const sampled = deterministicSample(house, cap, idOf);
  return { kept: [...other, ...sampled], capped: house.length - cap };
}

// --- combined guard: gate THEN cap ------------------------------------------
export function guardHouseRows(rows, opts = {}) {
  const g = verifierGate(rows, opts);
  const c = applyAuthorshipCap(g.kept, opts);
  return { kept: c.kept, excluded_unverified: g.excluded.length, capped: c.capped };
}
