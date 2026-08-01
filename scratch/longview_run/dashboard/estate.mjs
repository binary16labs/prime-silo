// Flywheel & Estate — the compliance view of "can the flywheel turn, and is the
// evidence behind it safe?"
//
// Three questions, each answered from disk, never asserted:
//   1. DEBT      — how many sessions exist that LONGVIEW has not yet turned into
//                  cards. Debt is the flywheel's brake: unmapped sessions are
//                  knowledge the estate holds but cannot reason over.
//   2. READINESS — the phase dependency chain (inventory -> map -> graph -> reduce
//                  -> opus -> sad). A phase is READY only when its predecessor is
//                  satisfied; anything else names its blocker.
//   3. ESTATE    — hub (this machine: D: runner, F: fixed backup) and satellite
//                  (ASUS, pulled over SMB). Backup freshness and satellite lag are
//                  reported as measured ages, with an explicit verdict.
//
// PRIVACY (EP-N N3, gate-enforced): quarantined sessions are COUNTED, never named.
// No sid, project or title of a quarantined session leaves this module.
//
// Controls are tagged to the frameworks the regulator asked for, so every number
// on the page can be traced to the obligation it satisfies.

import fs from "fs";
import path from "path";

const HOME = (process.env.BENNY_HOME || "D:/benny-home/benny").replace(/\\/g, "/");
const wsDir = (w) => `${HOME}/workspaces/${w || "sessions_v1"}`;
const ageDays = (ms) => Math.round((Date.now() - ms) / 86400000 * 10) / 10;
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const dirCount = (p, filter) => {
  try { return fs.readdirSync(p).filter(filter || (() => true)).length; } catch { return 0; }
};
const newestIn = (p) => {
  try {
    const e = fs.readdirSync(p).map((f) => ({ f, m: fs.statSync(path.join(p, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0];
    return e ? { name: e.f, at: new Date(e.m).toISOString(), age_days: ageDays(e.m) } : null;
  } catch { return null; }
};

// Framework control tags — the "why this number exists" mapping.
export const CONTROLS = {
  debt: ["BCBS239-P4 completeness", "BCBS239-P5 timeliness", "SS1/23-P3 model use", "TOGAF-H change mgmt"],
  readiness: ["TOGAF-G implementation governance", "SS1/23-P2 governance", "BCBS239-P2 data architecture"],
  backup: ["BCBS239-P3 accuracy & integrity", "BCBS239-P6 adaptability", "SS1/23-P5 model risk mitigants"],
  satellite: ["BCBS239-P2 data architecture", "BCBS239-P4 completeness", "TOGAF-D technology"],
  privacy: ["BCBS239-P1 governance", "SS1/23-P2 governance"]
};

// ── 1. Debt ───────────────────────────────────────────────────────────────
export function debtState(w) {
  const W = `${wsDir(w)}/longview`;
  const inv = readJSON(`${W}/inventory.json`, []) || [];
  const quarantined = new Set((readJSON(`${W}/quarantine.json`, { sids: [] }).sids) || []);
  let cards = new Set();
  try {
    cards = new Set(fs.readdirSync(`${W}/cards`)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .map((f) => f.replace(/\.json$/, "")));
  } catch { }
  // A session with no card is NOT automatically debt. `map` deliberately excludes
  // sessions it judged too thin to card (verdict skipped_thin) — that is a
  // classified outcome, not a backlog. Reporting them as unmapped overstates the
  // gap; hiding them understates it. Both are reported, separated.
  const verdicts = new Map();
  try {
    for (const line of fs.readFileSync(`${W}/ledger.jsonl`, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const id = e.session_id || e.sid || e.id;
      if (id && (e.status || e.verdict)) verdicts.set(id, e.status || e.verdict);
    }
  } catch { }

  const byAgent = {}, debtByAgent = {};
  let carded = 0, quar = 0, debt = 0, skippedThin = 0;
  let oldestDebt = null;
  for (const e of inv) {
    const sid = e.id || e.session_id || e.sid;
    const agent = e.agent || "unknown";
    byAgent[agent] = (byAgent[agent] || 0) + 1;
    if (!sid) continue;
    if (quarantined.has(sid)) { quar++; continue; }          // counted, never named
    if (cards.has(sid)) { carded++; continue; }
    if (verdicts.get(sid) === "skipped_thin") { skippedThin++; continue; }
    debt++;
    debtByAgent[agent] = (debtByAgent[agent] || 0) + 1;
    // timestamps appear as ISO strings OR epoch (s/ms) depending on the source agent
    const raw = e.timestamp;
    const ts = typeof raw === "number"
      ? (raw > 1e12 ? raw : raw * 1000)
      : Date.parse(raw || "");
    if (Number.isFinite(ts) && (!oldestDebt || ts < oldestDebt)) oldestDebt = ts;
  }
  const total = inv.length;
  return {
    inventory: total, carded, quarantined: quar, debt, skipped_thin: skippedThin,
    accounted: carded + quar + skippedThin + debt,
    coverage_pct: total ? Math.round((100 * carded) / (total - quar || 1)) : 0,
    by_agent: byAgent, debt_by_agent: debtByAgent,
    oldest_debt_at: oldestDebt ? new Date(oldestDebt).toISOString() : null,
    oldest_debt_age_days: oldestDebt ? ageDays(oldestDebt) : null,
    clears_with: "longview run --phase map --delta",
    skipped_thin_note: "sessions map judged too thin to card — a classified outcome, not a backlog; " +
                       "re-map with --force if the thinness judgement is disputed",
    verdict: debt === 0 ? "CLEAR" : debt <= 10 ? "MANAGEABLE" : "BLOCKING",
    controls: CONTROLS.debt,
    privacy_note: "quarantined sessions are counted only — no sid, project or title is exposed"
  };
}

// ── 2. Flywheel phase readiness (a real dependency chain) ─────────────────
export function readinessState(w) {
  const W = wsDir(w);
  const L = `${W}/longview`;
  const inv = (readJSON(`${L}/inventory.json`, []) || []).length;
  const cards = dirCount(`${L}/cards`, (f) => f.endsWith(".json") && !f.endsWith(".meta.json"));
  const dossiers = dirCount(`${W}/data_out/dossiers`, (f) => f.endsWith(".md"));
  const book = dirCount(`${W}/data_out/opus`, (f) => f.endsWith(".md") || f.endsWith(".pdf"));
  const sads = dirCount(`${W}/data_out`, (f) => /^TOGAF_EPIC_V\d_SAD.*\.pdf$/.test(f));
  const register = fs.existsSync(`${L}/lineage/execution_register.json`);
  // "map" is satisfied only when every ELIGIBLE session is carded — i.e. debt is
  // zero. Anything else would render the flywheel green while it is braked.
  // Derive the map target from the SAME accounting as debtState, so readiness and
  // debt can never disagree: everything that should be carded is what is carded
  // plus what is still owed. `map` is satisfied only when debt is zero.
  const d = debtState(w);
  const eligible = Math.max(1, d.carded + d.debt);
  const chain = [
    { id: "inventory", label: "Session inventory", have: inv, need: 1, unit: "sessions" },
    { id: "map", label: "Map to cards", have: cards, need: eligible, unit: "cards" },
    { id: "graph", label: "Knowledge graph", have: register ? 1 : 0, need: 1, unit: "built" },
    { id: "reduce", label: "Dossiers / themes", have: dossiers, need: 1, unit: "dossiers" },
    { id: "opus", label: "Long-form book", have: book, need: 1, unit: "artifacts" },
    { id: "sad", label: "Architecture document", have: sads, need: 1, unit: "SAD PDFs" }
  ];
  let prevOk = true;
  const phases = chain.map((p) => {
    const satisfied = p.have >= p.need;
    const state = !prevOk ? "blocked" : satisfied ? "satisfied" : "ready";
    const row = { ...p, satisfied, state, pct: Math.min(100, Math.round((100 * p.have) / (p.need || 1))),
                  blocked_by: prevOk ? null : "upstream phase incomplete" };
    prevOk = prevOk && satisfied;
    return row;
  });
  return { phases, controls: CONTROLS.readiness,
           turning: phases.every((p) => p.satisfied) };
}

// ── 3. Estate: hub + satellite + backup cascade ───────────────────────────
function driveInfo(letter) {
  const root = `${letter}:/`;
  const present = fs.existsSync(root);
  return { drive: letter, present };
}

export function estateState(w) {
  const backupsDir = "D:/backups";
  const satelliteDir = "D:/asus_ingest";
  const latestBackup = newestIn(backupsDir);
  const latestSatellite = newestIn(satelliteDir);
  const debt = debtState(w);

  const backupVerdict = !latestBackup ? "NONE"
    : latestBackup.age_days <= 2 ? "FRESH"
    : latestBackup.age_days <= 7 ? "STALE" : "OVERDUE";
  const satVerdict = !latestSatellite ? "NEVER_PULLED"
    : latestSatellite.age_days <= 2 ? "CURRENT"
    : latestSatellite.age_days <= 7 ? "LAGGING" : "OVERDUE";

  const hub = {
    role: "hub / driver node", name: "T480",
    device_id: (() => { try { return fs.readFileSync(`${HOME}/state/device-id`, "utf8").trim(); } catch { return null; } })(),
    drives: ["C", "D", "F"].map(driveInfo),
    benny_home: HOME,
    sessions_local: debt.by_agent.Claude || 0
  };
  const satellite = {
    role: "satellite", name: "ASUS",
    transport: "SMB pull -> D:/asus_ingest",
    // EP-N N7 (live LAN registration) is NOT built: there is no heartbeat, so
    // reachability is UNKNOWN rather than assumed. Freshness of the last pull is
    // the only honest evidence available today.
    registered: false,
    live_reachability: "unknown (EP-N N7 live registration not implemented)",
    last_pull: latestSatellite,
    lag_verdict: satVerdict,
    sessions_from_satellite: debt.by_agent.Antigravity || 0
  };
  return {
    hub, satellite,
    backup: {
      cascade: "F: (fixed) -> D: (runner) -> eGPU (delta-only)",
      latest: latestBackup, verdict: backupVerdict,
      snapshots: dirCount(backupsDir),
      fingerprint_drift: "not computed (EP-N N1/N4 drift engine not implemented)",
      controls: CONTROLS.backup
    },
    gaps: [
      ...(backupVerdict !== "FRESH" ? [`hub backup is ${backupVerdict.toLowerCase()} (${latestBackup ? latestBackup.age_days : "?"}d old)` +
        (debt.debt > 0
          ? ` while ${debt.debt} session(s) of debt exist — unmapped work is also unbacked`
          : ` — ${debt.carded} cards and their evidence are newer than the last snapshot`)] : []),
      ...(satVerdict !== "CURRENT" ? [`satellite pull is ${satVerdict.toLowerCase()} (${latestSatellite ? latestSatellite.age_days : "never"}d) — newer satellite sessions may be unbacked and unmapped`] : []),
      "drift verdict (INTACT/DRIFT/CORRUPT) unavailable — EP-N N1/N4 fingerprint engine not built",
      "satellite liveness unavailable — EP-N N7 LAN registration not built"
    ],
    controls: CONTROLS.satellite
  };
}

export function flywheelState(w) {
  const debt = debtState(w);
  const readiness = readinessState(w);
  const estate = estateState(w);
  const blockers = [];
  if (debt.debt > 0) blockers.push(`${debt.debt} sessions unmapped — run \`${debt.clears_with}\``);
  for (const g of estate.gaps) blockers.push(g);
  return {
    generated_at: new Date().toISOString(),
    workspace: w || "sessions_v1",
    debt, readiness, estate, blockers,
    compliance: {
      frameworks: ["TOGAF ADM", "BCBS 239", "PRA SS1/23"],
      note: "Each panel is tagged with the controls it evidences. Unbuilt probes are declared, not implied."
    }
  };
}
