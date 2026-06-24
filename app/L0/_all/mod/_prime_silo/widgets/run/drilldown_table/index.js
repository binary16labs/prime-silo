// ADR-001 Phase C — `run.drilldown_table` widget.
//
// Read-only tabular view of a Pypes node output. Drills into a specific
// step's checkpoint and renders rows + the step's CLP binding so the
// operator can see what input columns the step consumed (the L of CLP),
// the produced columns, and the parameters that shaped the run.
//
// Public API
//   createDrilldownTableWidget(host, props, options)
//     props   — {
//       run_id:   string,        // required (no "pypes-" prefix)
//       step_id:  string,        // required
//       workspace?: string,      // default "default"
//       rows?:    number         // default 50, 1..5000
//     }
//     options — { runtimeClient?: { runtimeFetch, readRuntimeJson } }
//
// Returns { update, refresh, destroy, get rows, get columns, get clpBinding }
// so layouts can re-bind to a different (run, step) pair and trigger a
// reload after a rerun.
//
// Rendering: <header> with stage chip + row-count + column-count, a CLP
// summary card if the step has a binding, then a scrollable table. Cell
// values that are null/undefined render as a muted "—". Object/array
// values are JSON-stringified to keep one row per record.

import { runtimeFetch, readRuntimeJson } from "../../../runtime_client/runtime-client.js";

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

function buildDrilldownPath(props) {
  const params = new URLSearchParams();
  params.set("workspace", props.workspace || "default");
  if (typeof props.rows === "number") {
    params.set("rows", String(props.rows));
  }
  const qs = params.toString();
  return `/pypes/runs/${encodeURIComponent(props.run_id)}/steps/${encodeURIComponent(props.step_id)}${qs ? `?${qs}` : ""}`;
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, readRuntimeJson };
}

function formatCell(value) {
  if (value == null || value === "") {
    return '<span class="prime-silo-dt__missing">—</span>';
  }
  if (typeof value === "object") {
    let json;
    try {
      json = JSON.stringify(value);
    } catch (err) {
      json = String(value);
    }
    return `<code class="prime-silo-dt__json">${escapeHtml(json)}</code>`;
  }
  if (typeof value === "number") {
    return `<span class="prime-silo-dt__num">${escapeHtml(value)}</span>`;
  }
  return escapeHtml(value);
}

function renderClpCard(binding) {
  if (!binding || typeof binding !== "object" || Object.keys(binding).length === 0) {
    return `<div class="prime-silo-dt__clp prime-silo-dt__clp--missing">
      No CLP binding declared on this step — drill-back lineage is blind.
    </div>`;
  }
  const entries = Object.entries(binding)
    .map(([k, v]) => {
      const display = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(display)}</dd>`;
    })
    .join("");
  return `<dl class="prime-silo-dt__clp">${entries}</dl>`;
}

function renderTable(payload) {
  const columns = Array.isArray(payload.columns) ? payload.columns : [];
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  if (columns.length === 0 && rows.length === 0) {
    return `<div class="prime-silo-dt__empty">Step produced no rows.</div>`;
  }
  const head = columns.map((c) => `<th scope="col">${escapeHtml(c)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns.map((c) => `<td>${formatCell(row ? row[c] : null)}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `
    <div class="prime-silo-dt__scroll">
      <table class="prime-silo-dt__table">
        <thead><tr>${head}</tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>
  `;
}

function renderShell(payload, props) {
  const stage = payload.stage || "(unstaged)";
  const rowCount =
    typeof payload.row_count === "number" ? payload.row_count : (payload.rows || []).length;
  const colCount = (payload.columns || []).length;
  return `
    <header class="prime-silo-dt__head">
      <h3 class="prime-silo-dt__title">
        <code>${escapeHtml(props.run_id)}</code>
        <span class="prime-silo-dt__sep">›</span>
        <code>${escapeHtml(props.step_id)}</code>
      </h3>
      <div class="prime-silo-dt__meta">
        <span class="prime-silo-dt__stage" data-stage="${escapeHtml(stage)}">${escapeHtml(stage)}</span>
        <span class="prime-silo-dt__count">${rowCount} row${rowCount === 1 ? "" : "s"}</span>
        <span class="prime-silo-dt__count">${colCount} col${colCount === 1 ? "" : "s"}</span>
      </div>
    </header>
    ${renderClpCard(payload.clp_binding)}
    ${renderTable(payload)}
  `;
}

function renderError(host, error) {
  const detail = (error && ((error.body && error.body.detail) || error.message)) || String(error);
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-dt__error">Drill-down failed: ${escapeHtml(detail)}</div>`;
}

function renderLoading(host, props) {
  host.dataset.widgetState = STATE_LOADING;
  host.innerHTML = `<div class="prime-silo-dt__loading">Loading drill-down for step ${escapeHtml(props.step_id || "(none)")}…</div>`;
}

function renderMissingProps(host, missing) {
  host.dataset.widgetState = STATE_ERROR;
  host.innerHTML = `<div class="prime-silo-dt__error">drilldown_table requires props.${escapeHtml(missing)}</div>`;
}

/**
 * Mount the drill-down table into `host`.
 */
export function createDrilldownTableWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createDrilldownTableWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  let props = { ...initialProps };
  let aborted = false;
  let lastPayload = { rows: [], columns: [], clp_binding: {} };

  host.classList.add("prime-silo-dt");

  async function load() {
    if (!props.run_id) {
      renderMissingProps(host, "run_id");
      return;
    }
    if (!props.step_id) {
      renderMissingProps(host, "step_id");
      return;
    }
    renderLoading(host, props);
    try {
      const response = await client.runtimeFetch(buildDrilldownPath(props));
      const payload = await client.readRuntimeJson(response);
      if (aborted) {
        return;
      }
      lastPayload = payload || { rows: [], columns: [], clp_binding: {} };
      host.dataset.widgetState = STATE_READY;
      host.innerHTML = renderShell(lastPayload, props);
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
      merged.step_id !== props.step_id ||
      merged.workspace !== props.workspace ||
      merged.rows !== props.rows;
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
    host.classList.remove("prime-silo-dt");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  load();

  return {
    update,
    refresh,
    destroy,
    get rows() {
      return Array.isArray(lastPayload.rows) ? lastPayload.rows : [];
    },
    get columns() {
      return Array.isArray(lastPayload.columns) ? lastPayload.columns : [];
    },
    get clpBinding() {
      return (lastPayload && lastPayload.clp_binding) || {};
    }
  };
}

export const __testing = {
  buildDrilldownPath,
  formatCell,
  renderClpCard,
  renderTable,
  renderShell
};
