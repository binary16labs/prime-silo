// Phase B-Bridge — Benny context provider.
//
// The Bridge cockpit composes the whole cognitive mesh onto one page. Benny
// (the onscreen agent) sits in the right-hand dock; this module is the bridge
// between what's on the stage and what Benny knows. It keeps a compact,
// current-state snapshot — {mode, selection, workspace, lastRun, conformance} —
// and:
//
//   • publishes it on globalThis.__bennyBridgeContext so the `benny-pilot`
//     skill (and tests) read the same truth the page sees;
//   • composes a grounded prompt for a suggestion chip (the instruction plus a
//     short context line plus the deep link) and dispatches it to Benny via the
//     onscreen-agent runtime (space.onscreenAgent.submitPrompt).
//
// Why compose context into the prompt rather than poke the agent's private
// store: the public onscreen-agent surface is submitPrompt(text). Embedding the
// context inline keeps this decoupled from store internals, works with the
// local Lemonade model the same as a cloud model, and is trivially testable by
// injecting a stub agent.

const GLOBAL_KEY = "__bennyBridgeContext";
const ROUTE = "#/_prime_silo/bridge";
const SKILL_IMPORT = "/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js";

/**
 * Pre-fetch a concise live-data summary for the current mode. Returns a short
 * string (or null on any error/empty result). Embedded directly in the
 * dispatched prompt so the model is grounded in real numbers even without
 * executing code — this also sidesteps the window-context mismatch where
 * Benny's execution sandbox runs in the shell window rather than the Bridge
 * iframe window, which causes readContext() inside Benny's code to return null.
 */
