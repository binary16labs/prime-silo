// Coordination ledger — validator lib + wx-exclusive lease protocol (B0).
// Spec: architecture/SPEC-coordination-ledger.md · Schemas: ../schema/*.json
// No dependencies: the schema files are normative; the checker below enforces
// exactly the subset of JSON Schema they use (type/required/properties/enum/
// pattern/minLength/additionalProperties).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const eventSchema = JSON.parse(
  fs.readFileSync(path.join(here, "..", "schema", "event.schema.json"), "utf8")
);
export const SEED_AGENTS = ["claude", "antigravity", "opencode", "benny", "human"];
const DEFAULT_TTL_MS = 15 * 60_000;

// --- ulid (Crockford base32: 48-bit ms timestamp + 80 bits randomness) ---
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export function ulid(now = Date.now()) {
  let t = now,
    ts = "";
  for (let i = 0; i < 10; i++) {
    ts = B32[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  let rnd = "";
  for (const b of crypto.randomBytes(16)) rnd += B32[b % 32];
  return ts + rnd.slice(0, 16);
}

function checkSchema(obj, schema) {
  if (schema.type === "object" && (typeof obj !== "object" || obj === null || Array.isArray(obj)))
    return "not an object";
  for (const key of schema.required ?? [])
    if (!(key in obj)) return `missing required field '${key}'`;
  for (const [key, val] of Object.entries(obj)) {
    const prop = schema.properties?.[key];
    if (!prop) {
      if (schema.additionalProperties === false) return `unknown field '${key}'`;
      continue;
    }
    if (prop.enum && !prop.enum.includes(val)) return `'${key}' not one of ${prop.enum.join("|")}`;
    if (prop.type === "string" && typeof val !== "string") return `'${key}' must be a string`;
    if (prop.type === "object" && (typeof val !== "object" || val === null || Array.isArray(val)))
      return `'${key}' must be an object`;
    if (prop.minLength && val.length < prop.minLength) return `'${key}' too short`;
    if (prop.pattern && !new RegExp(prop.pattern).test(val)) return `'${key}' malformed`;
  }
  return null;
}

export function validateEvent(evt, agents) {
  const err = checkSchema(evt, eventSchema);
  if (err) return { ok: false, reason: err };
  if (Number.isNaN(Date.parse(evt.ts))) return { ok: false, reason: "'ts' is not a real date" };
  if (!agents.includes(evt.agent))
    return { ok: false, reason: `agent '${evt.agent}' not in coordination/agents.json` };
  return { ok: true };
}

// --- coordination dir layout ---
export function initCoordination(dir, { agents = SEED_AGENTS } = {}) {
  fs.mkdirSync(path.join(dir, "leases"), { recursive: true });
  fs.mkdirSync(path.join(dir, "knowledge"), { recursive: true });
  const reg = path.join(dir, "agents.json");
  if (!fs.existsSync(reg)) fs.writeFileSync(reg, JSON.stringify({ agents }, null, 2) + "\n");
}

export function loadAgents(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "agents.json"), "utf8")).agents;
}

// --- append-only ledger with tamper-evidence hash chain ---
const lineHash = (raw) =>
  crypto.createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 16);

function withAppendLock(dir, fn) {
  // Serializes direct-file appends across processes (B1 server serializes via API).
  const lock = path.join(dir, "tasks.jsonl.lock");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const stale = Date.now() - fs.statSync(lock).mtimeMs > 10_000;
      if (stale) {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* lost the removal race */
        }
      } else if (Date.now() > deadline) throw new Error("ledger append lock timeout");
    }
  }
  try {
    return fn();
  } finally {
    fs.unlinkSync(lock);
  }
}

