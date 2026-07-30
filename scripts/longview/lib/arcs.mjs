// Opus arc planner — the connective tissue the book was missing.
//
// The first book read thin (16% session coverage) because every section stood
// on 4 scattered retrieval chunks and a one-line brief; nothing ever PLANNED a
// connection across projects or time. An arc is that missing unit: a single
// thread (a concept/capability that recurs) walked CHRONOLOGICALLY across the
// projects it touched — "coordination ledger born in prime-silo (April), failed
// in memo-ray (May), became infrastructure in benny (June)".
//
// Arcs are built DETERMINISTICALLY from the cards' own fragments + inventory
// timestamps (no hallucinated "Project A"): we group cards by recurring
// concept/capability, order the touchpoints by time, and keep the threads that
// genuinely SPAN the journey (many sessions across many months). One bounded
// LLM call per arc turns the real beats into narrative prose. Sections then
// inherit their chapter's arcs — concrete sids to cite, real connections to
// draw — which is what lifts both depth and corpus coverage.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { config, workspaceDir, stateDir } from "./config.mjs";
import { chat, lastBalancedJson, repairTruncatedJson } from "./llm.mjs";
import { appendLedger } from "./ledger.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prompt = (name) =>
  fs.readFileSync(path.join(__dirname, "..", "prompts", `${name}.md`), "utf8");

const readJSON = (p, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return d;
  }
};

// Normalise a thread name so "Neo4j graph database" and "Neo4j" fold together —
// same intent as the enrich merge, but cheap and local for the arc index.
const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const monthOf = (ts) => (ts ? new Date(Number(ts)).toISOString().slice(0, 7) : "");

// ---------------------------------------------------------------- gather
// Build the thread index from cards. A "thread" = a concept or capability that
// recurs; its touchpoints are the cards that name it, each carrying the card's
// real sid/project/month plus a one-line "what happened" snippet.
// Exported for deterministic testing (no LLM) of the selection ranking.
export function threadIndex() {
  const cardsDir = stateDir("cards");
  const inventory = readJSON(stateDir("inventory.json"), []) || [];
  const invById = new Map(inventory.map((e) => [e.id, e]));
  const quarantined = new Set((readJSON(stateDir("quarantine.json"), {}) || {}).sids || []);

  const files = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    : [];

  // thread key → { display, touchpoints: [{sid, project, month, ts, snippet}] }
  const threads = new Map();
  for (const f of files) {
    const sid = f.replace(/\.json$/, "");
    if (quarantined.has(sid)) continue;
    const card = readJSON(path.join(cardsDir, f), {});
    const inv = invById.get(sid) || {};
    const ts = inv.timestamp || null;
    const project = card.project || inv.project || "unknown";
    // The card's own record of what this session DID — the beat's substance.
    const snippet =
      (card.decisions || card.outcomes || card.intent || []).flat?.()?.slice?.(0, 1)?.[0] ||
      (Array.isArray(card.outcomes) ? card.outcomes[0] : card.intent) ||
      "";
    // Concepts and capabilities are both candidate threads (skills_observed are
    // operator-style, less useful as project-connecting spines).
    const terms = [...(card.concepts || []), ...(card.capabilities || [])];
    const seen = new Set();
    for (const t of terms) {
      const key = norm(t);
      if (key.length < 4 || seen.has(key)) continue;
      seen.add(key);
      const th = threads.get(key) || { display: t, touchpoints: [] };
      th.touchpoints.push({
        sid: sid.slice(0, 8),
        project,
        month: monthOf(ts),
        ts,
        snippet: String(snippet).slice(0, 160)
      });
      threads.set(key, th);
    }
  }
  return threads;
}

