// T2 train / held-out split. Deterministic and disjoint by construction: a row's
// assignment is a pure function of its id (stable hash), so the held-out set is
// reproducible and a row can never land in both splits. Carved BEFORE any training
// (the contract's "reserve a held-out eval set" scenario).
const EVAL_PCT = Number(process.env.T2_EVAL_PCT) || 15;

// FNV-1a 32-bit — small, dependency-free, stable across runs/machines.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

export function splitRows(rows, { evalPct = EVAL_PCT } = {}) {
  const train = [];
  const evalSet = [];
  for (const row of rows) (hash32(row.id) % 100 < evalPct ? evalSet : train).push(row);
  return { train, eval: evalSet, evalPct };
}
