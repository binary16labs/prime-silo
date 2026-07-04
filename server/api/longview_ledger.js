// GET /api/longview_ledger?since=<line>[&workspace=longview_v2]
//
// Incremental tail of the runner's append-only ledger.jsonl + the status.json
// heartbeat — the real-time telemetry feed. Poll with the returned `next` as
// the following `since`; the response contains only new entries, so a live
// Benny Record view (or telemetry strip) costs one cheap read per tick.
import longviewService from "../../packaging/desktop/longview_service.js";

export const allowAnonymous = false;

export function get(context) {
  const since = Number(context.params?.since || 0) || 0;
  const workspace = context.params?.workspace;
  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: longviewService.longviewLedger({ since, ...(workspace ? { workspace } : {}) })
  };
}
