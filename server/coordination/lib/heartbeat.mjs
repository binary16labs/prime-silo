// Estate heartbeat — notice silence.
// Spec: architecture/SPEC-knowledge-eventlog.md (envelope) · SOLUTION-estate.md (nodes).
//
// On 2026-09-04 the t480's Benny stopped and nobody found out for about twelve hours. Every
// tier reported correctly the whole time — there was simply nothing asking. The estate could
// describe itself in detail and could not notice its own absence.
//
// The design decision that matters here is what NOT to record. Polling three nodes every
// sixty seconds is ~86,000 observations a day; writing those into an append-only hash-chained
// log would bury the events that mean something under the ones that mean "still fine", and
// make the chain expensive to verify. So:
//
//   THE LEDGER RECORDS TRANSITIONS, NOT OBSERVATIONS.
//
// Polling is cheap and constant; the log only grows when reality changes. That is the same
// doctrine the UI follows — if nothing moved, nothing is emitted — and it means the outage
// gauge below reads a handful of events rather than a day of noise.
//
// Probes are injected (`probe`) so this is testable without a network and so the caller
// chooses how reachability is decided — a TCP connect, an HTTP health route, an SSH command.
import net from "node:net";
import { ulid, CURRENT_SCHEMA_VERSION, appendKelEvent } from "./kel.mjs";

export const HEARTBEAT_TYPES = Object.freeze({
  node: "node_observed",
  service: "service_transitioned"
});

export const subjectId = Object.freeze({
  node: (machine) => `node:${machine}`,
  service: (machine, service) => `service:${machine}:${service}`
});

// The estate as it actually is, verified by a live sweep on 2026-09-05.
//
// `scope` is the correction that sweep produced, and it is not a detail. Benny and Neo4j
// bind LOOPBACK ONLY — which is the correct and deliberate default (see .env: "HOST … the
// safe default: 127.0.0.1 … set HOST=0.0.0.0 only to deliberately expose"). Probing them
// across the tailnet therefore reports DOWN for services that are perfectly healthy:
//
//   over the tailnet          on localhost
//   t480/benny    DOWN        t480/benny    up
//   t480/neo4j    DOWN        t480/neo4j    up
//
// A monitor that cries wolf on its two most important services is worse than no monitor,
// and the fix is emphatically NOT to expose them. Loopback services are observed by the
// node itself (`scope: "local"`, probed via 127.0.0.1) and the observation is attributed
// with `observed_by`; only services that genuinely bind all interfaces — memoray, jellyfin
// — can be probed cross-node (`scope: "estate"`).
const LOOPBACK_SERVICES = [
  { name: "benny", port: 8005, kind: "http", path: "/api/agent_sandbox/health", scope: "local" },
  { name: "neo4j", port: 7474, kind: "tcp", scope: "local" },
  { name: "memoray", port: 3030, kind: "tcp", scope: "estate" }
];

export const ESTATE_TARGETS = Object.freeze([
  { machine: "t480", host: "100.99.229.31", services: LOOPBACK_SERVICES },
  { machine: "optimus", host: "100.85.245.86", services: LOOPBACK_SERVICES },
  {
    machine: "homeassistant",
    host: "100.79.255.23",
    services: [{ name: "jellyfin", port: 8096, kind: "tcp", scope: "estate" }]
  }
]);

// What this node can honestly observe about itself: everything it hosts, over loopback.
export function localTargets(machine, targets = ESTATE_TARGETS) {
  const t = targets.find((x) => x.machine === machine);
  return t ? [{ machine, host: "127.0.0.1", services: t.services }] : [];
}

// What any node may observe about the others: only what actually listens off-box. Probing
// beyond this produces false outages, so the filter is the point.
export function estateTargets(targets = ESTATE_TARGETS, { exclude = null } = {}) {
  return targets
    .filter((t) => t.machine !== exclude)
    .map((t) => ({ ...t, services: t.services.filter((s) => s.scope === "estate") }))
    .filter((t) => t.services.length > 0);
}

