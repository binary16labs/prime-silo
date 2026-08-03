// W1 — the deterministic selector. PURE: no clock, no randomness, no I/O.
//
// `now` and every piece of state are injected, because the moment this module reads the clock the
// same inputs stop yielding the same answer and scenario 1 becomes untestable. The gate greps this
// file for Date.now()/Math.random and fails if either appears — keep it that way.
//
// Decisions D1-D4: architecture/SOLUTION-W1-work-next.md section 9.
// Contract: delivery/tasks/W1.md

/** Reasons `work next` can decline, so callers never have to guess from a null. */
export const NO_ITEM = {
  WIP_LIMIT: "wip-limit", // D4 — this agent already holds a live lease
  NONE_READY: "none-ready" // deps unmet, leased elsewhere, awaiting signature, or conflicted
};

const isLive = (lease, now) => Boolean(lease) && Date.parse(lease.expires_at) > now;

/** Topological depth: 0 for a root, else 1 + the deepest dependency. Cycles yield Infinity. */
function depths(contracts) {
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const memo = new Map();
  const walk = (id, seen) => {
    if (memo.has(id)) return memo.get(id);
    if (seen.has(id)) return Infinity; // cycle — w0 rejects these, but never rank on a hang
    const deps = byId.get(id)?.deps ?? [];
    seen.add(id);
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((x) => walk(x, seen)));
    seen.delete(id);
    memo.set(id, d);
    return d;
  };
  for (const c of contracts) walk(c.id, new Set());
  return memo;
}

/**
 * Choose the next item.
 *
 * @param contracts  [{ id, deps, authority }]
 * @param opts.ledger  id -> { state, agent }   authoritative for STATE (D2)
 * @param opts.board   id -> column name        authoritative for PRIORITY only (D2)
 * @param opts.priority ordered ids (board READY order — the only human-edited ordering)
 * @param opts.leases  id -> { agent, expires_at }
 * @param opts.agent   who is asking
 * @param opts.now     epoch ms, INJECTED
 */
export function selectNext(contracts, opts) {
  const { ledger = {}, board = {}, priority = [], leases = {}, agent, now } = opts;
  const conflicts = [];
  const awaitingSignature = [];

  // D4 — one live lease per agent, or the WIP limit is decorative.
  for (const [id, lease] of Object.entries(leases)) {
    if (lease.agent === agent && isLive(lease, now))
      return { item: null, reason: NO_ITEM.WIP_LIMIT, holding: id, conflicts, awaitingSignature };
  }

  const done = (id) => ledger[id]?.state === "done" || ledger[id]?.state === "verified";
  const ready = [];

  for (const c of contracts) {
    // D2 — the board and the ledger disagreeing is a fact to surface, never to resolve silently.
    const boardDone = board[c.id] === "DONE";
    if (boardDone !== done(c.id) && board[c.id] !== undefined) {
      conflicts.push({ id: c.id, board: board[c.id], ledger: ledger[c.id]?.state ?? "absent" });
      continue; // skipped, not guessed at
    }
    if (done(c.id) || ledger[c.id]?.state === "claimed") continue;
    if (!(c.deps ?? []).every(done)) continue;
    if (isLive(leases[c.id], now)) continue;
    // D1 — a human-signed item is never auto-claimed; it is reported, not selected.
    if (c.authority === "human-signed") {
      awaitingSignature.push(c.id);
      continue;
    }
    ready.push(c);
  }

  const depth = depths(contracts);
  const rank = (id) => (priority.indexOf(id) === -1 ? Number.MAX_SAFE_INTEGER : priority.indexOf(id));
  // Total order: topological, then human priority, then id. The third key is what makes this a
  // function rather than a coin toss between two items that tie on the first two.
  ready.sort(
    (a, b) =>
      depth.get(a.id) - depth.get(b.id) || rank(a.id) - rank(b.id) || (a.id < b.id ? -1 : 1)
  );

  return {
    item: ready[0]?.id ?? null,
    reason: ready.length ? null : NO_ITEM.NONE_READY,
    candidates: ready.map((c) => c.id),
    conflicts,
    awaitingSignature
  };
}

/** The agent on the most recent task_claimed for a task — the author, for D3's identity check. */
export function authorOf(events, taskId) {
  let author = null;
  for (const e of events) if (e.task_id === taskId && e.type === "task_claimed") author = e.agent;
  return author;
}
