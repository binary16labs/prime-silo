// GET /api/longview_record?scope=card:<sid8>|section:<id>|dossier:<n>|book|run
//                          [&workspace=longview_v2]
//
// Benny Record: the full provenance of an output — an ordered, human-captioned
// action timeline (every LLM call, gate verdict, ingest) plus the lineage tree
// (deliverable → evidence → cards → windows → source session log). Read-only,
// disk-backed (ledger + meta files), assembled by scripts/longview/lib/record.mjs.
import longviewService from "../../packaging/desktop/longview_service.js";

export const allowAnonymous = false;

export function get(context) {
  const scope = String(context.params?.scope || "run");
  const workspace = context.params?.workspace;
  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: longviewService.longviewRecord({ scope, ...(workspace ? { workspace } : {}) })
  };
}
