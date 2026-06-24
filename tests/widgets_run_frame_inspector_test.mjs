#!/usr/bin/env node
//
// ADR-001 Phase C — run.frame_inspector widget tests.
//
// Pure-renderer widget — no fetch, no scope header, no DOM events. Tests
// run against a tiny inline fake host (same approach as the markdown
// widget) plus a few fixture frames covering the well-formed and
// half-missing cases.

import assert from "node:assert/strict";

import {
  createFrameInspectorWidget,
  __testing as fiTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/run/frame_inspector/index.js";

async function main() {
  testFormatHashTruncation();
  testRenderShellWellFormedFrame();
  testRenderShellFlagsMissingWithdrawal();
  testWidgetRequiresFrameProp();
  testWidgetRespectsInitialCollapsed();
  testWidgetHidesRawJsonWhenDisabled();
  testWidgetUpdateRepaintsOnFrameChange();
  testWidgetDestroyClearsHost();
  testWidgetRendersPartialAssertions();
  console.log("widgets_run_frame_inspector_test: ok");
}

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    names.forEach((n) => this._set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._set.delete(n));
  }
  has(name) {
    return this._set.has(name);
  }
}

function createFakeHost() {
  return {
    classList: new FakeClassList(),
    dataset: {},
    innerHTML: "",
    querySelector: () => null
  };
}

const WELL_FORMED_FRAME = Object.freeze({
  frame_id: "frame-2026-05-06-abc",
  frame_hash: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcd",
  created_at: "2026-05-06T10:31:42Z",
  run_id: "run-cmr-v1",
  source_node: "step_review",
  confidence: 0.873,
  assertions: [
    {
      entity: "ACME",
      claim: "Counterparty exposure exceeds desk limit",
      confidence: 0.91,
      basis: ["trades_canonical_1000rows", "limits_master"]
    },
    {
      entity: "GLOBAL_FX_DESK",
      claim: "Net delta within tolerance",
      confidence: 0.78,
      basis: []
    }
  ],
  withdrawal: {
    cannot_represent: ["intraday_spikes_below_5min"],
    contradictions: [],
    failure_register_refs: ["fan_out_node_3:partial"]
  },
  provenance: {
    process: "proc_eod_portfolio_review",
    skill: "sk_review_attest_v1",
    incentive_context: "regulatory_eod_gate",
    parent_run_id: null,
    port_provenance: [
      { source_node: "node_a", source_port: "frame", consumed_by_node: "step_review" }
    ]
  },
  calibration: {
    method: "platt",
    drift_signal: "stable",
    window: "P30D"
  }
});

function testFormatHashTruncation() {
  const long = "a".repeat(64);
  const out = fiTesting.formatHash(long);
  assert.match(out, /title="a{64}"/);
  assert.match(out, /a{12}…a{4}/);
  assert.equal(fiTesting.formatHash(""), '<span class="prime-silo-fi__missing">(empty)</span>');
}

function testRenderShellWellFormedFrame() {
  const html = fiTesting.renderShell(WELL_FORMED_FRAME, new Set(["raw"]), true);
  assert.match(html, /Identity/);
  assert.match(html, /Assertions/);
  assert.match(html, /Withdrawal register/);
  assert.match(html, /Provenance/);
  assert.match(html, /Confidence/);
  // Raw section is present but starts collapsed (no `open` attribute).
  assert.match(html, /data-section="raw"(?! open)/);
  // Header section starts open by default.
  assert.match(html, /data-section="header" open/);
  // Assertions render with confidence pills.
  assert.match(html, /conf 0\.910/);
  assert.match(html, /ACME/);
  // Provenance rows.
  assert.match(html, /proc_eod_portfolio_review/);
  // Withdrawal cannot_represent value present.
  assert.match(html, /intraday_spikes_below_5min/);
}

function testRenderShellFlagsMissingWithdrawal() {
  const broken = { ...WELL_FORMED_FRAME, withdrawal: undefined };
  const html = fiTesting.renderShell(broken, new Set(), true);
  assert.match(html, /withdrawal register missing/);
  assert.match(html, /FRAME_INVALID/);
}

function testWidgetRequiresFrameProp() {
  const host = createFakeHost();
  createFrameInspectorWidget(host, {});
  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /requires props\.frame/);
}

function testWidgetRespectsInitialCollapsed() {
  const host = createFakeHost();
  createFrameInspectorWidget(host, {
    frame: WELL_FORMED_FRAME,
    initialCollapsed: ["assertions", "raw"]
  });
  assert.equal(host.dataset.widgetState, "ready");
  // assertions section must not have `open` attribute.
  assert.match(host.innerHTML, /data-section="assertions"(?! open)/);
  // header still defaults to open since not in collapsed list.
  assert.match(host.innerHTML, /data-section="header" open/);
}

function testWidgetHidesRawJsonWhenDisabled() {
  const host = createFakeHost();
  createFrameInspectorWidget(host, {
    frame: WELL_FORMED_FRAME,
    showRawJson: false
  });
  assert.doesNotMatch(host.innerHTML, /data-section="raw"/);
}

function testWidgetUpdateRepaintsOnFrameChange() {
  const host = createFakeHost();
  const widget = createFrameInspectorWidget(host, { frame: WELL_FORMED_FRAME });
  assert.match(host.innerHTML, /ACME/);

  const otherFrame = {
    ...WELL_FORMED_FRAME,
    assertions: [{ entity: "ZETA_BANK", claim: "x", confidence: 0.5, basis: [] }]
  };
  widget.update({ frame: otherFrame });
  assert.match(host.innerHTML, /ZETA_BANK/);
  assert.doesNotMatch(host.innerHTML, /ACME/);
}

function testWidgetDestroyClearsHost() {
  const host = createFakeHost();
  const widget = createFrameInspectorWidget(host, { frame: WELL_FORMED_FRAME });
  widget.destroy();
  assert.equal(host.innerHTML, "");
  assert.equal(host.dataset.widgetState, undefined);
  assert.equal(host.classList.has("prime-silo-fi-host"), false);
}

function testWidgetRendersPartialAssertions() {
  const host = createFakeHost();
  createFrameInspectorWidget(host, {
    frame: {
      // Minimum viable: just an assertion with no basis, no confidence,
      // missing claim. Renderer must not throw.
      assertions: [{ entity: "X" }],
      withdrawal: { cannot_represent: [], contradictions: [] }
    }
  });
  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /\(missing\)|\(empty\)/);
  assert.match(host.innerHTML, /conf —/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
