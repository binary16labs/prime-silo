// Phase B: deterministic evidence packs (ADR-005 §2). Selection order is
// artifacts (the distilled signal) → user inputs (intent) → thoughts/results
// (color), truncated into the configured budget so per-card latency stays
// bounded on a 9B model.
import fs from "fs";
import path from "path";
import { config } from "./config.mjs";
import { readTimeline } from "./store.mjs";

const clip = (s, n) => {
  s = (s || "").trim();
  return s.length > n ? s.slice(0, n) + " …[clipped]" : s;
};

export function buildEvidencePack(session) {
  const timeline = readTimeline(session.id);
  const artifacts = [];
  const userInputs = [];
  const thoughts = [];
  const toolCounts = new Map();
  const filesTouched = new Set();
  let firstTs = session.timestamp || 0;
  let lastTs = session.timestamp || 0;

  for (const e of timeline) {
    if (e.timestamp) {
      if (!firstTs || e.timestamp < firstTs) firstTs = e.timestamp;
      if (e.timestamp > lastTs) lastTs = e.timestamp;
    }
    switch (e.type) {
      case "Artifact":
        artifacts.push({ name: e.metadata?.fileName || "artifact.md", content: e.content || "" });
        break;
      case "User Input":
        if (e.content) userInputs.push(e.content);
        break;
      case "Thought":
        if (e.content) thoughts.push(e.content);
        break;
      case "Tool Call": {
        const t = e.metadata?.toolName || "tool";
        toolCounts.set(t, (toolCounts.get(t) || 0) + 1);
        if (e.metadata?.fileName) filesTouched.add(e.metadata.fileName);
        break;
      }
      default:
        break;
    }
  }

  // Antigravity sessions whose transcript was never parsed still have their
  // brain markdown on disk — pull it straight from the session folder.
  if (artifacts.length === 0 && session.metadata?.sessionPath) {
    try {
      for (const f of fs.readdirSync(session.metadata.sessionPath)) {
        if (f.endsWith(".md")) {
          artifacts.push({
            name: f,
            content: fs.readFileSync(path.join(session.metadata.sessionPath, f), "utf8")
          });
        }
      }
    } catch {
      /* folder gone — evidence stays what the store had */
    }
  }

  const fmt = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : "unknown");
  let budget = config.EVIDENCE_BUDGET_CHARS;
  const sections = [];
  const push = (text) => {
    if (budget <= 0 || !text) return;
    const t = clip(text, budget);
    sections.push(t);
    budget -= t.length;
  };

  push(
    `# Session: ${clip(session.content || session.id, 150)}\n` +
      `- agent: ${session.agent || "unknown"}\n` +
      `- project: ${session.metadata?.project || session.metadata?.cwd || "unknown"}\n` +
      `- period: ${fmt(firstTs)} → ${fmt(lastTs)}\n` +
      `- events: ${timeline.length - 1}`
  );

  // The store can hold the same artifact more than once (re-syncs); keep the
  // longest copy per file name.
  const byName = new Map();
  for (const a of artifacts) {
    const prev = byName.get(a.name);
    if (!prev || (a.content || "").length > (prev.content || "").length) byName.set(a.name, a);
  }
  const uniqueArtifacts = [...byName.values()];

  if (uniqueArtifacts.length) {
    push(`\n## Agent artifacts (distilled by the agent during the session)`);
    const per = Math.max(700, Math.floor((budget * 0.55) / uniqueArtifacts.length));
    for (const a of uniqueArtifacts.slice(0, 6)) push(`\n### ${a.name}\n${clip(a.content, per)}`);
  }

  if (userInputs.length) {
    push(`\n## Operator inputs (${userInputs.length} total)`);
    const per = Math.max(300, Math.floor((budget * 0.7) / Math.min(userInputs.length, 12)));
    for (const u of userInputs.slice(0, 12)) push(`\n> ${clip(u, per)}`);
  }

  if (toolCounts.size || filesTouched.size) {
    const tools = [...toolCounts.entries()].map(([k, v]) => `${k}×${v}`).join(", ");
    push(
      `\n## Activity\n- tools: ${tools || "n/a"}\n- files touched: ${[...filesTouched]
        .slice(0, 25)
        .join(", ")}`
    );
  }

  if (thoughts.length && budget > 400) {
    push(`\n## Agent reasoning (first and last)`);
    push(`\n${clip(thoughts[0], Math.floor(budget * 0.4))}`);
    if (thoughts.length > 1) push(`\n${clip(thoughts[thoughts.length - 1], budget)}`);
  }

  const pack = sections.join("\n");
  return {
    pack,
    signalChars: pack.length,
    artifactNames: uniqueArtifacts.map((a) => a.name),
    firstTs,
    lastTs,
    project: session.metadata?.project || null
  };
}