// --- probing ------------------------------------------------------------------------

// A TCP connect is the honest floor: it proves something is listening, nothing more.
export function tcpProbe({ host, port, timeoutMs = 4000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = new net.Socket();
    const done = (up, reason = null) => {
      sock.destroy();
      resolve({ up, ms: Date.now() - started, reason });
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false, "timeout"));
    sock.once("error", (e) => done(false, e.code || e.message));
    sock.connect(port, host);
  });
}

// Listening is not the same as healthy — Benny binds :8005 before it can answer, and the
// twelve-hour outage was a process that was gone rather than a port that was closed. Where
// a service publishes a health route, ask it.
export async function httpProbe({ host, port, path = "/", timeoutMs = 5000 }) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`http://${host}:${port}${path}`, { signal: ctrl.signal });
    return { up: res.ok, ms: Date.now() - started, reason: res.ok ? null : `http ${res.status}` };
  } catch (e) {
    return {
      up: false,
      ms: Date.now() - started,
      reason: e.name === "AbortError" ? "timeout" : e.message
    };
  } finally {
    clearTimeout(timer);
  }
}

const defaultProbe = (svc) => (svc.kind === "http" ? httpProbe(svc) : tcpProbe(svc));

// Sweep the estate once. Returns a flat state map, not events — deciding what is worth
// recording is a separate concern (see recordHeartbeat).
export async function sweep(targets = ESTATE_TARGETS, { probe = defaultProbe } = {}) {
  const observed_at = new Date().toISOString();
  const state = {};
  await Promise.all(
    targets.map(async (t) =>
      Promise.all(
        t.services.map(async (s) => {
          const r = await probe({
            host: t.host,
            port: s.port,
            path: s.path,
            kind: s.kind,
            name: s.name
          });
          state[`${t.machine}/${s.name}`] = {
            machine: t.machine,
            service: s.name,
            up: !!r.up,
            ms: r.ms ?? null,
            reason: r.reason ?? null,
            observed_at
          };
        })
      )
    )
  );
  // A node counts as reachable if anything on it answered — distinguishes "the box is gone"
  // from "one service died", which are different problems with different fixes.
  for (const t of targets) {
    const mine = Object.values(state).filter((s) => s.machine === t.machine);
    state[`${t.machine}`] = {
      machine: t.machine,
      service: null,
      up: mine.some((s) => s.up),
      observed_at
    };
  }
  return state;
}

// --- transitions --------------------------------------------------------------------

// What changed between two sweeps. A key absent from `previous` is a first observation and
// counts as a transition, so the very first sweep establishes a baseline in the log.
export function diffState(previous = {}, current = {}) {
  const out = [];
  for (const [key, now] of Object.entries(current)) {
    const before = previous[key];
    if (before && before.up === now.up) continue;
    out.push({
      key,
      machine: now.machine,
      service: now.service,
      from: before ? (before.up ? "up" : "down") : "unknown",
      to: now.up ? "up" : "down",
      reason: now.reason ?? null,
      at: now.observed_at
    });
  }
  return out;
}

// --- builders (pure) ----------------------------------------------------------------

function envelope({ type, subject, machine, payload, valid_time }) {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    schema_version: CURRENT_SCHEMA_VERSION,
    type,
    valid_time: valid_time || now,
    txn_time: now,
    time_confidence: valid_time ? "known" : "inferred",
    hlc: `${now}-0000-${machine}`,
    machine,
    authorship: "house", // a probe is deterministic machinery, never judgement (R38)
    sid: subject.id,
    subject,
    payload
  };
}

