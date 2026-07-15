// LONGVIEW memory management — label, resolve, teleport, restore (ADR-005 addendum).
//
// Every LONGVIEW artifact is keyed by session id (sid), so a label over
// projects/titles/card-text resolves DETERMINISTICALLY to a set of sids, and a
// sid resolves to every artifact in the lineage tree:
//
//   longview/inventory.json entry → evidence/<sid>.{md,meta.json}
//   → windows/<sid>/ → cards/<sid>.{json,meta.json} → data_out/reviews/<sid>.md
//   → Neo4j Source "longview_card_<sid>.md" (+ exclusively-sourced Concepts)
//   → Chroma chunks (metadata source = the card doc)
//
// "Teleport" MOVES the labelled subtree into a quarantine workspace — never
// deletes — journalling every move so `restore` is the exact inverse. The
// graph/vector halves ride scripts/longview/memory_graph.py; deliverables are
// checked by lib/leak_gate.mjs. Aggregates (rollups/themes/report/book) are
// cheap and regenerate from what remains (`regen`).
//
//   node scripts/longview/memory.mjs labels
//   node scripts/longview/memory.mjs projects
//   node scripts/longview/memory.mjs resolve  <label> [--json]
//   node scripts/longview/memory.mjs teleport <label> [--to <ws>] [--dry-run] [--files-only]
//   node scripts/longview/memory.mjs restore  <label> [--from <ws>] [--files-only]
//   node scripts/longview/memory.mjs gate     <label>
//   node scripts/longview/memory.mjs regen
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { config, workspaceDir, stateDir, projectRoot, subprocessEnv } from "./lib/config.mjs";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
// Label positional is optional when --terms is given (ad-hoc UI searches).
const labelArg = () =>
  args[1] && !args[1].startsWith("--") ? args[1] : opt("terms") ? `terms:${opt("terms")}` : null;

// Quarantine workspace must live under the SAME workspaces root so the app can
// browse it (its own graph workspace, its own chroma collection).
const TARGET = opt("to", opt("from", `${config.WORKSPACE}_private`));

const registryPath = () => stateDir("labels.json");
const quarantinePath = () => stateDir("quarantine.json");
const targetRoot = (...p) =>
  path.join(path.dirname(workspaceDir()), TARGET, ...p);