// Rank threads by how much of the JOURNEY they span, not raw frequency: a thread
// touching 6 projects across 4 months is a better book spine than one hammered
// 20 times inside a single project in one week.
export function selectThreads(threads, limit) {
  // Total distinct sessions — used to spot AMBIENT threads (mechanical habits
  // like "file navigation" that recur in most sessions). They're the widest but
  // the least narratively distinctive; dampen raw volume so cross-project
  // breadth and time-span win, and the substantive spines aren't crowded out.
  const allSids = new Set();
  for (const [, th] of threads) for (const t of th.touchpoints) allSids.add(t.sid);
  const totalSessions = allSids.size || 1;

  const scored = [];
  for (const [key, th] of threads) {
    const projects = new Set(th.touchpoints.map((t) => t.project).filter(Boolean));
    const months = new Set(th.touchpoints.map((t) => t.month).filter(Boolean));
    const sids = new Set(th.touchpoints.map((t) => t.sid));
    if (sids.size < 2 || projects.size < 2) continue; // an arc must CONNECT
    const fraction = sids.size / totalSessions;
    // sqrt on session volume dampens ubiquity; a mild penalty on threads present
    // in >40% of sessions pushes background habits below distinctive spines.
    const ubiquityPenalty = fraction > 0.4 ? 0.5 : 1;
    const score = Math.sqrt(sids.size) * projects.size * Math.max(1, months.size) * ubiquityPenalty;
    scored.push({
      key,
      th,
      projects: [...projects],
      months: [...months].sort(),
      sids: [...sids],
      score
    });
  }
  scored.sort((a, b) => b.score - a.score);
  // Two-axis diversity so the arc set tells DIFFERENT stories:
  //  1. session-overlap: skip a thread whose sessions ⊃/⊂ an already-picked one.
  //  2. token saturation: skip a thread that introduces no NEW significant word
  //     — this collapses the "file navigation / directory listing / file reading"
  //     family (distinct concepts, one narrative) once its words are spent.
  const STOP = new Set([
    "with",
    "from",
    "this",
    "that",
    "into",
    "over",
    "based",
    "using",
    "system"
  ]);
  const sigTokens = (name) =>
    norm(name)
      .split(" ")
      .filter((w) => w.length >= 4 && !STOP.has(w));
  const tokenUse = new Map(); // token → # picked threads using it
  const picked = [];
  for (const s of scored) {
    const sset = new Set(s.sids);
    const overlap = picked.some((p) => {
      const inter = p.sids.filter((x) => sset.has(x)).length;
      return inter / Math.min(p.sids.length, s.sids.length) > 0.7;
    });
    if (overlap) continue;
    const toks = sigTokens(s.th.display);
    // Redundant if every one of its significant words is already saturated
    // (used by ≥2 picked threads) — it brings no fresh narrative axis.
    const bringsNew = toks.some((t) => (tokenUse.get(t) || 0) < 2);
    if (toks.length && !bringsNew) continue;
    picked.push(s);
    for (const t of toks) tokenUse.set(t, (tokenUse.get(t) || 0) + 1);
    if (picked.length >= limit) break;
  }
  return picked;
}

