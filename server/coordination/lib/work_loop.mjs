// W1 — the delivery loop. This is the impure half: it reads the board and the ledger, and it
// acquires leases. The ordering decision lives in work_select.mjs and stays pure.
//
// `work next` = selectNext + claim-and-skip. Selection alone cannot separate two concurrent agents
// (identical state must yield an identical answer, or scenario 1 fails), so the ATOMIC LEASE is the
// arbiter — reached through B2's client rather than reimplemented here.
//
// Contract: delivery/tasks/W1.md · Decisions: architecture/SOLUTION-W1-work-next.md section 9
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseFrontmatter } from "../work-schema/validate.mjs";
import { foldState, readEvents } from "./ledger.mjs";
import { NO_ITEM, authorOf, selectNext } from "./work_select.mjs";
import * as coord from "../../../runtime/benny/agentamp/coord_client.mjs";

/** Every contract in delivery/tasks/, sorted — never trust readdir order (determinism hazard). */
export function loadContracts(repoRoot) {
  const dir = path.join(repoRoot, "delivery", "tasks");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "_TEMPLATE.md")
    .sort()
    .map((f) => {
      const fm = parseFrontmatter(fs.readFileSync(path.join(dir, f), "utf8")) ?? {};
      return {
        id: f.replace(/\.md$/, ""),
        deps: Array.isArray(fm.deps) ? fm.deps : [],
        authority: fm.authority,
        verify: fm.verify
      };
    });
}

/** BOARD.md -> { board: id->column, priority: ids in READY order }. Priority is human-edited (D2). */
export function readBoard(repoRoot) {
  const text = fs.readFileSync(path.join(repoRoot, "delivery", "board", "BOARD.md"), "utf8");
  const board = {};
  const priority = [];
  let column = "";
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^## (\w+)/);
    if (head) {
      column = head[1];
      continue;
    }
    const item = line.match(/^- ([A-Z]\d+|M2-\d+)\b/);
    if (!column || !item) continue;
    board[item[1]] = column;
    if (column === "READY") priority.push(item[1]);
  }
  return { board, priority };
}

export function readLeases(coordDir) {
  const dir = path.join(coordDir, "leases");
  if (!fs.existsSync(dir)) return {};
  const leases = {};
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    try {
      leases[f.replace(/\.json$/, "")] = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    } catch {
      /* mid-write; treat as absent rather than crash the selector */
    }
  }
  return leases;
}

/** Everything selectNext needs, gathered from disk. `now` is injected so callers can pin it. */
export function gather(ctx, repoRoot, { now = Date.now() } = {}) {
  const { events } = readEvents(ctx.coordDir);
  const ledger = Object.fromEntries(foldState(events));
  const { board, priority } = readBoard(repoRoot);
  return { contracts: loadContracts(repoRoot), ledger, board, priority, leases: readLeases(ctx.coordDir), now };
}

/**
 * Return the ONE item this agent now holds, or null with a reason.
 * Walks selectNext's ordered candidates; `already-claimed` means another agent won that one.
 */
export async function workNext(ctx, agent, repoRoot, { now = Date.now() } = {}) {
  const state = gather(ctx, repoRoot, { now });
  const sel = selectNext(state.contracts, { ...state, agent });
  if (!sel.item) return sel;

  for (const id of sel.candidates) {
    const got = await coord.claim(ctx, id, agent);
    if (got.ok) return { ...sel, item: id, claimed: true, takeover: got.takeover };
    // lost the race for this one — try the next candidate rather than failing the whole call
  }
  return { ...sel, item: null, reason: NO_ITEM.NONE_READY, claimed: false };
}

/** D3 — a verifier may not be the author. Enforced against a validated ledger fact, not a payload. */
export async function recordVerified(ctx, taskId, verifier, payload = {}) {
  const { events } = readEvents(ctx.coordDir);
  const author = authorOf(events, taskId);
  if (author === null) return { ok: false, reason: "never-claimed" };
  if (author === verifier) return { ok: false, reason: "author-is-verifier", author };
  const event = await coord.append(ctx, {
    type: "task_verified",
    agent: verifier,
    task_id: taskId,
    payload: { ...payload, author }
  });
  return { ok: true, author, verifier, event };
}

export async function workBlocked(ctx, taskId, agent, reason) {
  const event = await coord.append(ctx, {
    type: "task_blocked",
    agent,
    task_id: taskId,
    payload: { reason }
  });
  return { ok: true, event };
}

/** Run the contract's own `verify` command. Its exit code is the verdict; we do not interpret it. */
export function workVerify(repoRoot, taskId) {
  const contract = loadContracts(repoRoot).find((c) => c.id === taskId);
  if (!contract?.verify) return { ok: false, reason: "no-verify-command" };
  const [cmd, ...args] = contract.verify.split(/\s+/);
  const r = spawnSync(cmd, args, { cwd: repoRoot, stdio: "inherit", shell: true });
  return { ok: r.status === 0, exitCode: r.status, command: contract.verify };
}

// --- process entry point: how work.py drives this without forking the protocol
export async function main(argv) {
  const [verb, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
  const repoRoot = flags.repo ?? process.cwd();
  const agent = flags.agent ?? "claude";
  if (verb === "verify") return workVerify(repoRoot, flags.task);
  const ctx = await coord.connect({ coordDir: flags.dir, baseUrl: flags.api, mode: flags.mode });
  if (verb === "next") return workNext(ctx, agent, repoRoot);
  if (verb === "verified") return recordVerified(ctx, flags.task, agent);
  if (verb === "blocked") return workBlocked(ctx, flags.task, agent, flags.reason);
  throw new Error(`unknown work verb '${verb}' (expected next|verify|verified|blocked)`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  main(process.argv.slice(2))
    .then((r) => {
      process.stdout.write(JSON.stringify(r) + "\n");
      process.exit(r.ok === false ? 1 : 0);
    })
    .catch((e) => {
      process.stdout.write(JSON.stringify({ ok: false, error: String(e.message ?? e) }) + "\n");
      process.exit(1);
    });
}
