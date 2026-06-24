// Phase M1 — `memoray.overview_cards` widget.
//
// The Command Center: a vanilla port of memo-ray's OverviewGrid.jsx into the
// Phase C widget-factory contract. Renders ecosystem totals, system metrics,
// capabilities, worktrees, the file heatmap, and recent sessions from the
// Memo-Ray API (proxied through the shell at /api/memoray).
//
// Read-only — every call is a GET. By ADR-001 this lives in the review zone
// and is agent-safe.
//
// Public API
//   createOverviewCardsWidget(host, props, options)
//     props   — {
//       onSelectSession?: (sessionId) => void,
//       metricsIntervalMs?: number   // default 5000
//     }
//     options — { memorayClient?: { memorayFetch, readMemorayJson } }
//
// Returns { update, refresh, destroy }. destroy() clears the metrics
// interval and the visibilitychange listener — the exact lifecycle bug
// class we fixed in the React original (expensive si.processes() polling).
//
// Field contract note: the hot-files heatmap reads `fileName`/`filePath`
// (NOT `path`). This matches the declared contract in
// manifests/integrations/memoray.integration.json (beta_overview.hotFiles)
// — the integration audit's payload_contracts check guards this.

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

function basename(p) {
  return (
    String(p || "")
      .split(/[\\/]/)
      .pop() || ""
  );
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function ensureClient(options) {
  if (options && options.memorayClient) {
    return options.memorayClient;
  }
  return { memorayFetch, readMemorayJson };
}

function deriveRecentSessions(overview) {
  if (!overview || !Array.isArray(overview.projects)) return [];
  let all = [];
  for (const project of overview.projects) {
    for (const agent of Object.values(project.agents || {})) {
      all = all.concat((agent.sessions || []).map((s) => ({ ...s, projectName: project.name })));
    }
  }
  return all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 5);
}

/* ── card renderers (string templates → innerHTML) ───────────────────── */

function renderMetricsCard(metrics) {
  if (!metrics) {
    return cardShell("System resources", `<div class="mray-oc__muted">Loading sensors…</div>`);
  }
  const cpu = escapeHtml(metrics.cpu);
  const ramPct = escapeHtml(metrics.ram?.percent);
  const body = `
    <div class="mray-oc__meter">
      <div class="mray-oc__meter-head"><span>CPU load</span><span class="mray-oc__accent-sage">${cpu}%</span></div>
      <div class="mray-oc__bar"><div class="mray-oc__bar-fill mray-oc__fill-sage" style="width:${cpu}%"></div></div>
    </div>
    <div class="mray-oc__meter">
      <div class="mray-oc__meter-head"><span>Memory (RAM)</span><span class="mray-oc__accent-taupe">${formatBytes(metrics.ram?.used)} / ${formatBytes(metrics.ram?.total)}</span></div>
      <div class="mray-oc__bar"><div class="mray-oc__bar-fill mray-oc__fill-taupe" style="width:${ramPct}%"></div></div>
    </div>
    <div class="mray-oc__net">
      <span>↓ RX <strong>${formatBytes(metrics.network?.rxSec)}/s</strong></span>
      <span>↑ TX <strong>${formatBytes(metrics.network?.txSec)}/s</strong></span>
    </div>`;
  return cardShell("System resources", body);
}

function renderProcessesCard(metrics) {
  if (!metrics || !Array.isArray(metrics.processes)) {
    return cardShell("Top processes", `<div class="mray-oc__muted">Loading process table…</div>`);
  }
  const rows = metrics.processes
    .map(
      (p) => `
    <div class="mray-oc__proc">
      <span class="mray-oc__mono">${escapeHtml(p.name)}</span>
      <span class="mray-oc__proc-stats">${escapeHtml(p.cpu)}% · ${escapeHtml(p.mem)} MB</span>
    </div>`
    )
    .join("");
  return cardShell("Top processes", rows || `<div class="mray-oc__muted">No processes.</div>`);
}

function renderEcosystemCard(overview) {
  const body = `
    <div class="mray-oc__stat"><span>Active worktrees</span><strong>${Number(overview.worktrees?.length || 0)}</strong></div>
    <div class="mray-oc__stat"><span>Total sessions</span><strong>${Number(overview.totalSessions || 0)}</strong></div>
    <div class="mray-oc__stat"><span>Total tokens</span><strong class="mray-oc__accent-golden">${Number(overview.totalTokens || 0).toLocaleString()}</strong></div>`;
  return cardShell("Workspace ecosystem", body);
}

