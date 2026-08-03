// B2 — the ONE coordination client every agent surface speaks through.
//
// Both surfaces (the `benny coord` CLI via coord.py, and the prime-silo-nexus MCP tools) are thin
// clients of the B1 HTTP API when the server is up, and fall back to direct-file access through the
// same B0 validator lib when it is not. Nothing here reimplements the protocol.
//
// Claiming: B1 exposes no claim route (its routes are /tasks, /tasks/:id/events, /events,
// /knowledge, /stream), and the only mutual-exclusion primitive is the atomic wx lease file in
// lib/ledger.mjs. So a claim ALWAYS takes the lease locally — identical in both modes — and then
// appends task_claimed through the server when it is up, so the server stays the single appender
// and the bus still broadcasts. ledger.mjs exposes only claimTask(), which does lease+append
// together, so the lease half is restated here; that duplication is deliberate and is debt to
// retire in G2 by exporting a lease-only primitive from B0.
//
// Contract: delivery/tasks/B2.md · Design: architecture/SPEC-coordination-ledger.md
import fs from "node:fs";
import path from "node:path";
import {
  appendEvent as appendEventDirect,
  foldState,
  initCoordination,
  readEvents,
  ulid
} from "../../../server/coordination/lib/ledger.mjs";

const DEFAULT_TTL_MS = 15 * 60_000;
const PROBE_MS = 750;

export function defaultCoordDir() {
  const home = process.env.PRIME_SILO_HOME || process.env.BENNY_HOME;
  if (!home) throw new Error("set PRIME_SILO_HOME (or BENNY_HOME) to locate coordination/");
  return path.join(home, "coordination");
}

export function defaultBaseUrl() {
  return process.env.PRIME_SILO_API || "http://127.0.0.1:3000";
}

async function serverUp(baseUrl) {
  try {
    const r = await fetch(`${baseUrl}/api/coord/tasks`, {
      signal: AbortSignal.timeout(PROBE_MS)
    });
    return r.ok;
  } catch {
    return false; // unreachable, refused, or too slow — the file path is the honest answer
  }
}

/** Resolve a context: where the ledger is, and whether we are talking to the server or the disk. */
export async function connect({ coordDir, baseUrl, mode } = {}) {
  const dir = coordDir ?? defaultCoordDir();
  const url = baseUrl ?? defaultBaseUrl();
  initCoordination(dir); // idempotent; guarantees leases/ + agents.json exist in file mode
  return { coordDir: dir, baseUrl: url, mode: mode ?? ((await serverUp(url)) ? "server" : "file") };
}

// --- lease: the mutual-exclusion primitive, identical in both modes ---------
const leasePath = (dir, taskId) => path.join(dir, "leases", `${taskId}.json`);

function writeLease(p, taskId, agent, ttlMs) {
  const lease = {
    task_id: taskId,
    agent,
    claimed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  };
  fs.writeFileSync(p, JSON.stringify(lease, null, 2), { flag: "wx" }); // wx = atomic create-exclusive
}

