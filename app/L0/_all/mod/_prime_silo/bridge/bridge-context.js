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
  const sel = selectionLabel(state.selection);
  if (sel) parts.push(`selected: ${sel}`);
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
export function composePrompt(instruction, state = {}) {
  const ctx = describeContext(state);
  const link = bridgeDeepLink(state);
  return [
    String(instruction || "").trim(),
    "",
    `(Bridge context — ${ctx}. Deep link: ${link}.`,
    `The benny-pilot skill is loaded — use \`const pilot = await import("${SKILL_IMPORT}")\` to access mesh helpers: readContext, lifelog, codeGraph, recentSessions, runs, search.)`
  ].join("\n");
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
    conformance: ""
  };

  function resolveAgent() {
    if (options.agent) return options.agent;
    const space = globalTarget.space || (typeof globalThis !== "undefined" ? globalThis.space : null);
    return space && space.onscreenAgent ? space.onscreenAgent : null;
  }

  function snapshot() {
    return { ...state, selection: state.selection ? { ...state.selection } : null, route: bridgeDeepLink(state) };
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
      const space = globalTarget.space ||
        (typeof globalThis !== "undefined" ? globalThis.space : null);
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
    const prompt = composePrompt(instruction, state);
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
