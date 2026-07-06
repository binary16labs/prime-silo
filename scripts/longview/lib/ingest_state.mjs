// A8 — ingest resilience helpers (2026-07-06 swap-thrash incident).
// Pure functions so they are unit-testable without a live server.

import path from "node:path";

/**
 * A server ingest task is "stalled" when its own record has not advanced for
 * `stallMs`. This is the task-level analogue of the compute-aware watchdog:
 * a 4-hour batch timeout is legitimate for deep synthesis (clustering is
 * amortized per batch), but a task whose think-log stops moving for half an
 * hour is not working — fail fast and honestly instead of burning the rest
 * of the window. Returns false when the task carries no usable timestamp
 * (never misclassify for lack of evidence).
 */
export function taskStalled(task, nowMs, stallMs) {
  if (!task || !stallMs) return false;
  const stamp = task.updated_at || task.updatedAt || null;
  if (!stamp) return false;
  const t = Date.parse(stamp);
  if (Number.isNaN(t)) return false;
  return nowMs - t > stallMs;
}

/**
 * A stalled verdict means the SERVER still holds a hung synthesis task in
 * unknown state. Firing the next batch at it stacks a second task on a sick
 * server (the 2026-07-02 embedder-overload failure). The phase must stop.
 */
export function isStallVerdict(verdict) {
  return Boolean(verdict && !verdict.ok && /^stalled:/.test(String(verdict.error || "")));
}

/**
 * After a failed deep-synthesis batch, reconcile which files ACTUALLY made it:
 * the server writes `<workspace>/.benny/wiki/<name>.md` per synthesized doc,
 * so wiki presence is ground truth. Marks those files in `ingestedSet` and
 * returns the recovered names. Without this, a batch of 40 that died at file
 * 39 re-ingested all 40 on retry (observed live: two 4-hour cycles re-chewing
 * the same first batch).
 */
export function reconcileIngested(batch, wikiDir, fsImpl, ingestedSet) {
  const recovered = [];
  for (const name of batch) {
    if (ingestedSet.has(name)) continue;
    try {
      if (fsImpl.existsSync(path.join(wikiDir, name))) {
        ingestedSet.add(name);
        recovered.push(name);
      }
    } catch {
      /* unreadable — treat as not ingested */
    }
  }
  return recovered;
}