function renderCapabilitiesCard(caps) {
  if (!caps) {
    return wideCardShell(
      "System capabilities",
      `<div class="mray-oc__muted">Scanning registries…</div>`
    );
  }
  const plugins =
    (caps.antigravity?.plugins || [])
      .map((p) => `<span class="mray-oc__chip">${escapeHtml(p)}</span>`)
      .join("") || `<span class="mray-oc__muted">No custom plugins.</span>`;
  const mcp =
    (caps.claude?.mcpServers || [])
      .map(
        (m) => `
    <div class="mray-oc__chip mray-oc__chip--stack">
      <strong>${escapeHtml(m.name)}</strong>
      <span class="mray-oc__mono mray-oc__chip-sub">${escapeHtml(m.command)}</span>
    </div>`
      )
      .join("") || `<span class="mray-oc__muted">No MCP servers.</span>`;
  const perms =
    (caps.antigravity?.permissions || [])
      .map((perm) => {
        const isCmd = String(perm).startsWith("command");
        const label = isCmd ? "EXECUTE" : "READ/WRITE";
        const value = String(perm).replace(/^(command|read_file|write_file)\(|\)$/g, "");
        return `<div class="mray-oc__chip mray-oc__chip--stack"><span class="mray-oc__chip-tag">${label}</span><span class="mray-oc__mono">${escapeHtml(value)}</span></div>`;
      })
      .join("") || `<span class="mray-oc__muted">No global permissions.</span>`;

  const body = `
    <div class="mray-oc__caps">
      <div class="mray-oc__caps-col"><h4 class="mray-oc__accent-slate">Antigravity plugins</h4><div class="mray-oc__chips">${plugins}</div></div>
      <div class="mray-oc__caps-col"><h4 class="mray-oc__accent-golden">Claude MCP servers</h4><div class="mray-oc__chips">${mcp}</div></div>
      <div class="mray-oc__caps-col"><h4 class="mray-oc__accent-rust">Security scopes</h4><div class="mray-oc__chips">${perms}</div></div>
    </div>`;
  return wideCardShell("System capabilities", body);
}

function renderWorktreesCard(overview) {
  const items =
    (overview.worktrees || [])
      .map(
        (wt) => `
    <div class="mray-oc__wt">
      <div class="mray-oc__wt-branch">${escapeHtml(wt.branch || "(detached)")}</div>
      <div class="mray-oc__wt-repo">Repo: ${escapeHtml(basename(wt.baseRepo) || "Unknown")}</div>
      <div class="mray-oc__wt-meta"><span>${wt.createdAt ? escapeHtml(new Date(wt.createdAt).toLocaleDateString()) : "—"}</span></div>
    </div>`
      )
      .join("") || `<span class="mray-oc__muted">No active isolated environments.</span>`;
  return cardShell(
    "Active git worktrees",
    `<div class="mray-oc__scroll">${items}</div>`,
    "mray-oc__card--span1"
  );
}

function renderHeatmapCard(overview) {
  const hot = Array.isArray(overview.hotFiles) ? overview.hotFiles.slice(0, 10) : [];
  if (hot.length === 0) {
    return cardShell(
      "File memory heatmap",
      `<span class="mray-oc__muted">No file memory compiled yet.</span>`,
      "mray-oc__card--span2"
    );
  }
  const maxCount = overview.hotFiles[0].count || 1;
  const rows = hot
    .map((file, idx) => {
      const heatPct = (file.count / maxCount) * 100;
      const isClaude = String(file.agent || "").toLowerCase() === "claude";
      const label = basename(file.fileName || file.filePath) || "Unknown file";
      return `
      <div class="mray-oc__heat-row">
        <span class="mray-oc__heat-rank">#${idx + 1}</span>
        <div class="mray-oc__heat-bar">
          <div class="mray-oc__heat-fill ${isClaude ? "mray-oc__heat-fill--claude" : "mray-oc__heat-fill--anti"}" style="width:${heatPct}%"></div>
          <span class="mray-oc__heat-label" title="${escapeHtml(file.filePath || "")}">${escapeHtml(label)}</span>
        </div>
        <span class="mray-oc__heat-count ${isClaude ? "mray-oc__accent-golden" : "mray-oc__accent-slate"}">${Number(file.count)}×</span>
      </div>`;
    })
    .join("");
  return cardShell("File memory heatmap", rows, "mray-oc__card--span2");
}

function renderRecentCard(overview) {
  const recent = deriveRecentSessions(overview);
  const rows =
    recent
      .map(
        (s) => `
    <button type="button" class="mray-oc__session" data-session-id="${escapeHtml(s.id)}">
      <span class="mray-oc__session-main">
        <span class="mray-oc__session-title">${escapeHtml(s.title || "Untitled session")}</span>
        <span class="mray-oc__session-proj">Project: ${escapeHtml(s.projectName || "—")}</span>
      </span>
      <span class="mray-oc__session-meta">
        <span>${s.timestamp ? escapeHtml(new Date(s.timestamp).toLocaleString()) : "—"}</span>
        <span class="mray-oc__accent-golden">${Number(s.nodes || 0)} steps</span>
      </span>
    </button>`
      )
      .join("") || `<span class="mray-oc__muted">No recent activity.</span>`;
  return cardShell("Recent agent activity", rows, "mray-oc__card--full");
}