async function fetchModeData(currentState) {
  try {
    const pilot = await import(SKILL_IMPORT);
    const mode = currentState.mode || "pulse";
    const workspace = currentState.workspace || "default";

    if (mode === "code") {
      const graph = await pilot.codeGraph(workspace);
      const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];
      const edges = Array.isArray(graph && graph.edges) ? graph.edges : [];
      if (!nodes.length) {
        return `Code graph for workspace "${workspace}" has 0 nodes — not yet populated (run a Tree-Sitter scan via benny enrich to seed it).`;
      }
      const byType = {};
      nodes.forEach((n) => {
        const t = n.type || "unknown";
        byType[t] = (byType[t] || 0) + 1;
      });
      const typeSummary = Object.entries(byType)
        .map(([t, c]) => `${c} ${t}`)
        .join(", ");
      const selNote =
        currentState.selection && currentState.selection.id
          ? ` Selected node: "${currentState.selection.label || currentState.selection.id}".`
          : " No node selected.";
      return `Code graph (workspace "${workspace}"): ${nodes.length} nodes (${typeSummary}), ${edges.length} edges.${selNote}`;
    }

    if (mode === "documents") {
      const stats = await pilot.knowledgeStats(workspace);
      const nodeTypes = (stats && stats.node_types) || {};
      const docCount = nodeTypes.Document || nodeTypes.Source || 0;
      const conceptCount = nodeTypes.Concept || 0;
      if (!docCount && !conceptCount) {
        return `Documents: the knowledge graph for workspace "${workspace}" is empty — ingest documents from the Documents stage (or run benny enrich) to populate it.`;
      }
      let sources = [];
      try {
        sources = await pilot.documentSources(workspace);
      } catch {
        /* counts are enough */
      }
      const sample = sources.slice(0, 5).join(", ");
      const more = sources.length > 5 ? `, +${sources.length - 5} more` : "";
      const sel =
        currentState.selection && currentState.selection.id
          ? ` Selected concept: "${currentState.selection.label || currentState.selection.id}".`
          : "";
      return `Documents (workspace "${workspace}"): ${docCount} source document(s) → ${conceptCount} concept(s).${sources.length ? ` Sources include: ${sample}${more}.` : ""}${sel}`;
    }

    if (mode === "memory") {
      const sessions = await pilot.recentSessions({ limit: 5 });
      const arr = Array.isArray(sessions) ? sessions : [];
      if (!arr.length) return "Memory: no sessions found in Memo-Ray (Memo-Ray may be offline).";
      const selId = currentState.selection && currentState.selection.id;
      if (selId) {
        // A session is selected — lead with it so Benny focuses on what the
        // operator is actually looking at, not a random "latest" session.
        const sel = arr.find((s) => s.id === selId) || arr[0];
        const others = arr.filter((s) => s.id !== sel.id).slice(0, 3);
        const othersTxt = others.length
          ? ` Other visible sessions: ${others.map((s) => `"${s.title || "Untitled"}" (${s.agent || "—"})`).join("; ")}.`
          : "";
        return (
          `Memory — selected session: "${sel.title || "Untitled"}" ` +
          `(id: ${sel.id}, agent: ${sel.agent || "—"}` +
          `${sel.project ? `, project: ${sel.project}` : ""}` +
          `${sel.timestamp ? `, recorded: ${sel.timestamp}` : ""}).` +
          othersTxt
        );
      }
      // Nothing selected — describe the recent list and invite the operator to
      // click a session in the sidebar.
      const s = arr[0];
      return `Memory: ${arr.length} recent sessions. Latest: "${s.title || "Untitled"}" (agent: ${s.agent || "—"}${s.project ? `, project: ${s.project}` : ""}). No session selected — click one in the sidebar to focus on it.`;
    }

    if (mode === "runs") {
      const allRuns = await pilot.runs(5);
      const arr = Array.isArray(allRuns) ? allRuns : [];
      if (!arr.length) return "Runs: no run history found yet.";
      const selId = currentState.selection && currentState.selection.id;
      if (selId) {
        const sel = arr.find((r) => r.runId === selId) || arr[0];
        const others = arr.filter((r) => r.runId !== sel.runId).slice(0, 3);
        const othersTxt = others.length
          ? ` Other runs visible: ${others.map((r) => `${String(r.runId || "").slice(0, 12)} (${r.status || "unknown"})`).join("; ")}.`
          : "";
        return (
          `Runs — selected run: ${String(sel.runId || "").slice(0, 16)} (status: ${sel.status || "unknown"}` +
          `${sel.requirement ? `, requirement: "${sel.requirement.slice(0, 80)}"` : ""}).` +
          othersTxt
        );
      }
      const r = arr[0];
      return `Runs: ${arr.length} recent. Latest: ${String(r.runId || "").slice(0, 16)} (status: ${r.status || "unknown"}${r.requirement ? `, requirement: "${r.requirement.slice(0, 60)}"` : ""}).`;
    }

    if (mode === "pulse") {
      const feed = await pilot.lifelog(5);
      const arr = Array.isArray(feed) ? feed : [];
      if (!arr.length) return "Pulse: no recent activity in the lifelog.";
      return `Pulse: ${arr.length} recent items. Latest: "${String(arr[0].content || "").slice(0, 80)}".`;
    }

    if (mode === "v2") {
      // Governance V2 — the page blends sessions + pipeline runs into one
      // risk-scored, filtered, step-through view. Pull context from both.
      const pc = currentState.pageContext || {};
      const gov = pc.governance || {};

      // 1. Active run / session
      const activeId = gov.activeRunId || currentState.lastRun || null;
      if (!activeId) {
        const summary = gov.summary || {};
        return (
          `Governance V2: no run selected. ` +
          `Showing ${summary.totalVisible ?? "?"} items ` +
          `(filter: ${summary.filter || "all"}, sort: ${summary.sort || "weight"}).`
        );
      }

      const type = gov.activeType || "unknown"; // 'session' | 'run' | 'unknown'
      const status = gov.activeStatus || "unknown";
      const riskWeight = gov.activeRiskWeight != null ? `${gov.activeRiskWeight}%` : "N/A";
      const errCount = gov.activeErrCount != null ? gov.activeErrCount : "?";
      const duration = gov.activeDuration || "N/A";
      const stepIndex = gov.stepIndex != null ? gov.stepIndex : 0;
      const stepTotal = gov.stepTotal != null ? gov.stepTotal : "?";
      const filter = gov.filter || "all";
      const sort = gov.sort || "weight";
      const totalVisible = gov.summary?.totalVisible ?? "?";
      const totalFailures = gov.summary?.totalFailures ?? "?";

      let line =
        `Governance V2 — active ${type}: ${String(activeId).slice(0, 16)} ` +
        `(status: ${status}, risk weight: ${riskWeight}, errors: ${errCount}, duration: ${duration}). ` +
        `Step-through: step ${stepIndex} of ${stepTotal}. ` +
        `Navigator: ${totalVisible} items visible (filter: ${filter}, sort: ${sort}, ${totalFailures} failures).`;

      // Append node_states summary if available (pipeline run detail).
      if (gov.nodeStatesSummary) {
        line += ` Steps: ${gov.nodeStatesSummary}.`;
      }
      return line;
    }

    // Page-specific extra context pushed by the Bridge page. When a mode-specific
    // block above already returned, we never reach here; when no mode matched or
    // pageContext supplements are set, use them as the live-data string.
    if (currentState.pageContext) {
      const extra = JSON.stringify(currentState.pageContext).slice(0, 400);
      return `Page context: ${extra}`;
    }

    return null;
  } catch {
    return null; // runtime down, wrong environment, skill not found — fail silently
  }
}

/** Deep link back into the Bridge for a given snapshot (mode + optional id). */
export function bridgeDeepLink(state = {}) {
  const params = new URLSearchParams();
  if (state.mode) params.set("mode", state.mode);
  if (state.selection && state.selection.id) params.set("id", state.selection.id);
  const qs = params.toString();
  return qs ? `${ROUTE}?${qs}` : ROUTE;
}

