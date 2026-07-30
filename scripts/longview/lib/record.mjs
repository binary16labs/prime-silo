// Benny Record (ADR-005 observability) — turn the pipeline's audit trail
// (ledger.jsonl + provenance meta files + window manifests + memo-ray store)
// into (a) an ordered, human-captioned action timeline (the step_through shape)
// and (b) a lineage tree for the map pane. Deterministic: sorted inputs only.
import fs from "fs";
import path from "path";
import { config, workspaceDir, stateDir } from "./config.mjs";
import { readLedger } from "./ledger.mjs";

const readJson = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const sid8 = (id) => String(id).slice(0, 8);

function caption(e) {
  if (e.action === "run_config")
    return `Run pinned: commit ${e.git_commit}, model ${e.model}, ctx ${e.ctx_size}`;
  if (e.phase === "map" && e.status === "ok")
    return `Mapped session ${sid8(e.session_id)} into a card (${e.retries ? "retry" : "clean"}, ${Math.round((e.ms || 0) / 1000)}s)`;
  if (e.phase === "map" && e.status === "failed")
    return `Card for ${sid8(e.session_id)} failed the gate: ${(e.gate_errors || []).join("; ").slice(0, 120)}`;
  if (e.phase === "review" && e.status === "ok")
    return `Reviewed ${sid8(e.session_id)} against the graph (${(e.related_concepts || []).length} cross-session concepts)`;
  if (e.phase === "opus" && /^section:/.test(e.artifact || ""))
    return `${e.ok === false ? "Draft kept but gate-failed" : "Wrote"} book ${e.artifact} (${e.words || "?"} words, ${e.citations ?? "?"} citations)`;
  if (e.phase === "opus" && e.artifact === "coverage")
    return `Book coverage: ${Math.round((e.citation_coverage || 0) * 100)}% of sessions cited`;
  if (e.action === "phase_error")
    return `Phase ${e.phase} errored (isolated): ${String(e.error || "").slice(0, 100)}`;
  if (e.artifact) return `Produced ${e.artifact}${e.ok === false ? " (FAILED)" : ""}`;
  return `${e.phase || "step"}: ${e.status || e.action || "event"}`;
}

const WHY = {
  map: "Distill each session's timeline into a gated card via short graph-walk windows.",
  model: "Ingest cards into the knowledge graph (deep synthesis).",
  code: "Scan the repo into the code graph and correlate it to concepts.",
  weave: "Ask what is under-explored; answer from retrieval; re-ingest the notes.",
  enrich: "Merge duplicate concepts, add cross-document links, type relations, name themes.",
  review: "Re-visit each session against the built graph — the collation pass.",
  reduce: "Fold cards into dossiers, themes, timeline and reports.",
  opus: "Write the book: retrieval-grounded, gated, cited sections.",
  pdf: "Typeset the assembled book.",
  run: "Pin the run to an exact configuration."
};

export function recordFor(scope) {
  const ledger = readLedger();
  const [kind, ref] = scope.includes(":") ? scope.split(":", 2) : [scope, null];
  const match = (e) => {
    if (kind === "run") return true;
    if (kind === "card") return String(e.session_id || "").startsWith(ref);
    if (kind === "review")
      return e.phase === "review" && String(e.session_id || "").startsWith(ref);
    if (kind === "section") return e.artifact === `section:${ref}`;
    if (kind === "book") return e.phase === "opus" || e.phase === "pdf";
    if (kind === "dossier") return String(e.artifact || "").startsWith(`dossier:${ref}`);
    return false;
  };
  const actions = ledger.filter(match).map((e, i) => ({
    n: i,
    type: e.action || e.phase || "event",
    caption: caption(e),
    why: WHY[e.phase] || WHY[e.action] || "",
    content: e,
    ts: e.ts || null,
    ms: e.ms || null,
    tokens: (e.prompt_tokens || 0) + (e.completion_tokens || 0) || null,
    nodeId: e.session_id
      ? `card:${sid8(e.session_id)}`
      : e.artifact
        ? `art:${e.artifact}`
        : `phase:${e.phase}`
  }));
  return { scope, workspace: config.WORKSPACE, actions };
}