export function acquireLease(dir, taskId, agent, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const p = leasePath(dir, taskId);
  try {
    writeLease(p, taskId, agent, ttlMs);
    return { ok: true, takeover: false };
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let lease = null;
    try {
      lease = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch {
      /* holder is mid-write, or the file vanished under us */
    }
    if (lease && Date.parse(lease.expires_at) > Date.now())
      return { ok: false, reason: "already-claimed" };
    try {
      fs.unlinkSync(p); // the lease is stale — reclaim it
    } catch {
      /* another claimant removed it first */
    }
    try {
      writeLease(p, taskId, agent, ttlMs);
    } catch (e2) {
      if (e2.code !== "EEXIST") throw e2;
      return { ok: false, reason: "already-claimed" }; // lost the reclaim race
    }
    return { ok: true, takeover: true };
  }
}

export function releaseLease(dir, taskId, agent) {
  const p = leasePath(dir, taskId);
  if (!fs.existsSync(p)) return { ok: true };
  try {
    if (JSON.parse(fs.readFileSync(p, "utf8")).agent !== agent)
      return { ok: false, reason: "not-owner" };
  } catch {
    /* unreadable lease — treat as abandoned */
  }
  fs.unlinkSync(p);
  return { ok: true };
}

// --- append: server when it is up, disk when it is not ---------------------
// Exported for W1's delivery loop, which appends task_verified — a type this module has no verb
// for. Additive: no behaviour change, no existing caller affected.
export async function append(ctx, partial) {
  const evt = { id: ulid(), ts: new Date().toISOString(), payload: {}, ...partial };
  if (ctx.mode === "server") {
    const r = await fetch(`${ctx.baseUrl}/api/coord/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(evt)
    });
    const body = await r.json().catch(() => ({}));
    if (r.status !== 201) throw new Error(body.error ?? `coordination API refused: ${r.status}`);
    return body.event; // the server set `prev` and broadcast it
  }
  return JSON.parse(appendEventDirect(ctx.coordDir, evt)); // same validator, same append lock
}

// --- verbs -----------------------------------------------------------------
export async function list(ctx) {
  if (ctx.mode === "server") {
    try {
      const r = await fetch(`${ctx.baseUrl}/api/coord/tasks`);
      if (r.ok) return r.json();
    } catch {
      /* fall through to disk rather than fail a read */
    }
  }
  const { events } = readEvents(ctx.coordDir);
  return [...foldState(events).entries()].map(([task_id, state]) => ({ task_id, ...state }));
}

export async function claim(ctx, taskId, agent, opts = {}) {
  const lease = acquireLease(ctx.coordDir, taskId, agent, opts);
  if (!lease.ok) return lease; // already-claimed — the same answer on both paths
  try {
    const event = await append(ctx, {
      type: "task_claimed",
      agent,
      task_id: taskId,
      payload: { takeover: lease.takeover }
    });
    return { ok: true, takeover: lease.takeover, mode: ctx.mode, event };
  } catch (e) {
    releaseLease(ctx.coordDir, taskId, agent); // never hold a lease for an event that never landed
    throw e;
  }
}

export async function progress(ctx, taskId, agent, payload = {}) {
  const event = await append(ctx, { type: "task_progress", agent, task_id: taskId, payload });
  return { ok: true, mode: ctx.mode, event };
}

export async function done(ctx, taskId, agent, payload = {}) {
  const event = await append(ctx, { type: "task_done", agent, task_id: taskId, payload });
  releaseLease(ctx.coordDir, taskId, agent);
  return { ok: true, mode: ctx.mode, event };
}

export async function note(ctx, agent, { topic, text, task_id = "-" } = {}) {
  const event = await append(ctx, {
    type: "knowledge_added",
    agent,
    task_id,
    payload: { topic, text }
  });
  return { ok: true, mode: ctx.mode, event };
}

// --- process entry point: how coord.py drives this without forking the protocol
const VERBS = { ls: list, claim, progress, done, note };

export async function main(argv) {
  const [verb, ...rest] = argv;
  if (!VERBS[verb]) throw new Error(`unknown coord verb '${verb}' (expected ${Object.keys(VERBS)})`);
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) flags[rest[i].replace(/^--/, "")] = rest[i + 1];
  const ctx = await connect({ coordDir: flags.dir, baseUrl: flags.api, mode: flags.mode });
  const agent = flags.agent ?? "claude";
  if (verb === "ls") return { ok: true, mode: ctx.mode, tasks: await list(ctx) };
  if (verb === "note") return note(ctx, agent, { topic: flags.topic, text: flags.text });
  const payload = flags.text ? { note: flags.text } : {};
  if (verb === "claim") return claim(ctx, flags.task, agent);
  return VERBS[verb](ctx, flags.task, agent, payload);
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