const readJSON = (p, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

function loadRegistry() {
  let reg = readJSON(registryPath());
  if (!reg) {
    // Seed with the operator's known-sensitive matcher set — edit labels.json
    // to tune. match_projects/match_titles are case-insensitive substrings;
    // terms of ≤3 chars match on word boundaries (see matches()).
    reg = {
      sensitive: {
        match_projects: ["cv", "resume", "job application", "t. rowe", "jpmc", "contract", "hsbc"],
        match_titles: true,
        match_card_text: false,
        explicit_sids: []
      }
    };
    fs.writeFileSync(registryPath(), JSON.stringify(reg, null, 2));
    console.log(`[memory] seeded default registry at ${registryPath()}`);
  }
  return reg;
}

function matches(text, term) {
  if (!text) return false;
  const t = String(text).toLowerCase();
  const q = term.toLowerCase();
  // Short terms ("cv") on word boundaries only — "canvas" must not match.
  if (q.length <= 3) return new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(t);
  return t.includes(q);
}

// ---------------------------------------------------------------- resolver
// Deterministic: inventory project/title + card project + (optional) card
// full text + explicit pins. Returns per-sid match reasons so `resolve` is a
// reviewable blast-radius report, not a black box.
function resolveLabel(label) {
  // Ad-hoc mode for the UI / one-off searches: --terms "cv,jpmc" builds an
  // ephemeral spec (no registry write); --sids a,b narrows to a chosen subset.
  const adhocTerms = opt("terms", null);
  let spec;
  if (adhocTerms) {
    spec = {
      match_projects: adhocTerms.split(",").map((s) => s.trim()).filter(Boolean),
      match_titles: true,
      match_card_text: flag("card-text"),
      explicit_sids: []
    };
  } else {
    const reg = loadRegistry();
    spec = reg[label];
    if (!spec) {
      console.error(`[memory] no label '${label}' in ${registryPath()} (labels: ${Object.keys(reg).join(", ")})`);
      process.exit(1);
    }
  }
  const inventory = readJSON(stateDir("inventory.json"), []);
  const bySid = new Map();
  const add = (sid, reason, meta = {}) => {
    const e = bySid.get(sid) || { sid, reasons: [], ...meta };
    e.reasons.push(reason);
    Object.assign(e, meta);
    bySid.set(sid, e);
  };
  for (const s of inventory) {
    for (const term of spec.match_projects || []) {
      if (matches(s.project, term)) add(s.id, `project~"${term}"`, { project: s.project, title: s.title, agent: s.agent });
      if (spec.match_titles && matches(s.title, term)) add(s.id, `title~"${term}"`, { project: s.project, title: s.title, agent: s.agent });
    }
  }
  // Cards can carry a better project name than inventory, and (opt-in) their
  // full text can be matched — catches a CV discussion inside a coding session.
  const cardsDir = stateDir("cards");
  const cardFiles = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    : [];
  for (const f of cardFiles) {
    const sid = f.replace(/\.json$/, "");
    const card = readJSON(path.join(cardsDir, f), {});
    for (const term of spec.match_projects || []) {
      if (matches(card.project, term)) add(sid, `card.project~"${term}"`, { project: card.project });
      if (spec.match_card_text && matches(JSON.stringify(card), term)) add(sid, `card.text~"${term}"`, { project: card.project });
    }
  }
  for (const sid of spec.explicit_sids || []) add(sid, "explicit");
  // Already-teleported sids still match (inventory keeps its census entry by
  // design) — mark them so resolve/teleport/UI can say "already quarantined"
  // instead of confusingly moving 0 files (2026-07-14 user report).
  const q = new Set(readJSON(quarantinePath(), { sids: [] }).sids || []);
  for (const e of bySid.values()) if (q.has(e.sid)) e.quarantined = true;
  let list = [...bySid.values()].sort((a, b) => a.sid.localeCompare(b.sid));
  // --sids a,b,c narrows to an explicit subset (UI checkbox selections);
  // accepts full sids or 8-char prefixes.
  const only = opt("sids", null);
  if (only) {
    const set = new Set(only.split(",").map((s) => s.trim()).filter(Boolean));
    list = list.filter((e) => set.has(e.sid) || set.has(e.sid.slice(0, 8)));
  }
  return { spec, sids: list };
}

// Every file-system artifact a sid owns, as [source, target] move pairs.
function sidMoves(sid) {
  const rel = [
    ["longview", "cards", `${sid}.json`],
    ["longview", "cards", `${sid}.meta.json`],
    ["longview", "evidence", `${sid}.md`],
    ["longview", "evidence", `${sid}.meta.json`],
    ["data_out", "reviews", `${sid}.md`]
  ];
  const pairs = rel
    .map((p) => [workspaceDir(...p), targetRoot(...p)])
    .filter(([src]) => fs.existsSync(src));
  const winDir = workspaceDir("longview", "windows", sid);
  if (fs.existsSync(winDir)) pairs.push([winDir, targetRoot("longview", "windows", sid)]);
  return pairs;
}

function moveOne(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.renameSync(src, dst);
}

function journal(entry) {
  fs.mkdirSync(targetRoot(), { recursive: true });
  fs.appendFileSync(
    targetRoot("teleport_moves.jsonl"),
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n"
  );
}

// The graph/vector half — memory_graph.py with the bundled python (chromadb +
// neo4j live there; system python 3.14 has neither guaranteed).
function runGraphMover(sourceNames, action, dryRun) {
  const listPath = path.join(projectRoot, "scripts", "longview", `.mover_${Date.now()}.json`);
  fs.writeFileSync(listPath, JSON.stringify(sourceNames));
  try {
    const py = "C:\\Users\\nsdha\\AppData\\Roaming\\space-agent\\runtime-bundle\\python\\python.exe";
    const r = spawnSync(
      fs.existsSync(py) ? py : "python",
      [
        path.join(projectRoot, "scripts", "longview", "memory_graph.py"),
        "--workspace", config.WORKSPACE,
        "--target", TARGET,
        "--sources-file", listPath,
        "--action", action,
        ...(dryRun ? ["--dry-run"] : []),
        "--json"
      ],
      {
        cwd: path.join(projectRoot, "runtime"),
        encoding: "utf8",
        timeout: 1800000,
        env: subprocessEnv({
          PYTHONIOENCODING: "utf-8",
          PYTHONUTF8: "1",
          PYTHONPATH: "C:\\Users\\nsdha\\AppData\\Roaming\\space-agent\\runtime-bundle\\site"
        })
      }
    );
    const lastLine = (r.stdout || "").trim().split("\n").filter(Boolean).pop() || "{}";
    try {
      return JSON.parse(lastLine);
    } catch {
      return { ok: false, errors: [`mover output unparseable: ${lastLine.slice(0, 200)} / ${(r.stderr || "").slice(-300)}`] };
    }
  } finally {
    fs.unlinkSync(listPath);
  }
}

function updateQuarantine(sids, action) {
  const q = readJSON(quarantinePath(), { sids: [], updated: null });
  const set = new Set(q.sids);
  for (const s of sids) action === "add" ? set.add(s) : set.delete(s);
  fs.writeFileSync(
    quarantinePath(),
    JSON.stringify({ sids: [...set].sort(), updated: new Date().toISOString() }, null, 2)
  );
}

// ---------------------------------------------------------------- commands
if (cmd === "labels") {
  const reg = loadRegistry();
  console.log(`[memory] registry: ${registryPath()}`);
  for (const [name, spec] of Object.entries(reg))
    console.log(`  ${name}: projects~[${(spec.match_projects || []).join(", ")}] titles=${!!spec.match_titles} card_text=${!!spec.match_card_text} pins=${(spec.explicit_sids || []).length}`);
} else if (cmd === "projects") {
  const inventory = readJSON(stateDir("inventory.json"), []);
  const byProject = new Map();
  for (const s of inventory) byProject.set(s.project, (byProject.get(s.project) || 0) + 1);
  for (const [p, n] of [...byProject.entries()].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(n).padStart(4)}  ${p}`);
} else if (cmd === "resolve") {
  const label = labelArg();
  const { sids } = resolveLabel(label);
  let files = 0;
  for (const e of sids) files += sidMoves(e.sid).length;
  if (flag("json")) {
    console.log(JSON.stringify({ label, sids, files }, null, 2));
  } else {
    const qN = sids.filter((e) => e.quarantined).length;
    console.log(`[memory] label '${label}' → ${sids.length} sessions (${qN} already quarantined), ${files} files\n`);
    for (const e of sids)
      console.log(`  ${e.sid.slice(0, 8)}  ${e.quarantined ? "[QUARANTINED] " : ""}${(e.project || "?").padEnd(24).slice(0, 24)}  ${e.reasons.join(", ")}${e.title ? `  · ${String(e.title).slice(0, 50)}` : ""}`);
    console.log(`\n  graph/vector blast radius: node memory_graph.py --dry-run (run 'teleport ${label} --dry-run')`);
  }
} else if (cmd === "teleport" || cmd === "restore") {
  const label = labelArg();
  const restoring = cmd === "restore";
  const dryRun = flag("dry-run");
  let { sids } = resolveLabel(label);
  // teleport skips already-quarantined sids (their subtree is already in the
  // target); restore operates ONLY on quarantined ones.
  const already = sids.filter((e) => e.quarantined);
  sids = restoring ? already : sids.filter((e) => !e.quarantined);
  if (!restoring && already.length)
    console.log(`[memory] ${already.length} session(s) already quarantined — skipped: ${already.map((e) => e.sid.slice(0, 8)).join(", ")}`);
  if (!sids.length) {
    console.log(
      restoring
        ? `[memory] label '${label}': no quarantined sessions to restore`
        : `[memory] label '${label}': nothing left to teleport — all matches are already quarantined. Use 'restore' to bring them back.`
    );
    process.exit(0);
  }
  console.log(`[memory] ${cmd} '${label}': ${sids.length} sessions ${restoring ? "←" : "→"} ${TARGET}${dryRun ? " (DRY RUN)" : ""}`);
  let moved = 0;
  for (const e of sids) {
    // restore = same pairs, swapped direction.
    const pairs = restoring ? restoreMoves(e.sid) : sidMoves(e.sid);
    for (const [src, dst] of pairs) {
      if (dryRun) {
        console.log(`  would move ${src} → ${dst}`);
      } else {
        moveOne(src, dst);
        journal({ label, action: cmd, sid: e.sid, from: src, to: dst });
      }
      moved++;
    }
  }
  if (!dryRun) updateQuarantine(sids.map((e) => e.sid), restoring ? "remove" : "add");
  console.log(`[memory] files: ${moved} ${dryRun ? "would move" : "moved"}`);
  if (!flag("files-only")) {
    // Ingested doc names use the 8-char sid prefix (graph-phase convention),
    // not the 32-char card filename — verified live against Neo4j.
    const names = sids.map((e) => `longview_card_${e.sid.slice(0, 8)}.md`);
    const verdict = runGraphMover(names, restoring ? "restore" : "move", dryRun);
    console.log(
      `[memory] graph/vectors: ok=${verdict.ok} sources=${verdict.sources_moved ?? "?"} concepts=${verdict.concepts_moved ?? "?"} shared_kept=${verdict.shared_concepts_kept ?? "?"} chunks=${verdict.chunks_moved ?? "?"}${(verdict.errors || []).length ? ` errors: ${verdict.errors.join(" | ").slice(0, 300)}` : ""}`
    );
    if (!verdict.ok) process.exit(2);
  }
  if (!dryRun && !restoring)
    console.log(`[memory] done. Aggregates are now stale — run 'regen', then re-run reduce/opus when ready.\n[memory] reversible any time: node scripts/longview/memory.mjs restore ${label} --from ${TARGET}`);
} else if (cmd === "gate") {
  const label = labelArg();
  const { spec, sids } = resolveLabel(label);
  const termsFile = path.join(projectRoot, "scripts", "longview", `.gate_${Date.now()}.json`);
  // Citations use both full sids and 8-char prefixes — gate on both.
  // Only auto-add a session's project name as a gate term when the NAME ITSELF
  // contains a matcher — generic catch-all projects ("outputs") otherwise flood
  // the gate with false positives (155-finding run, 2026-07-14).
  const matcherTerms = spec.match_projects || [];
  const projectTerms = sids
    .map((e) => e.project)
    .filter((p) => p && matcherTerms.some((t) => matches(p, t)));
  fs.writeFileSync(
    termsFile,
    JSON.stringify({
      terms: [...new Set([...matcherTerms, ...projectTerms])],
      sids: sids.flatMap((e) => [e.sid, e.sid.slice(0, 8)])
    })
  );
  try {
    const r = spawnSync(
      "node",
      [path.join(projectRoot, "scripts", "longview", "lib", "leak_gate.mjs"), "--workspace", config.WORKSPACE, "--terms-file", termsFile],
      { encoding: "utf8", stdio: "inherit", env: process.env }
    );
    process.exit(r.status ?? 1);
  } finally {
    fs.unlinkSync(termsFile);
  }
} else if (cmd === "regen") {
  console.log("[memory] regenerating deterministic aggregates (model-phase rollups)…");
  const r = spawnSync("node", [path.join(projectRoot, "scripts", "longview", "longview.mjs"), "run", "--phase", "model"], {
    encoding: "utf8",
    stdio: "inherit",
    env: process.env,
    timeout: 3600000
  });
  console.log(
    r.status === 0
      ? "[memory] rollups rebuilt. THEMES/report/dossiers/book are STALE until you re-run: run --phase reduce (then opus, pdf)."
      : "[memory] model phase failed — see output above"
  );
} else {
  console.log(
    "usage: node scripts/longview/memory.mjs labels | projects | resolve <label> [--json] | teleport <label> [--to ws] [--dry-run] [--files-only] | restore <label> [--from ws] | gate <label> | regen"
  );
  process.exit(cmd ? 1 : 0);
}

// Restore pairs: everything journalled for this sid, reversed. Falls back to
// deterministic path mirroring when the journal is missing.
function restoreMoves(sid) {
  const journalPath = targetRoot("teleport_moves.jsonl");
  const entries = fs.existsSync(journalPath)
    ? fs
        .readFileSync(journalPath, "utf8")
        .trim()
        .split("\n")
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.sid === sid && e.action === "teleport")
    : [];
  if (entries.length) return entries.map((e) => [e.to, e.from]).filter(([src]) => fs.existsSync(src));
  // Deterministic mirror: same relative paths, target → source.
  const rel = [
    ["longview", "cards", `${sid}.json`],
    ["longview", "cards", `${sid}.meta.json`],
    ["longview", "evidence", `${sid}.md`],
    ["longview", "evidence", `${sid}.meta.json`],
    ["data_out", "reviews", `${sid}.md`],
    ["longview", "windows", sid]
  ];
  return rel.map((p) => [targetRoot(...p), workspaceDir(...p)]).filter(([src]) => fs.existsSync(src));
}
