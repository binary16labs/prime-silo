// GET /api/longview_status — the LONGVIEW transparency surface.
//
// Read-only, disk-backed (runner lock + the runner's status.json heartbeat +
// runner.log tail), so it is truthful no matter where the run was launched —
// CLI, tray, or Bridge. Poll this while a run is active.

import longviewService from "../../packaging/desktop/longview_service.js";

export const allowAnonymous = false;

export function get(context) {
  const tail = Number(context.params?.tail || 20) || 20;
  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: longviewService.longviewStatus({ tail })
  };
}
