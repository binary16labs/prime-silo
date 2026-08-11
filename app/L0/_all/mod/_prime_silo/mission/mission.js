// Mission console — workflows + agent in one place.
//
// Data comes from the two read surfaces that are canonical elsewhere too:
//   GET  /api/workflows            — the registry (same scripts/workflows/registry.mjs the CLI reads)
//   GET  /api/agent/health         — is a tuned model actually served locally
//   POST /api/agent/run            — SSE step stream from the SAME runAgent the CLI drives
// The UI is a WRAPPER: it never re-implements the loop or re-derives "latest" on its own.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const day = (ts) => (ts ? String(ts).slice(0, 10) : "—");

// ---- tabs -----------------------------------------------------------------
for (const tab of document.querySelectorAll(".ms-tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".ms-tab")) t.setAttribute("aria-selected", String(t === tab));
    for (const p of document.querySelectorAll(".ms-panel")) p.hidden = true;
    $(`ms-panel-${tab.dataset.panel}`).hidden = false;
  });
}

// ---- workflows ------------------------------------------------------------
function versionRow(v, isLatest) {
  const row = el("div", `ms-ver${isLatest ? " ms-ver-latest" : ""}`);
  row.appendChild(el("span", null, `${isLatest ? "→ " : "   "}${v.label || v.version}`));
  const bits = [day(v.generated)];
  if (v.formats?.length) bits.push(v.formats.join("/"));
  if (v.quality != null) bits.push(`q=${v.quality}`);
  if (v.agg_nll != null) bits.push(`nll=${v.agg_nll}`);
  row.appendChild(el("span", null, bits.join("  ")));
  return row;
}

function workflowCard(t) {
  const card = el("div", "ms-card");
  const top = el("div", "ms-card-top");
  top.appendChild(el("h3", null, t.label));
  top.appendChild(el("span", "ms-kind", t.kind));
  card.appendChild(top);

  if (!t.available) {
    card.appendChild(el("div", "ms-latest ms-none", "no artifacts found"));
  } else {
    card.appendChild(el("div", "ms-latest", `latest: ${t.latest.label || t.latest.version}`));
    const meta = [day(t.latest.generated), t.latest.workspace && `in ${t.latest.workspace}`,
                  t.latest.model && `model ${t.latest.model}`,
                  `${t.count} version${t.count === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
    card.appendChild(el("div", "ms-meta", meta));
  }
  card.appendChild(el("div", "ms-produces", t.produces));

  if (t.versions.length > 1) {
    const list = el("div", "ms-versions");
    list.hidden = true;
    t.versions.forEach((v, i) => list.appendChild(versionRow(v, i === 0)));
    const btn = el("button", "ms-toggle", `show all ${t.count} versions`);
    btn.type = "button";
    btn.addEventListener("click", () => {
      list.hidden = !list.hidden;
      btn.textContent = list.hidden ? `show all ${t.count} versions` : "hide versions";
    });
    card.appendChild(btn);
    card.appendChild(list);
  }
  return card;
}

async function loadWorkflows() {
  const host = $("ms-workflows");
  try {
    const reg = await fetch("/api/workflows").then((r) => r.json());
    const scanned = (reg.workspaces || []).filter((w) => w.scanned).map((w) => w.name);
    $("ms-workspace").textContent =
      `scanned ${scanned.length} workspace(s): ${scanned.join(", ") || "none"}` +
      (reg.private_excluded ? `  ·  ${reg.private_excluded} private workspace(s) excluded by design` : "");
    host.textContent = "";
    for (const t of reg.types) host.appendChild(workflowCard(t));
  } catch (e) {
    host.textContent = `could not load the workflow registry: ${e.message}`;
  }
}

// ---- dashboards -----------------------------------------------------------
async function loadDashboards() {
  const host = $("ms-dashboards");
  try {
    const d = await fetch("/api/workflows/dashboards").then((r) => r.json());
    $("ms-dash-note").textContent =
      `The estate's existing consoles — each still owns its depth; Mission is the way in. Serve them with: ${d.serve}`;
    host.textContent = "";
    for (const x of d.dashboards) {
      const card = el("div", "ms-card");
      const link = el("a", "ms-dash-link", x.label);
      link.href = x.url;
      link.target = "_blank";
      link.rel = "noreferrer";
      card.appendChild(link);
      card.appendChild(el("div", "ms-produces", x.purpose));
      card.appendChild(el("div", x.present ? "ms-meta" : "ms-missing", x.present ? x.file : `${x.file} — not found`));
      host.appendChild(card);
    }
  } catch (e) {
    host.textContent = `could not load dashboards: ${e.message}`;
  }
}

// ---- agent ----------------------------------------------------------------
async function checkAgent() {
  try {
    const h = await fetch("/api/agent/health").then((r) => r.json());
    $("ms-status").textContent = h.ok
      ? `model host ready — ${h.models.join(", ") || "no model loaded"}${h.exec_enabled ? "" : " · shell execution disabled on this host"}`
      : `no model served on ${h.baseUrl} — load one in LM Studio to run the agent`;
    $("ms-run").disabled = !h.ok;
  } catch (e) {
    $("ms-status").textContent = `agent API unreachable: ${e.message}`;
    $("ms-run").disabled = true;
  }
}

function renderStep(data, isError) {
  const box = el("div", `ms-step${isError ? " ms-step-err" : ""}`);
  const head = el("div", "ms-step-head");
  if (isError) {
    head.textContent = `error: ${data.error || "unknown"}`;
  } else {
    head.appendChild(el("span", null, `step ${data.step}: `));
    head.appendChild(el("span", "ms-tool", data.call?.name || "?"));
    head.appendChild(el("span", null, ` ${JSON.stringify(data.call?.input || {}).slice(0, 160)}`));
  }
  box.appendChild(head);
  if (data.result) box.appendChild(el("pre", null, String(data.result).slice(0, 2000)));
  $("ms-steps").appendChild(box);
  box.scrollIntoView({ block: "nearest" });
}

// SSE over POST — EventSource cannot POST, so read the body stream and split on blank lines.
async function runAgent() {
  const task = $("ms-task").value.trim();
  if (!task) return;
  $("ms-steps").textContent = "";
  $("ms-run").disabled = true;
  $("ms-status").textContent = "running…";
  try {
    const res = await fetch("/api/agent/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task, role: $("ms-role").value, steps: 12 }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";
      for (const frame of frames) {
        const ev = (frame.match(/^event: (.*)$/m) || [])[1];
        const raw = (frame.match(/^data: (.*)$/m) || [])[1];
        if (!ev || !raw) continue;
        const data = JSON.parse(raw);
        if (ev === "step") renderStep(data, false);
        else if (ev === "error") renderStep(data, true);
        else if (ev === "done") {
          $("ms-status").textContent = data.finished
            ? `finished in ${data.steps.length} steps${data.answer ? ` — ${data.answer}` : ""}`
            : `stopped after ${data.steps.length} steps (no finish)`;
        }
      }
    }
  } catch (e) {
    $("ms-status").textContent = `run failed: ${e.message}`;
  } finally {
    $("ms-run").disabled = false;
  }
}

$("ms-run").addEventListener("click", runAgent);
$("ms-task").addEventListener("keydown", (e) => { if (e.key === "Enter") runAgent(); });

loadWorkflows();
loadDashboards();
checkAgent();