function rawLines(dir) {
  const p = path.join(dir, "tasks.jsonl");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

export function appendEvent(dir, evt) {
  const v = validateEvent(evt, loadAgents(dir));
  if (!v.ok) throw new Error(`event rejected: ${v.reason}`);
  return withAppendLock(dir, () => {
    const lines = rawLines(dir);
    const prev = lines.length === 0 ? "genesis" : lineHash(lines.at(-1));
    const line = JSON.stringify({ ...evt, prev });
    fs.appendFileSync(path.join(dir, "tasks.jsonl"), line + "\n");
    return line;
  });
}

export function readEvents(dir) {
  const lines = rawLines(dir);
  const events = [];
  for (let i = 0; i < lines.length; i++) {
    let evt;
    try {
      evt = JSON.parse(lines[i]);
    } catch {
      return { ok: false, badLine: i + 1, events };
    }
    const expected = i === 0 ? "genesis" : lineHash(lines[i - 1]);
    // A mismatch at line i+1 means line i was edited after being chained.
    if (evt.prev !== expected) return { ok: false, badLine: i, events };
    events.push(evt);
  }
  return { ok: true, events };
}

// --- state = fold(events); the ledger is truth, leases are advisory locks ---
export function foldState(events) {
  const tasks = new Map();
  for (const e of events) {
    if (e.type === "knowledge_added") continue;
    const t = tasks.get(e.task_id) ?? { state: "todo", agent: null };
    if (e.run_id) t.run_id = e.run_id;
    switch (e.type) {
      case "task_created":
        t.state = "todo";
        break;
      case "task_claimed":
      case "task_progress":
        t.state = "claimed";
        t.agent = e.agent;
        break;
      case "task_done":
        t.state = "done";
        t.agent = e.agent;
        break;
      case "task_blocked":
        t.state = "blocked";
        t.agent = e.agent;
        t.reason = e.payload?.reason;
        break;
      case "task_released":
        t.state = "todo";
        t.agent = null;
        break;
    }
    tasks.set(e.task_id, t);
  }
  return tasks;
}

// --- claim protocol: atomic create-exclusive lease files ---
function tryCreateLease(leasePath, taskId, agent, ttlMs) {
  const lease = {
    task_id: taskId,
    agent,
    claimed_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString()
  };
  fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2), { flag: "wx" });
}

export function claimTask(dir, taskId, agent, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const leasePath = path.join(dir, "leases", `${taskId}.json`);
  let takeover = false;
  try {
    tryCreateLease(leasePath, taskId, agent, ttlMs);
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let lease = null;
    try {
      lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    } catch {
      /* holder mid-write or gone */
    }
    if (lease && Date.parse(lease.expires_at) > Date.now())
      return { ok: false, reason: "already-claimed" };
    try {
      fs.unlinkSync(leasePath);
    } catch {
      /* another claimant removed it first */
    }
    try {
      tryCreateLease(leasePath, taskId, agent, ttlMs);
    } catch (e2) {
      if (e2.code !== "EEXIST") throw e2;
      return { ok: false, reason: "already-claimed" };
    }
    takeover = true;
  }
  appendEvent(dir, {
    id: ulid(),
    ts: new Date().toISOString(),
    type: "task_claimed",
    agent,
    task_id: taskId,
    payload: { takeover }
  });
  return { ok: true, takeover };
}

export function renewLease(dir, taskId, agent, { ttlMs = DEFAULT_TTL_MS } = {}) {
  const leasePath = path.join(dir, "leases", `${taskId}.json`);
  if (!fs.existsSync(leasePath)) return { ok: false, reason: "no-lease" };
  const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
  if (lease.agent !== agent) return { ok: false, reason: "not-owner" };
  const next = Math.max(Date.parse(lease.expires_at), Date.now() + ttlMs);
  lease.expires_at = new Date(next).toISOString();
  fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2));
  return { ok: true };
}

export function releaseTask(dir, taskId, agent, payload = {}) {
  const leasePath = path.join(dir, "leases", `${taskId}.json`);
  if (fs.existsSync(leasePath)) {
    const lease = JSON.parse(fs.readFileSync(leasePath, "utf8"));
    if (lease.agent !== agent) return { ok: false, reason: "not-owner" };
    fs.unlinkSync(leasePath);
  }
  appendEvent(dir, {
    id: ulid(),
    ts: new Date().toISOString(),
    type: "task_released",
    agent,
    task_id: taskId,
    payload
  });
  return { ok: true };
}