function selectionLabel(selection) {
  if (!selection) return "";
  return selection.label || selection.title || selection.id || "";
}

/**
 * Build the one-line context suffix appended to every dispatched chip prompt.
 * Kept terse on purpose — small local models have a tight prompt budget.
 */
export function describeContext(state = {}) {
  const parts = [`mode: ${state.mode || "pulse"}`];
  const label = selectionLabel(state.selection);
  if (label) {
    // Include the id alongside the label when available so Benny can look
    // up the selected item directly without guessing.
    const idSuffix = state.selection && state.selection.id ? ` (id: ${state.selection.id})` : "";
    parts.push(`selected: ${label}${idSuffix}`);
  }
  if (state.workspace) parts.push(`workspace: ${state.workspace}`);
  if (state.lastRun) parts.push(`last run: ${state.lastRun}`);
  if (state.conformance) parts.push(`conformance: ${state.conformance}`);
  return parts.join(", ");
}

/**
 * Compose the grounded prompt for an instruction. The instruction is the
 * human-facing chip intent ("Explain what I'm looking at"); we append the live
 * context and the import line for the benny-pilot helper. The skill is loaded
 * programmatically before dispatch (see dispatch()), so by the time Benny reads
 * this the helpers are available — no "please load" dance needed.
 */
export function composePrompt(instruction, state = {}, liveData = null) {
  const ctx = describeContext(state);
  const link = bridgeDeepLink(state);
  const lines = [
    String(instruction || "").trim(),
    "",
    `(Bridge context — ${ctx}. Deep link: ${link}.`
  ];
  if (liveData) lines.push(`Live data: ${liveData}`);
  lines.push(
    `The benny-pilot skill is loaded — use \`const pilot = await import("${SKILL_IMPORT}")\` to access mesh helpers: readContext, lifelog, codeGraph, recentSessions, runs, search. Answer from actual live data, not hypothetically.)`
  );
  return lines.join("\n");
}

/**
 * Create a context controller for the page.
 *
 * @param {{ agent?: { submitPrompt: Function }, globalTarget?: object }} [options]
 *   options.agent       — onscreen-agent surface (defaults to space.onscreenAgent).
 *   options.globalTarget — where to publish the snapshot (defaults to globalThis).
 */
export function createBridgeContext(options = {}) {
  const globalTarget = options.globalTarget || globalThis;
  let state = {
    mode: "pulse",
    selection: null,
    workspace: "default",
    lastRun: null,
    conformance: "",
    // Page-specific structured payload. Each Bridge page can call
    // ctx.set({ pageContext: { … } }) to inject richer per-mode context
    // (e.g. Memory pushes selected session metadata, Runs pushes run detail).
    // fetchModeData appends it to the live-data string when present.
    pageContext: null
  };

  function resolveAgent() {
    if (options.agent) return options.agent;
    const space =
      globalTarget.space || (typeof globalThis !== "undefined" ? globalThis.space : null);
    return space && space.onscreenAgent ? space.onscreenAgent : null;
  }

  function snapshot() {
    return {
      ...state,
      selection: state.selection ? { ...state.selection } : null,
      route: bridgeDeepLink(state)
    };
  }

  function publish() {
    try {
      globalTarget[GLOBAL_KEY] = snapshot();
    } catch {
      /* publishing is best-effort */
    }
  }

  function set(patch = {}) {
    state = { ...state, ...patch };
    publish();
    return snapshot();
  }

  // Load benny-pilot before every dispatch so the skill is already in Benny's
  // context when the prompt arrives — rather than asking Benny in text to load
  // it (which produces the "I haven't loaded the skill yet" refusal).
  async function ensureBennyPilotLoaded() {
    try {
      const space =
        globalTarget.space || (typeof globalThis !== "undefined" ? globalThis.space : null);
      if (space && space.skills && typeof space.skills.load === "function") {
        await space.skills.load("benny-pilot");
      }
    } catch {
      // Swallow — skill runtime may not be installed yet (e.g. in tests).
      // The prompt still carries the import path as a fallback.
    }
  }

  async function dispatch(instruction) {
    await ensureBennyPilotLoaded();
    const liveData = await fetchModeData(state);
    const prompt = composePrompt(instruction, state, liveData);
    const agent = resolveAgent();
    if (!agent || typeof agent.submitPrompt !== "function") {
      return { ok: false, reason: "agent_unavailable", prompt };
    }
    await agent.submitPrompt(prompt);
    return { ok: true, prompt };
  }

  publish();

  return {
    set,
    snapshot,
    dispatch,
    composePrompt: (instruction) => composePrompt(instruction, state),
    get state() {
      return snapshot();
    }
  };
}

export const __testing = { GLOBAL_KEY, ROUTE, SKILL_IMPORT };