export function lineageFor(scope) {
  const [kind, ref] = scope.includes(":") ? scope.split(":", 2) : [scope, null];
  const nodes = [];
  const links = [];
  const seen = new Set();
  const add = (id, type, label, depth, meta = {}) => {
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({ id, type, label, depth, meta });
    }
    return id;
  };
  const link = (a, b) => links.push({ source: a, target: b });

  const cardLineage = (sidPrefix, depth) => {
    const dir = stateDir("cards");
    const f = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find(
      (x) => x.startsWith(sidPrefix) && x.endsWith(".json") && !x.endsWith(".meta.json")
    );
    if (!f) return null;
    const sid = f.replace(/\.json$/, "");
    const card = readJson(path.join(dir, f)) || {};
    const cardId = add(
      `card:${sid8(sid)}`,
      "Card",
      `${card.project || "card"} (${sid8(sid)})`,
      depth,
      {
        meta: readJson(path.join(dir, `${sid}.meta.json`))
      }
    );
    const man = readJson(stateDir("windows", sid, "manifest.json"));
    if (man) {
      const wId = add(
        `windows:${sid8(sid)}`,
        "Windows",
        `${man.windows.length} windows over ${man.step_count} steps`,
        depth + 1,
        man
      );
      link(cardId, wId);
    }
    const entity = readJson(path.join(config.MEMORAY_DATA_DIR, "entities", `${sid}.json`));
    const sesId = add(
      `session:${sid8(sid)}`,
      "Session",
      entity ? `${entity.agent}: ${(entity.content || "").slice(0, 60)}` : `session ${sid8(sid)}`,
      depth + 2,
      {
        session_id: sid,
        log_path: entity?.metadata?.filePath || null
      }
    );
    link(cardId, sesId);
    return cardId;
  };

  if (kind === "card" || kind === "review") {
    add(`root:${scope}`, "Artifact", scope, 0);
    const c = cardLineage(ref, 1);
    if (c) link(`root:${scope}`, c);
  } else if (kind === "section") {
    const meta = readJson(workspaceDir("data_out", "opus", "sections", `${ref}.meta.json`)) || {};
    const rootId = add(`section:${ref}`, "Section", `§${ref}`, 0, meta);
    for (const s of meta.evidence_sources || []) {
      if (s.kind === "graph") {
        const cId = add(`concept:${s.source}`, "Concept", s.source, 1, {});
        link(rootId, cId);
      } else {
        const m = String(s.source || "").match(/longview_(?:card|review)_([a-z0-9]{8})/i);
        if (m) {
          const c = cardLineage(m[1], 2);
          const eId = add(`doc:${s.source}`, "Evidence", s.source, 1, {});
          link(rootId, eId);
          if (c) link(eId, c);
        } else {
          link(rootId, add(`doc:${s.source}`, "Evidence", String(s.source), 1, {}));
        }
      }
    }
    for (const sid of meta.cited_sids || []) {
      const c = cardLineage(sid, 2);
      if (c) link(rootId, c);
    }
    for (const con of meta.cited_concepts || [])
      link(rootId, add(`concept:${con}`, "Concept", con, 1, {}));
  } else if (kind === "dossier") {
    const p = workspaceDir("data_out", "dossiers", `${ref}.md`);
    const rootId = add(`dossier:${ref}`, "Dossier", ref, 0, readJson(p + ".meta.json") || {});
    const dir = stateDir("cards");
    for (const f of (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
      .filter((x) => x.endsWith(".json") && !x.endsWith(".meta.json"))
      .sort()) {
      const card = readJson(path.join(dir, f)) || {};
      if (
        String(card.project || "").toLowerCase() === ref.replace(/_/g, " ").toLowerCase() ||
        String(card.project || "").toLowerCase() === ref.toLowerCase()
      ) {
        const c = cardLineage(f.slice(0, 8), 1);
        if (c) link(rootId, c);
      }
    }
  } else {
    // book / run: parts → chapters → sections (lineage per section on demand)
    const outline = readJson(workspaceDir("data_out", "opus", "outline.json")) || { parts: [] };
    const rootId = add("book", "Book", outline.title || "Book", 0, {});
    for (const part of outline.parts || []) {
      const pId = add(`part:${part.n}`, "Part", part.title, 1, {});
      link(rootId, pId);
      for (const ch of part.chapters || []) {
        const cId = add(`chapter:${ch.n}`, "Chapter", ch.title, 2, { reflection: !!ch.reflection });
        link(pId, cId);
        for (const s of ch.sections || [])
          link(cId, add(`section:${s.id}`, "Section", s.title, 3, {}));
      }
    }
  }
  return { scope, nodes, links };
}
