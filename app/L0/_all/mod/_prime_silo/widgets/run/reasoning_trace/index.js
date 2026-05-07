// ADR-001 Phase C — `run.reasoning_trace` widget.
//
// Read-only inspector that surfaces the per-node LLM reasoning trace for a
// studio run. Reasoning is captured by `extract_reasoning()` inside
// `studio_executor.execute_llm_node` and persisted as the `reasoning_trace`
// field of each NODE_EXECUTION_STATE governance event's `outputs`. This
// widget reuses the existing `/governance/events` endpoint instead of a new
// one — keeps the runtime surface small and matches lineage_timeline's
// pattern.
//
// Public API
//   createReasoningTraceWidget(host, props, options)
//     props   — {
//       run_id: string,        // required (studio execution id)
//       workspace?: string,    // default "default"
//       node_id?: string,      // when set, filters to a single node
//       limit?: number         // default 200; cap on events scanned
//     }
//     options — { runtimeClient?: { runtimeFetch, readRuntimeJson } }
//
// Returns { update, refresh, destroy, get traces, get rawEvents } so the
// layout can re-pin to a different run/node and trigger a manual reload.
//
// Rendering: vertical stack, one card per node that produced reasoning.
// Each card shows node_id, status chip, timestamp, duration, and the
// reasoning body in a `<pre>` with line-wrapping. Nodes without a
// reasoning_trace are skipped — the widget is *for* surfacing thinking,
// not enumerating every node (lineage_timeline already does that).

import {
  runtimeFetch,
  readRuntimeJson
} from "../../../runtime_client/runtime-client.js";

const STATE_LOADING = "loading";
const STATE_READY = "ready";
const STATE_ERROR = "error";

const HTML_ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function buildEventsPath(props) {
  const params = new URLSearchParams();
  params.set("workspace", props.workspace || "default");
  params.set("run_id", props.run_id);
  params.set("event_type", "NODE_EXECUTION_STATE");
  params.set("limit", String(typeof props.limit === "number" ? props.limit : 200));
  return `/governance/events?${params.toString()}`;
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, readRuntimeJson };
}

function extractTraces(events, props) {
  const targetNode = props && props.node_id;
  const traces = [];
  for (const event of events || []) {
    const data = (event && event.data) || {};
    const outputs = (data && data.outputs) || {};
    const reasoning = outputs.reasoning_trace;
    if (!reasoning || typeof reasoning !== "string" || !reasoning.trim()) {
      continue;
    }
    const nodeId = data.node_id || event.node_id || "(unknown)";
    if (targetNode && nodeId !== targetNode) {
      continue;
    }
    traces.push({
      node_id: nodeId,
      status: data.status || "unknown",
      timestamp: data.timestamp || event.timestamp || null,
      duration_ms: typeof data.duration_ms === "number" ? data.duration_ms : null,
      reasoning: reasoning.trim(),
      response: typeof outputs.response === "string" ? outputs.response : null
    });
  }
  return traces;
}

function renderStatusChip(status) {
  const cls = status === "completed" || status === "success"
    ? "prime-silo-rt__status--ok"
    : status === "failed" || status === "error"
      ? "prime-silo-rt__status--err"
      : "prime-silo-rt__status--neutral";
  return `<span class="prime-silo-rt__status ${cls}" data-status="${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

function renderDuration(ms) {
  if (ms == null) {
    return "";
  }
  const seconds = ms / 1000;
  const text = seconds >= 1 ? `${seconds.toFixed(2)}s` : `${Math.round(ms)}ms`;
  return `<span class="prime-silo-rt__duration">${escapeHtml(text)}</span>`;
}

function renderTraceCard(trace) {
  const ts = trace.timestamp || "(no timestamp)";
  return `
    <li class="prime-silo-rt__trace" data-node-id="${escapeHtml(trace.node_id)}">
      <header class="prime-silo-rt__head">
        <code class="prime-silo-rt__node">${escapeHtml(trace.node_id)}</code>
        ${renderStatusChip(trace.status)}
        <time class="prime-silo-rt__time" datetime="${escapeHtml(ts)}">${escapeHtml(ts)}</time>
        ${renderDuration(trace.duration_ms)}
      </header>
      <pre class="prime-silo-rt__body">${escapeHtml(trace.reasoning)}</pre>
    </li>
  `;
}

function renderShell(traces, props) {
  if (traces.length === 0) {
    const scope = props.node_id
      ? `node <code>${escapeHtml(props.node_id)}</code> in run <code>${escapeHtml(props.run_id)}</code>`
      : `run <code>${escapeHtml(props.run_id)}</code>`;
    return `<div class="prime-silo-rt__empty">
      No reasoning trace recorded for ${scope}. The run may not have used an LLM node, or the model returned no &lt;think&gt; output.
    </div>`;
  }
  const head = `<div class="prime-silo-rt__summary">${traces.length} reasoning ${traces.length === 1 ? "trace" : "traces"} for run <code>${escapeHtml(props.run_id)}</code></div>`;
  return `${head}<ol class="prime-silo-rt__list">${traces.map(renderTraceCard).join("")}</ol>`;
}

function renderError(host, error) {
  const detail = (error && (error.body && error.body.detail || error.message)) || String(error);
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-rt__error">Reasoning load failed: ${escapeHtml(detail)}</div>`;
}

function renderLoading(host, props) {
  host.dataset.widgetState = STATE_LOADING;
  host.innerHTML = `<div class="prime-silo-rt__loading">Loading reasoning trace for run ${escapeHtml(props.run_id || "(none)")}…</div>`;
}

/**
 * Mount the reasoning-trace widget into `host`.
 */
export function createReasoningTraceWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createReasoningTraceWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  let props = { ...initialProps };
  let aborted = false;
  let lastTraces = [];
  let lastEvents = [];

  host.classList.add("prime-silo-rt");

  async function load() {
    if (!props.run_id) {
      renderError(host, new Error("reasoning_trace requires props.run_id"));
      return;
    }
    renderLoading(host, props);
    try {
      const response = await client.runtimeFetch(buildEventsPath(props));
      const payload = await client.readRuntimeJson(response);
      if (aborted) {
        return;
      }
      const events = (payload && Array.isArray(payload.events)) ? payload.events : [];
      const traces = extractTraces(events, props);
      lastEvents = events;
      lastTraces = traces;
      host.dataset.widgetState = STATE_READY;
      host.innerHTML = renderShell(traces, props);
    } catch (err) {
      if (aborted) {
        return;
      }
      renderError(host, err);
    }
  }

  function update(nextProps) {
    const merged = { ...props, ...nextProps };
    const queryChanged =
      merged.run_id !== props.run_id ||
      merged.workspace !== props.workspace ||
      merged.node_id !== props.node_id ||
      merged.limit !== props.limit;
    props = merged;
    if (queryChanged) {
      load();
    }
  }

  function refresh() {
    return load();
  }

  function destroy() {
    aborted = true;
    host.classList.remove("prime-silo-rt");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  load();

  return {
    update,
    refresh,
    destroy,
    get traces() {
      return lastTraces;
    },
    get rawEvents() {
      return lastEvents;
    }
  };
}

export const __testing = {
  buildEventsPath,
  extractTraces,
  renderTraceCard,
  renderShell,
  renderStatusChip,
  renderDuration
};