async function narrateArc(sel) {
  // Deterministic chronological beats — the model narrates these, never invents.
  const beats = sel.th.touchpoints
    .filter((t) => t.ts)
    .sort((a, b) => a.ts - b.ts)
    .map((t) => ({ month: t.month, project: t.project, sid: t.sid, what: t.snippet }));
  // Collapse consecutive beats in the same project/month so the spine reads as
  // movement, not a log; keep the sid list for citation.
  const compact = [];
  for (const b of beats) {
    const last = compact[compact.length - 1];
    if (last && last.month === b.month && last.project === b.project) {
      last.sids.push(b.sid);
    } else {
      compact.push({ month: b.month, project: b.project, sids: [b.sid], what: b.what });
    }
  }
  const user = [
    `## Thread\n${sel.th.display}`,
    `## Touches ${sel.sids.length} sessions across ${sel.projects.length} projects (${sel.months.join(" → ")})`,
    `## Chronological beats (narrate THESE — do not invent projects or sids)\n${compact
      .map((b) => `- ${b.month} · ${b.project} · (sids: ${b.sids.join(", ")}) — ${b.what}`)
      .join("\n")}`
  ].join("\n\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const started = Date.now();
    const res = await chat({
      system: prompt("arc_narrate"),
      user: user + (attempt ? "\n\nReturn ONLY the JSON object, compact." : ""),
      maxTokens: 900,
      temperature: attempt === 0 ? 0.5 : 0.3,
      json: true
    });
    const parsed = lastBalancedJson(res.content) ?? repairTruncatedJson(res.content);
    appendLedger({
      phase: "opus",
      artifact: `arc:${sel.key.slice(0, 24)}`,
      ms: Date.now() - started,
      ok: Boolean(parsed?.title)
    });
    if (parsed?.title) {
      return {
        key: sel.key,
        title: parsed.title,
        thread: sel.th.display,
        thesis: parsed.thesis || "",
        turn: parsed.turn || "",
        projects: sel.projects,
        months: sel.months,
        sids: sel.sids,
        beats: compact
      };
    }
  }
  // Fall back to a deterministic arc so a flaky call never loses the thread.
  return {
    key: sel.key,
    title: `The arc of ${sel.th.display}`,
    thread: sel.th.display,
    thesis: `How ${sel.th.display} evolved across ${sel.projects.join(", ")}.`,
    turn: "",
    projects: sel.projects,
    months: sel.months,
    sids: sel.sids,
    beats: compact
  };
}

// Public: build (or resume) arcs.json. Resume-safe — a complete file is reused.
export async function buildArcs({ interrupted = () => false, limit = null } = {}) {
  const arcsPath = workspaceDir("data_out", ...config.OPUS_DIR.split("/"), "arcs.json");
  const existing = readJSON(arcsPath);
  if (existing?.arcs?.length) {
    console.log(`[opus] arcs: reusing ${existing.arcs.length} planned arcs`);
    return existing;
  }
  const n = Number(limit) || Number(config.OPUS_ARCS) || 12;
  console.log(`[opus] arcs: walking cards for cross-project threads…`);
  const threads = threadIndex();
  const selected = selectThreads(threads, n);
  console.log(
    `[opus] arcs: ${threads.size} threads → ${selected.length} span the journey (≥2 sessions, ≥2 projects)`
  );
  const arcs = [];
  for (const sel of selected) {
    if (interrupted()) break;
    const arc = await narrateArc(sel);
    arcs.push(arc);
    console.log(
      `[opus] arc: ${arc.title} — ${arc.projects.length} projects, ${arc.sids.length} sids`
    );
  }
  const out = { generated: new Date().toISOString(), model: config.LONGVIEW_MODEL, arcs };
  fs.mkdirSync(path.dirname(arcsPath), { recursive: true });
  fs.writeFileSync(arcsPath, JSON.stringify(out, null, 2));
  return out;
}

// Assign arcs to a chapter by matching the arc's projects/thread against the
// chapter's declared projects/motifs/title. Deterministic; each chapter gets
// the ≤2 most-relevant arcs so a section prompt stays budget-safe.
export function arcsForChapter(ch, arcs) {
  const hay = norm(
    [ch.title, ch.brief, (ch.projects || []).join(" "), (ch.motifs || []).join(" ")].join(" ")
  );
  const scored = arcs
    .map((a) => {
      let score = 0;
      if (hay.includes(norm(a.thread))) score += 3;
      for (const p of a.projects) if (hay.includes(norm(p))) score += 1;
      return { a, score };
    })
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score);
  return scored.slice(0, 2).map((x) => x.a);
}

// Compact arc context for a section prompt: thesis + the real sids to cite.
export function arcBriefs(arcList) {
  if (!arcList?.length) return "";
  return arcList
    .map(
      (a) =>
        `### Arc: ${a.title}\n${a.thesis}${a.turn ? ` The turn: ${a.turn}` : ""}\nConnect these across time — cite their sids: ${a.beats
          .map((b) => `${b.project} (sids: ${b.sids.slice(0, 2).join(", ")})`)
          .join(" → ")}`
    )
    .join("\n\n");
}
