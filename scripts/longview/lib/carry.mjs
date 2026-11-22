// LONGVIEW V8 carry-forward ledger + "nothing lost" close check (EP-Y Y3, plan §5).
//
// cycles/CARRY.jsonl is append-only. Every line is one state change of one item:
//   open     — found in a cycle, not yet resolved
//   carried  — explicitly moved into a later cycle (`cycle` = the cycle it now belongs to)
//   done     — resolved; must name a `ref` (commit, edition, ticket)
//   dropped  — abandoned; must carry the owner's signature (`signed_by: "owner"` + `signed_quote`)
//              transcribed from chat — board scope, never a KEL signature
// An item's state is its LAST line. Nothing is ever rewritten.
//
// Closing cycle C<n> = set difference 0: every item still open/carried in C<n> must be
// done, dropped, or carried into C<n+1>. A close writes cycles/C<n>.closed.json (append-only);
// the cycle manifest itself is never edited.
import fs from "fs";
import path from "path";
import crypto from "crypto";

export const STATES = ["open", "carried", "done", "dropped"];
const ID_RE = /^C\d+-\d+$/;
const cycleNum = (c) => Number(/^C(\d+)$/.exec(c || "")?.[1] ?? NaN);

/** Validate one ledger entry. Returns a list of problems (empty = valid). */
export function entryProblems(e) {
  const p = [];
  if (!e || typeof e !== "object") return ["not an object"];
  if (!ID_RE.test(e.id || "")) p.push(`id must look like C<n>-<k>, got ${e.id}`);
  if (!STATES.includes(e.state)) p.push(`state must be one of ${STATES.join("|")}, got ${e.state}`);
  if (!Number.isFinite(cycleNum(e.cycle))) p.push(`cycle must look like C<n>, got ${e.cycle}`);
  if (!e.ts || Number.isNaN(Date.parse(e.ts))) p.push("ts missing or not a date");
  if (e.state === "done" && !String(e.ref || "").trim()) p.push("done needs a ref (commit, edition or ticket)");
  if (e.state === "dropped" && !(e.signed_by === "owner" && String(e.signed_quote || "").trim()))
    p.push("dropped needs the owner's signature (signed_by: owner + signed_quote)");
  return p;
}

/** Pure: fold ledger text into the latest state per id, plus every problem found. */
export function foldCarry(text) {
  const items = new Map();
  const problems = [];
  const lines = String(text || "").split(/\r?\n/);
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      problems.push({ line: i + 1, problem: "unreadable line (torn write?)" });
      return;
    }
    const ps = entryProblems(e);
    if (ps.length) {
      problems.push({ line: i + 1, id: e.id ?? null, problem: ps.join("; ") });
      return;
    }
    const prev = items.get(e.id);
    // `item`/`owner` text is set when the item is opened; later lines may omit it.
    if (prev && cycleNum(e.cycle) < cycleNum(prev.cycle))
      problems.push({ line: i + 1, id: e.id, problem: `moves back from ${prev.cycle} to ${e.cycle}` });
    items.set(e.id, { ...(prev || {}), ...e, first_cycle: prev?.first_cycle ?? e.cycle, history: (prev?.history || 0) + 1 });
  });
  return { items, problems };
}

export const readCarry = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** Append ONE validated line. Refuses unknown ids for non-open states and changes after done/dropped. */
export function appendCarry(file, entry, now = new Date()) {
  const e = { ts: now.toISOString(), ...entry };
  const ps = entryProblems(e);
  if (ps.length) throw new Error(`carry entry refused: ${ps.join("; ")}`);
  const { items } = foldCarry(readCarry(file));
  const prev = items.get(e.id);
  if (e.state === "open" && prev) throw new Error(`${e.id} already exists (state ${prev.state}); open is only for new items`);
  if (e.state !== "open" && !prev) throw new Error(`${e.id} is not in the ledger; open it first`);
  if (prev && (prev.state === "done" || prev.state === "dropped"))
    throw new Error(`${e.id} is already ${prev.state}; a resolved item is never reopened (open a new id)`);
  if (prev && cycleNum(e.cycle) < cycleNum(prev.cycle)) throw new Error(`${e.id} cannot move back from ${prev.cycle} to ${e.cycle}`);
  if (e.state === "open" && !String(e.item || "").trim()) throw new Error("open needs the item text");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Start on a fresh line even if the last write was torn.
  const text = readCarry(file);
  const lead = text && !text.endsWith("\n") ? "\n" : "";
  fs.appendFileSync(file, lead + JSON.stringify(e) + "\n");
  return e;
}

/**
 * Pure: the nothing-lost check for closing `cycle`.
 * Unaccounted = items whose latest state is open/carried AND whose cycle is <= `cycle`
 * (they belong to this cycle or an earlier one and were not moved forward).
 * Any ledger problem also blocks the close — a torn or invalid line could hide an item.
 */
export function closeCheck(text, cycle) {
  const n = cycleNum(cycle);
  if (!Number.isFinite(n)) throw new Error(`cycle must look like C<n>, got ${cycle}`);
  const { items, problems } = foldCarry(text);
  const tally = { open: 0, carried_forward: 0, done: 0, dropped: 0, later: 0 };
  const unaccounted = [];
  for (const it of items.values()) {
    const c = cycleNum(it.cycle);
    if (cycleNum(it.first_cycle) > n) {
      tally.later++;
      continue; // opened after this cycle: not this cycle's business
    }
    if (it.state === "done") tally.done++;
    else if (it.state === "dropped") tally.dropped++;
    else if (c > n) tally.carried_forward++;
    else {
      tally.open++;
      unaccounted.push(it.id);
    }
  }
  const ok = unaccounted.length === 0 && problems.length === 0;
  return { cycle, ok, unaccounted: unaccounted.sort(), problems, tally, items: items.size };
}

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** IO: run the close check and, if it passes, write cycles/C<n>.closed.json (never overwritten). */
export function closeCycle({ workspace, cycle, by, now = new Date() }) {
  const dir = path.join(workspace, "longview", "cycles");
  const manifestPath = path.join(dir, `${cycle}.json`);
  if (!fs.existsSync(manifestPath)) throw new Error(`${cycle}.json does not exist — nothing to close`);
  const closedPath = path.join(dir, `${cycle}.closed.json`);
  if (fs.existsSync(closedPath)) throw new Error(`${cycle} is already closed`);
  const carryFile = path.join(dir, "CARRY.jsonl");
  const text = readCarry(carryFile);
  const check = closeCheck(text, cycle);
  if (!check.ok) return { closed: false, check };
  const record = {
    schema: "longview.cycle-close/1",
    cycle,
    closed_at: now.toISOString(),
    closed_by: by || null,
    cycle_manifest_sha256: sha(fs.readFileSync(manifestPath)),
    carry_sha256: sha(Buffer.from(text, "utf8")),
    carry_items: check.items,
    tally: check.tally
  };
  fs.writeFileSync(closedPath, JSON.stringify(record, null, 2) + "\n", { flag: "wx" });
  return { closed: true, check, record, path: closedPath };
}