export function nodeObservedEvent({
  machine,
  up,
  from = "unknown",
  reason = null,
  valid_time = null
}) {
  if (!machine) throw new Error("nodeObservedEvent: machine is required");
  return envelope({
    type: HEARTBEAT_TYPES.node,
    subject: { kind: "node", id: subjectId.node(machine) },
    machine,
    valid_time,
    payload: { up, from, to: up ? "up" : "down", reason }
  });
}

export function serviceTransitionedEvent({
  machine,
  service,
  up,
  from = "unknown",
  reason = null,
  valid_time = null
}) {
  if (!machine) throw new Error("serviceTransitionedEvent: machine is required");
  if (!service) throw new Error("serviceTransitionedEvent: service is required");
  return envelope({
    type: HEARTBEAT_TYPES.service,
    subject: { kind: "service", id: subjectId.service(machine, service) },
    machine,
    valid_time,
    payload: { service, up, from, to: up ? "up" : "down", reason }
  });
}

// --- record: append ONLY what changed ------------------------------------------------

export function recordHeartbeat(logFile, previous, current, { observer = "t480" } = {}) {
  const transitions = diffState(previous, current);
  const events = [];
  for (const t of transitions) {
    const evt = t.service
      ? serviceTransitionedEvent({
          machine: t.machine,
          service: t.service,
          up: t.to === "up",
          from: t.from,
          reason: t.reason,
          valid_time: t.at
        })
      : nodeObservedEvent({
          machine: t.machine,
          up: t.to === "up",
          from: t.from,
          reason: t.reason,
          valid_time: t.at
        });
    // the observing node is recorded separately from the observed one: "optimus says the
    // t480 is down" is a different claim from "the t480 says it is down"
    evt.payload.observed_by = observer;
    const res = appendKelEvent(logFile, evt);
    if (res.ok) events.push(evt);
  }
  return { transitions, events, quiet: transitions.length === 0 };
}

// --- projections ---------------------------------------------------------------------

const keyOf = (evt) => {
  const id = evt?.subject?.id || "";
  if (id.startsWith("service:")) {
    const [, machine, service] = id.split(":");
    return { key: `${machine}/${service}`, machine, service };
  }
  if (id.startsWith("node:")) {
    const [, machine] = id.split(":");
    return { key: machine, machine, service: null };
  }
  return null;
};

// Current state per service, and — the part that matters — SINCE WHEN. An outage with no
// start time cannot be triaged; "benny is down" is a fact, "benny has been down for eleven
// hours" is the thing that would have got someone's attention.
export function buildHealth(events = []) {
  const health = new Map();
  for (const evt of events) {
    if (evt?.type !== HEARTBEAT_TYPES.node && evt?.type !== HEARTBEAT_TYPES.service) continue;
    const k = keyOf(evt);
    if (!k) continue;
    const up = evt.payload?.to === "up";
    const prior = health.get(k.key);
    // `since` only moves when the state itself moves — that is the whole point of recording
    // transitions rather than observations.
    health.set(k.key, {
      ...k,
      up,
      since: prior && prior.up === up ? prior.since : evt.valid_time,
      reason: evt.payload?.reason ?? null,
      observed_by: evt.payload?.observed_by ?? null
    });
  }
  return [...health.values()];
}

// What is down, and for how long. `thresholdMs` is the "this is no longer a blip" line.
export function outages(events = [], { now = new Date(), thresholdMs = 0 } = {}) {
  const t = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return buildHealth(events)
    .filter((h) => !h.up)
    .map((h) => ({ ...h, downMs: t - new Date(h.since).getTime() }))
    .filter((h) => h.downMs >= thresholdMs)
    .sort((a, b) => b.downMs - a.downMs);
}

// The gauge the Gov arc publishes: the longest current silence. On 2026-09-04 this would
// have read ~12 hours instead of nothing at all.
export function longestSilence(events = [], { now = new Date() } = {}) {
  const [worst] = outages(events, { now });
  return worst ? { ...worst, hours: +(worst.downMs / 3600000).toFixed(2) } : null;
}
