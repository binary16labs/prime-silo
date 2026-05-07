// ADR-001 Phase C — `run.lineage_timeline` widget.
//
// Read-only timeline of triple-lineage events (process / skill / data /
// outcome) for a single run. First migrated widget that actually calls the
// runtime — uses `runtimeFetch` against the `/governance/events` endpoint,
// no agent scope header (this is human-driven inspection).
//
// Public API
//   createLineageTimelineWidget(host, props, options)
//     props   — {
//       run_id: string,           // required
//       workspace?: string,       // default "default"
//       limit?: number,           // default 100
//       eventType?: string        // optional filter (e.g. "AGENT_AUTHORSHIP")
//     }
//     options — { runtimeClient?: { runtimeFetch, readRuntimeJson } }
//
// Returns { update, refresh, destroy } so the layout can drive prop changes
// (run_id pinned to a different run) and trigger a manual reload after a
// new run completes.
//
// Rendering: vertical timeline. Each event becomes a row with a badge for
// the event type, a timestamp, and the triple breakdown (process / skill /
// data) when present. Missing fields render as `—` rather than throwing.

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

function emptyOrDash(value) {
  if (value == null || value === "") {
    return '<span class="prime-silo-lt__missing">—</span>';
  }
  return escapeHtml(value);
}

function buildEventsPath(props) {
  const params = new URLSearchParams();
  params.set("workspace", props.workspace || "default");
  params.set("run_id", props.run_id);
  if (props.eventType) {
    params.set("event_type", props.eventType);
  }
  if (typeof props.limit === "number") {
    params.set("limit", String(props.limit));
  }
  return `/governance/events?${params.toString()}`;
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, readRuntimeJson };
}

function pickTripleParts(event) {
  const data = (event && event.data) || {};
  const details = (data && data.details) || {};
  return {
    process: data.process || details.process || null,
    skill: data.skill || details.skill || null,
    data: data.data || details.data || data.sandbox_path || null,
    outcome: data.outcome || details.outcome || null
  };
}

function renderEvent(event) {
  const ts = event.timestamp || "(no timestamp)";
  const type = event.event_type || "EVENT";
  const triple = pickTripleParts(event);

  const integrity = event._integrity_hash;
  const integrityChip = integrity
    ? `<span class="prime-silo-lt__integrity" title="${escapeHtml(integrity)}">verified</span>`
    : `<span class="prime-silo-lt__integrity prime-silo-lt__integrity--missing" title="event has no _integrity_hash">unverified</span>`;

  return `
    <li class="prime-silo-lt__event" data-event-type="${escapeHtml(type)}">
      <div class="prime-silo-lt__event-head">
        <time class="prime-silo-lt__time" datetime="${escapeHtml(ts)}">${escapeHtml(ts)}</time>
        <span class="prime-silo-lt__type">${escapeHtml(type)}</span>
        ${integrityChip}
      </div>
      <dl class="prime-silo-lt__triple">
        <dt>process</dt><dd>${emptyOrDash(triple.process)}</dd>
        <dt>skill</dt><dd>${emptyOrDash(triple.skill)}</dd>
        <dt>data</dt><dd>${emptyOrDash(triple.data)}</dd>
        ${triple.outcome ? `<dt>outcome</dt><dd>${emptyOrDash(triple.outcome)}</dd>` : ""}
      </dl>
    </li>
  `;
}

function renderShell(events, props) {
  if (events.length === 0) {
    return `<div class="prime-silo-lt__empty">
      No lineage events for run <code>${escapeHtml(props.run_id)}</code> in workspace <code>${escapeHtml(props.workspace || "default")}</code>.
    </div>`;
  }
  return `<ol class="prime-silo-lt__list">${events.map(renderEvent).join("")}</ol>`;
}

function renderError(host, error) {
  const detail = (error && (error.body && error.body.detail || error.message)) || String(error);
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-lt__error">Lineage load failed: ${escapeHtml(detail)}</div>`;
}

function renderLoading(host, props) {
  host.dataset.widgetState = STATE_LOADING;
  host.innerHTML = `<div class="prime-silo-lt__loading">Loading lineage for run ${escapeHtml(props.run_id || "(none)")}…</div>`;
}

/**
 * Mount the lineage timeline into `host`.
 */
export function createLineageTimelineWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createLineageTimelineWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  let props = { ...initialProps };
  let aborted = false;
  let lastEvents = [];

  host.classList.add("prime-silo-lt");

  async function load() {
    if (!props.run_id) {
      renderError(host, new Error("lineage_timeline requires props.run_id"));
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
      lastEvents = events;
      host.dataset.widgetState = STATE_READY;
      host.innerHTML = renderShell(events, props);
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
      merged.eventType !== props.eventType ||
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
    host.classList.remove("prime-silo-lt");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  load();

  return {
    update,
    refresh,
    destroy,
    get events() {
      return lastEvents;
    }
  };
}

export const __testing = {
  buildEventsPath,
  pickTripleParts,
  renderShell,
  renderEvent
};
