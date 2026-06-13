// Phase M1 — integration conformance audit endpoint.
//
// GET /api/integration_audit walks manifests/integrations/*.integration.json
// and probes live reality against each declaration (signature, config
// surface, health, payload contracts, owner paths). Returns the
// aamp.audit_report/1 drift report that the memory page's conformance strip,
// the site dashboard card, `node space memory audit`, and any maintaining
// agent all read. The heavy lifting lives in server/lib/integration_audit.js
// so the CLI and tests share one implementation.
//
// Read-only: this endpoint never mutates manifests or signs anything —
// signing stays a deliberate human step (scripts/audit-integrations.mjs
// --sign).

import { runIntegrationAudit } from "../lib/integration_audit.js";

export const allowAnonymous = false;

export async function get(context) {
  const report = await runIntegrationAudit({
    projectRoot: context.projectRoot,
    runtimeParams: context.runtimeParams
  });

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: report
  };
}
