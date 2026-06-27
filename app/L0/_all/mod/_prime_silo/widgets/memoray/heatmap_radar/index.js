// Phase 2 — `memoray.heatmap_radar` widget.
//
// A vanilla port of memo-ray's HeatmapRadar.jsx into the Phase C widget-factory
// contract. Renders the 365-day "Activity Radar": ecosystem stat cards + a
// GitHub-style calendar heatmap of session activity, with a clickable day that
// filters its host page. Data comes from the Memo-Ray API (proxied through the
// shell at /api/memoray/heatmap-stats).
//
// Read-only — every call is a GET. By ADR-001 this lives in the review zone and
// is agent-safe. Part of the decoupled memo-ray screen architecture
// (MEMORAY-MERGE.md Phase 2): pages stay thin Alpine views; all memo-ray data
// access + DOM lives in shared widgets like this one over memoray-client.js.
//
// Public API
//   createHeatmapRadarWidget(host, props, options)
//     props   — {
//       selectedDate?: string|null,        // "YYYY-MM-DD" highlighted + emitted
//       onDateSelect?: (date|null) => void  // toggles selection
//     }
//     options — { memorayClient?: { memorayFetch, readMemorayJson } }
//
// Returns { update, refresh, destroy }.

import {
  memorayFetch,
  readMemorayJson,
  isMemorayOffline,
  isMemorayDisabled
} from "../../../memoray_client/memoray-client.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

function escapeHtml(text) {
  return String(text == null ? "" : text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

function formatNum(num) {
  const n = Number(num) || 0;
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function intensityClass(count) {
  if (count === 0) return "level-0";
  if (count <= 2) return "level-1";
  if (count <= 5) return "level-2";
  if (count <= 10) return "level-3";
  return "level-4";
}

// Build the trailing 365-day calendar from the API's per-day map. Day keys are
// local-date strings ("YYYY-MM-DD"), matching memo-ray's offset convention so a
// cell and the lifelog filter agree on what "today" is.
function buildCalendar(days) {
  const calendar = [];
  const today = new Date();
  const start = new Date(today);
  start.setDate(start.getDate() - 364);
  for (let i = 0; i <= 364; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
    const key = local.toISOString().split("T")[0];
    const entry = (days && days[key]) || {};
    calendar.push({
      date: key,
      count: entry.count || 0,
      nodes: entry.nodes || 0,
      tokens: entry.tokens || 0
    });
  }
  return calendar;
}

function ensureClient(options) {
  if (options && options.memorayClient) return options.memorayClient;
  return { memorayFetch, readMemorayJson };
}

function statCard(label, value, mono = false) {
  return `<div class="mray-hr__stat"><div class="mray-hr__stat-label">${escapeHtml(label)}</div><div class="mray-hr__stat-value${mono ? " mray-hr__stat-value--sm" : ""}">${escapeHtml(value)}</div></div>`;
}

function renderStats(stats) {
  if (!stats) return "";
  const favorite = String(stats.favoriteModel || "—")
    .replace("claude-", "")
    .replace("models/", "");
  return `
    <div class="mray-hr__stats">
      ${statCard("Sessions", formatNum(stats.totalSessions))}
      ${statCard("Messages", formatNum(stats.totalMessages))}
      ${statCard("Total tokens", formatNum(stats.totalTokens))}
      ${statCard("Active days", String(stats.activeDays ?? 0))}
      ${statCard("Current streak", `${stats.currentStreak ?? 0}d`)}
      ${statCard("Longest streak", `${stats.longestStreak ?? 0}d`)}
      ${statCard("Peak hour", String(stats.peakHour ?? "—"))}
      ${statCard("Favorite model", favorite, true)}
    </div>`;
}

function renderGrid(calendar, selectedDate) {
  const cells = calendar
    .map((day) => {
      const sel = selectedDate === day.date ? " selected" : "";
      const title = `${day.date}: ${day.count} sessions, ${day.nodes} nodes, ${formatNum(day.tokens)} tokens`;
      return `<div class="mray-hr__cell ${intensityClass(day.count)}${sel}" data-date="${day.date}" title="${escapeHtml(title)}"></div>`;
    })
    .join("");
  return `<div class="mray-hr__grid">${cells}</div>`;
}

export function createHeatmapRadarWidget(host, initialProps = {}, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createHeatmapRadarWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  let props = { selectedDate: null, ...initialProps };
  let aborted = false;
  let data = null;
  let collapsed = false;

  host.classList.add("mray-hr");

  function renderState(html) {
    host.innerHTML = `<div class="mray-hr__state">${html}</div>`;
  }

  function render() {
    if (aborted) return;
    if (!data) {
      renderState(`<p class="mray-hr__loading">Loading radar…</p>`);
      return;
    }
    const calendar = buildCalendar(data.days);
    const pill = props.selectedDate
      ? `<div class="mray-hr__pill">Filtering by: ${escapeHtml(props.selectedDate)} <button type="button" class="mray-hr__pill-clear" data-clear="1">×</button></div>`
      : "";
    host.innerHTML = `
      <div class="mray-hr__head">
        <h2 class="mray-hr__title">Activity Radar</h2>
        <button type="button" class="mray-hr__toggle" data-toggle="1">${collapsed ? "Show Radar" : "Hide Radar"}</button>
      </div>
      ${collapsed ? "" : `${renderStats(data.stats)}<div class="mray-hr__grid-wrap">${renderGrid(calendar, props.selectedDate)}${pill}</div>`}`;
    wire();
  }

  function wire() {
    const toggle = host.querySelector("[data-toggle]");
    if (toggle) {
      toggle.addEventListener("click", () => {
        collapsed = !collapsed;
        render();
      });
    }
    if (typeof props.onDateSelect === "function") {
      host.querySelectorAll(".mray-hr__cell").forEach((el) => {
        el.addEventListener("click", () => {
          const date = el.getAttribute("data-date");
          props.onDateSelect(date === props.selectedDate ? null : date);
        });
      });
      const clear = host.querySelector("[data-clear]");
      if (clear) clear.addEventListener("click", () => props.onDateSelect(null));
    }
  }

  async function load(silent = false) {
    // Silent (background) refresh keeps the current radar up until fresh data
    // arrives, so the live sync doesn't flash "Loading radar…".
    if (!silent || !data) {
      renderState(`<p class="mray-hr__loading">Loading radar…</p>`);
    }
    try {
      const next = await client.readMemorayJson(await client.memorayFetch("/heatmap-stats"));
      if (aborted) return;
      data = next;
      render();
    } catch (err) {
      if (aborted) return;
      if (isMemorayDisabled(err)) {
        renderState(`<p class="mray-hr__muted">Memo-Ray is disabled — no radar.</p>`);
      } else if (isMemorayOffline(err)) {
        renderState(`<p class="mray-hr__muted">Memo-Ray is offline — no radar.</p>`);
      } else {
        renderState(`<p class="mray-hr__muted">Radar failed to load.</p>`);
      }
    }
  }

  function update(nextProps) {
    props = { ...props, ...nextProps };
    if (data) render();
  }

  function refresh(silent = false) {
    return load(silent);
  }

  function destroy() {
    aborted = true;
    host.classList.remove("mray-hr");
    host.innerHTML = "";
  }

  load();

  return { update, refresh, destroy };
}

export const __testing = { buildCalendar, intensityClass, formatNum };
