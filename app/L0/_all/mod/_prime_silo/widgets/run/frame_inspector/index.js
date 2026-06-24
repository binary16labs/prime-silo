// ADR-001 Phase C — `run.frame_inspector` widget.
//
// Read-only structured renderer for a Cognitive Frame. Authority on the
// manifest is `read_only` and `frame_bindings = [{ field: ".", required: true }]`,
// so the layout supplies the whole frame as a prop and the widget never
// fetches anything itself. That keeps this widget in the
// "no scope header, no runtime calls" lane — it can render fixtures as
// easily as live frame outputs.
//
// Public API
//   createFrameInspectorWidget(host, props)
//     host  — HTMLElement to mount into
//     props — {
//       frame: object,                      // required — full Cognitive Frame
//       initialCollapsed?: SectionId[],     // sections that start collapsed
//       showRawJson?: boolean               // default true
//     }
//
// Returns { update, destroy } — the layout calls update() when the bound
// frame changes (e.g. user scrubs the run timeline) and destroy() when the
// tile unmounts.
//
// The renderer is defensive: a Cognitive Frame is *supposed* to carry every
// field the PRD §9 schema mandates, but historic runs and partial fixtures
// may not. Missing values render as `(missing)` italics rather than throw.

const SECTIONS = ["header", "assertions", "withdrawal", "provenance", "confidence", "raw"];
const DEFAULT_COLLAPSED = ["raw"];

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

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v == null) return [];
  return [v];
}

function formatScalar(v) {
  if (v == null) return '<span class="prime-silo-fi__missing">(missing)</span>';
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return escapeHtml(String(v));
  if (typeof v === "string") {
    if (v === "") return '<span class="prime-silo-fi__missing">(empty)</span>';
    return escapeHtml(v);
  }
  return `<code>${escapeHtml(JSON.stringify(v))}</code>`;
}

function formatHash(hash) {
  if (!hash) return formatScalar(hash);
  const s = String(hash);
  if (s.length <= 16) return escapeHtml(s);
  return `<code title="${escapeHtml(s)}">${escapeHtml(s.slice(0, 12))}…${escapeHtml(s.slice(-4))}</code>`;
}

function renderHeader(frame) {
  const rows = [
    ["frame_id", formatScalar(frame.frame_id)],
    ["frame_hash", formatHash(frame.frame_hash)],
    ["created_at", formatScalar(frame.created_at || frame.timestamp)],
    ["source_run_id", formatScalar(frame.run_id || frame.source_run_id)],
    ["source_node", formatScalar(frame.source_node || frame.node_id)]
  ];
  return renderKvTable(rows);
}

function renderAssertions(frame) {
  const assertions = asArray(frame.assertions);
  if (assertions.length === 0) {
    return `<p class="prime-silo-fi__missing">No assertions on this frame.</p>`;
  }
  const items = assertions.map((a, idx) => {
    const entity = a.entity || a.subject || a.entity_ref || `(assertion ${idx + 1})`;
    const claim = a.claim || a.predicate || a.statement || "";
    const confidence = typeof a.confidence === "number" ? a.confidence.toFixed(3) : "—";
    const basis = asArray(a.basis);
    const basisHtml = basis.length
      ? `<ul class="prime-silo-fi__basis">${basis
          .map((b) => `<li>${formatScalar(b)}</li>`)
          .join("")}</ul>`
      : `<span class="prime-silo-fi__missing">(no basis)</span>`;
    return `
      <li class="prime-silo-fi__assertion">
        <div class="prime-silo-fi__assertion-head">
          <span class="prime-silo-fi__entity">${formatScalar(entity)}</span>
          <span class="prime-silo-fi__confidence">conf ${escapeHtml(confidence)}</span>
        </div>
        <div class="prime-silo-fi__claim">${formatScalar(claim)}</div>
        <details class="prime-silo-fi__basis-wrap">
          <summary>basis</summary>
          ${basisHtml}
        </details>
      </li>
    `;
  });
  return `<ol class="prime-silo-fi__assertions">${items.join("")}</ol>`;
}

function renderWithdrawal(frame) {
  const withdrawal = isPlainObject(frame.withdrawal) ? frame.withdrawal : null;
  if (!withdrawal) {
    return `<p class="prime-silo-fi__danger">withdrawal register missing — frame fails NFR-05 / FRAME_INVALID.</p>`;
  }

  const cannotRepresent = asArray(withdrawal.cannot_represent);
  const contradictions = asArray(withdrawal.contradictions);
  const failureRefs = asArray(withdrawal.failure_register_refs);

  return `
    <div class="prime-silo-fi__withdrawal">
      ${renderListSection(
        "cannot_represent",
        cannotRepresent,
        "(empty list — frame claims to represent everything in scope)"
      )}
      ${renderListSection("contradictions", contradictions, "(no contradictions registered)")}
      ${renderListSection(
        "failure_register_refs",
        failureRefs,
        "(no failure registers referenced)"
      )}
    </div>
  `;
}

