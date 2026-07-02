// POST /api/longview_run — launch the LONGVIEW pipeline (ADR-005) from the UI.
//
// Body: { mode?: "delta" | "all" | "inventory" | "extract" | "map" | "model" | "reduce" }
// Default mode is "delta" (the safe, incremental pass). The spawn goes through
// packaging/desktop/longview_service.js — the same single code path the tray
// uses — and the runner's own per-workspace lock guarantees one instance.
// Progress is observable at GET /api/longview_status.

import longviewService from "../../packaging/desktop/longview_service.js";

export const allowAnonymous = false;

export function post(context) {
  const body = context.body && typeof context.body === "object" ? context.body : {};
  const mode = String(body.mode || "delta");
  const result = longviewService.startLongview(mode);
  return {
    headers: { "Cache-Control": "no-store" },
    status: result.started ? 200 : 409,
    body: { format: "prime-silo.longview-run/1", ...result }
  };
}
