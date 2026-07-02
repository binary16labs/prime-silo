// POST /api/longview_stop — stop a running LONGVIEW pipeline.
//
// The runner checkpoints per card in its ledger, so stopping is always safe:
// the next run (any launcher) resumes where the ledger says it stopped.

import longviewService from "../../packaging/desktop/longview_service.js";

export const allowAnonymous = false;

export function post() {
  const result = longviewService.stopLongview();
  return {
    headers: { "Cache-Control": "no-store" },
    status: result.stopped ? 200 : 409,
    body: { format: "prime-silo.longview-stop/1", ...result }
  };
}