function renderListSection(label, items, emptyText) {
  if (items.length === 0) {
    return `<div class="prime-silo-fi__withdrawal-line">
      <strong>${escapeHtml(label)}</strong>:
      <em class="prime-silo-fi__missing">${escapeHtml(emptyText)}</em>
    </div>`;
  }
  return `<div class="prime-silo-fi__withdrawal-line">
    <strong>${escapeHtml(label)}</strong>:
    <ul>${items.map((item) => `<li>${formatScalar(item)}</li>`).join("")}</ul>
  </div>`;
}

function renderProvenance(frame) {
  const prov = isPlainObject(frame.provenance) ? frame.provenance : {};
  const rows = [
    ["process", formatScalar(prov.process || prov.process_id)],
    ["skill", formatScalar(prov.skill || prov.skill_id)],
    ["incentive_context", formatScalar(prov.incentive_context)],
    ["parent_run_id", formatScalar(prov.parent_run_id || frame.parent_run_id)]
  ];

  const portProv = asArray(prov.port_provenance);
  const portList = portProv.length
    ? `<details class="prime-silo-fi__port-prov" open>
        <summary>port_provenance (${portProv.length})</summary>
        <ul>${portProv
          .map(
            (p) =>
              `<li><code>${formatScalar(p.source_node || p.node)}.${formatScalar(p.source_port || p.port)}</code> → <code>${formatScalar(p.consumed_by_node)}</code></li>`
          )
          .join("")}</ul>
      </details>`
    : `<p class="prime-silo-fi__missing">(port_provenance empty)</p>`;

  return renderKvTable(rows) + portList;
}

function renderConfidence(frame) {
  const confidence = frame.confidence;
  const calibration = isPlainObject(frame.calibration) ? frame.calibration : null;

  const rows = [
    [
      "confidence",
      typeof confidence === "number"
        ? `<span class="prime-silo-fi__confidence prime-silo-fi__confidence--big">${escapeHtml(confidence.toFixed(3))}</span>`
        : formatScalar(confidence)
    ]
  ];
  if (calibration) {
    rows.push(["calibration_method", formatScalar(calibration.method)]);
    rows.push(["calibration_drift", formatScalar(calibration.drift_signal)]);
    rows.push(["calibration_window", formatScalar(calibration.window)]);
  }
  return renderKvTable(rows);
}

function renderRaw(frame) {
  const json = JSON.stringify(frame, null, 2);
  return `<pre class="prime-silo-fi__raw"><code>${escapeHtml(json)}</code></pre>`;
}

function renderKvTable(rows) {
  return `<dl class="prime-silo-fi__kv">${rows
    .map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`)
    .join("")}</dl>`;
}

function sectionRenderer(id) {
  switch (id) {
    case "header":
      return renderHeader;
    case "assertions":
      return renderAssertions;
    case "withdrawal":
      return renderWithdrawal;
    case "provenance":
      return renderProvenance;
    case "confidence":
      return renderConfidence;
    case "raw":
      return renderRaw;
    default:
      return null;
  }
}

function sectionTitle(id) {
  return (
    {
      header: "Identity",
      assertions: "Assertions",
      withdrawal: "Withdrawal register",
      provenance: "Provenance",
      confidence: "Confidence",
      raw: "Raw JSON"
    }[id] || id
  );
}

function renderShell(frame, collapsed, showRawJson) {
  const shown = SECTIONS.filter((id) => id !== "raw" || showRawJson);
  const blocks = shown.map((id) => {
    const renderer = sectionRenderer(id);
    if (!renderer) return "";
    const isOpen = !collapsed.has(id);
    return `<details class="prime-silo-fi__section" data-section="${id}"${isOpen ? " open" : ""}>
      <summary>${escapeHtml(sectionTitle(id))}</summary>
      <div class="prime-silo-fi__section-body">${renderer(frame)}</div>
    </details>`;
  });
  return `<article class="prime-silo-fi">${blocks.join("")}</article>`;
}

/**
 * Mount the frame inspector into `host`.
 */
export function createFrameInspectorWidget(host, initialProps) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createFrameInspectorWidget: host must be an HTMLElement.");
  }

  let props = { ...initialProps };

  function paint() {
    if (!isPlainObject(props.frame)) {
      host.innerHTML = `<div class="prime-silo-fi__error">frame_inspector requires props.frame (object).</div>`;
      host.dataset.widgetState = "error";
      return;
    }
    const collapsed = new Set(
      Array.isArray(props.initialCollapsed) ? props.initialCollapsed : DEFAULT_COLLAPSED
    );
    const showRawJson = props.showRawJson !== false;
    host.classList.add("prime-silo-fi-host");
    host.innerHTML = renderShell(props.frame, collapsed, showRawJson);
    host.dataset.widgetState = "ready";
  }

  function update(nextProps) {
    props = { ...props, ...nextProps };
    paint();
  }

  function destroy() {
    host.classList.remove("prime-silo-fi-host");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  paint();
  return { update, destroy };
}

export const __testing = {
  SECTIONS,
  DEFAULT_COLLAPSED,
  renderShell,
  formatHash,
  escapeHtml
};