function cardShell(title, body, extraClass = "") {
  return `<section class="mray-oc__card ${extraClass}"><h3 class="mray-oc__card-title">${escapeHtml(title)}</h3><div class="mray-oc__card-body">${body}</div></section>`;
}

function wideCardShell(title, body) {
  return cardShell(title, body, "mray-oc__card--full");
}

/* ── factory ─────────────────────────────────────────────────────────── */

export function createOverviewCardsWidget(host, initialProps = {}, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createOverviewCardsWidget: host must be an HTMLElement.");
  }

  const client = ensureClient(options);
  let props = { metricsIntervalMs: 5000, ...initialProps };
  let aborted = false;
  let overview = null;
  let capabilities = null;
  let metrics = null;
  let metricsTimer = null;

  host.classList.add("mray-oc");

  function renderState(stateHtml) {
    host.innerHTML = `<div class="mray-oc__state">${stateHtml}</div>`;
  }

  function renderCards() {
    if (aborted) return;
    host.innerHTML = `
      <div class="mray-oc__grid">
        ${renderMetricsCard(metrics)}
        ${renderProcessesCard(metrics)}
        ${renderEcosystemCard(overview)}
        ${renderCapabilitiesCard(capabilities)}
        ${renderWorktreesCard(overview)}
        ${renderHeatmapCard(overview)}
        ${renderRecentCard(overview)}
      </div>`;
    wireSessionClicks();
  }

  function wireSessionClicks() {
    if (typeof props.onSelectSession !== "function") return;
    host.querySelectorAll("[data-session-id]").forEach((el) => {
      el.addEventListener("click", () => props.onSelectSession(el.getAttribute("data-session-id")));
    });
  }

  async function loadStatic() {
    renderState(`<p class="mray-oc__loading">Initializing Command Center…</p>`);
    try {
      const [ov, caps] = await Promise.all([
        client.readMemorayJson(await client.memorayFetch("/beta/overview")),
        client.readMemorayJson(await client.memorayFetch("/system/capabilities")).catch(() => null)
      ]);
      if (aborted) return;
      overview = ov;
      capabilities = caps;
      renderCards();
    } catch (err) {
      if (aborted) return;
      if (isMemorayDisabled(err)) {
        renderState(
          `<p class="mray-oc__offline">Memo-Ray is disabled. Enable it in the configuration wizard or with <code>node space set MEMORAY_ENABLED=true</code>.</p>`
        );
      } else if (isMemorayOffline(err)) {
        renderState(
          `<p class="mray-oc__offline">Memo-Ray is offline. Boot it with <code>scripts/memoray.ps1</code> and refresh.</p>`
        );
      } else {
        renderState(
          `<p class="mray-oc__error">Command Center failed to load: ${escapeHtml(err.message)}</p>`
        );
      }
    }
  }

  async function pollMetrics() {
    if (aborted || (typeof document !== "undefined" && document.visibilityState === "hidden"))
      return;
    try {
      const next = await client.readMemorayJson(await client.memorayFetch("/system/metrics"));
      if (aborted) return;
      metrics = next;
      // Re-render only the two metric cards if cards are already mounted.
      const grid = host.querySelector(".mray-oc__grid");
      if (grid) {
        const cards = grid.querySelectorAll(".mray-oc__card");
        if (cards[0]) cards[0].outerHTML = renderMetricsCard(metrics);
        const refreshed = host.querySelectorAll(".mray-oc__card");
        if (refreshed[1]) refreshed[1].outerHTML = renderProcessesCard(metrics);
      }
    } catch {
      // Metrics are best-effort; ignore transient failures so the static
      // cards stay up. A hard outage surfaces via loadStatic().
    }
  }

  function startMetricsPolling() {
    pollMetrics();
    metricsTimer = setInterval(
      pollMetrics,
      Math.max(2000, Number(props.metricsIntervalMs) || 5000)
    );
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", pollMetrics);
    }
  }

  function update(nextProps) {
    props = { ...props, ...nextProps };
    if (overview) renderCards();
  }

  function refresh() {
    return loadStatic();
  }

  function destroy() {
    aborted = true;
    if (metricsTimer) clearInterval(metricsTimer);
    metricsTimer = null;
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", pollMetrics);
    }
    host.classList.remove("mray-oc");
    host.innerHTML = "";
  }

  loadStatic().then(() => {
    if (!aborted) startMetricsPolling();
  });

  return {
    update,
    refresh,
    destroy,
    get overview() {
      return overview;
    }
  };
}

export const __testing = {
  deriveRecentSessions,
  renderHeatmapCard,
  renderCapabilitiesCard,
  formatBytes,
  basename
};
