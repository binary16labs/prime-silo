// ADR-001 Phase E expansion — runs_explorer page entry.
//
// Second deterministic-zone shell page, paired with manifest_explorer.
// Routed at #/_prime_silo/runs_explorer (multi-segment hash route resolves
// to /mod/_prime_silo/runs_explorer/view.html).
//
// What this page does:
//   1. Fetch the run list at GET /api/runtime/manifests/runs   (no scope).
//   2. Resolve a run id from the URL ?run_id= query, or default to the
//      first (newest active or newest overall) run in the sorted list.
//   3. Fetch GET /api/runtime/manifests/runs/<id>              (no scope).
//   4. Prefer the run's `manifest_snapshot` when present (the planner
//      cached it at run creation — survives subsequent manifest edits).
//      Fall back to GET /api/runtime/manifests/<manifest_id> when not.
//   5. Build a run overlay from the RunRecord's `node_states` and feed
//      both manifest + overlay to `mapManifestToDagData`. The overlay
//      colors each task by its execution status, beating the manifest's
//      declared task status.
//   6. Mount dag.canvas in `manifest` mode against the result.
//
// Why no scope: same as manifest_explorer. Run history IS the
// deterministic-zone surface. Reads are open to humans without an
// X-Benny-Agent-Scope header.
//
// Why no agentContext flag on the dag.canvas mount: dag.canvas is
// `deterministic_only`. Rendering inside a deterministic-zone shell page
// hits the happy path; the agent-context refusal banner is exercised by
// its dedicated unit test.

import {
  runtimeFetch,
  readRuntimeJson
} from "../runtime_client/runtime-client.js";
import { createDagCanvasWidget } from "../widgets/dag/canvas/index.js";
import { mapManifestToDagData } from "../manifest_explorer/manifest-mapping.js";
import {
  summariseRun,
  buildRunOverlay,
  extractManifestSnapshot,
  sortRunsForDisplay,
  formatDuration
} from "./runs-mapping.js";

window.runsExplorer = function runsExplorer() {
  return {
    state: "loading",        // "loading" | "ready" | "empty" | "error"
    error: "",
    runs: [],                // sorted RunRecord list (active first, newest within bucket)
    activeRunId: "",
    summary: null,           // returned by summariseRun
    durationDisplay: "—",
    _widgetHandle: null,
    _canvasHost: null,

    async init() {
      this._canvasHost = this.$refs && this.$refs.canvas;
      if (!this._canvasHost) {
        this.state = "error";
        this.error = "runs_explorer: canvas host not found in DOM.";
        return;
      }
      try {
        await this.loadList();
        if (this.runs.length === 0) {
          this.state = "empty";
          return;
        }
        const requested = readRunIdFromQuery();
        const initialId = requested && this.runs.some((r) => r.run_id === requested)
          ? requested
          : this.runs[0].run_id;
        await this.selectRun(initialId);
      } catch (err) {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    async loadList() {
      const response = await runtimeFetch("/manifests/runs");
      const list = await readRuntimeJson(response);
      const safe = Array.isArray(list) ? list : [];
      // Filter to records with a real id — defensive against a partial
      // write surfacing in the listing endpoint.
      this.runs = sortRunsForDisplay(
        safe.filter((r) => r && typeof r.run_id === "string" && r.run_id)
      );
    },

    async selectRun(runId) {
      if (typeof runId !== "string" || !runId) return;
      this.activeRunId = runId;
      this.state = "loading";
      this.error = "";
      try {
        // 1. Pull the RunRecord (single source of truth for status overlay).
        const recordResponse = await runtimeFetch(
          `/manifests/runs/${encodeURIComponent(runId)}`
        );
        const record = await readRuntimeJson(recordResponse);

        // 2. Resolve the manifest body. Prefer the cached snapshot — it
        //    matches the manifest that was *actually executed*, even if
        //    the live manifest has since been edited.
        let manifest = extractManifestSnapshot(record);
        if (!manifest) {
          if (!record || typeof record.manifest_id !== "string" || !record.manifest_id) {
            throw new Error(
              `Run ${runId} has no manifest_snapshot and no manifest_id — cannot render.`
            );
          }
          const manifestResponse = await runtimeFetch(
            `/manifests/${encodeURIComponent(record.manifest_id)}`
          );
          manifest = await readRuntimeJson(manifestResponse);
        }

        // 3. Build summary + overlay.
        this.summary = summariseRun(record);
        this.durationDisplay = formatDuration(this.summary.durationMs);
        const overlay = buildRunOverlay(record);

        // 4. Map manifest → dag.canvas data, with the run overlay if any.
        const dagData = mapManifestToDagData(
          manifest,
          overlay ? { runOverlay: overlay } : undefined
        );
        this._mountDag(dagData);
        this.state = "ready";
      } catch (err) {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    _mountDag(data) {
      if (this._widgetHandle && typeof this._widgetHandle.update === "function") {
        this._widgetHandle.update({ data });
        return;
      }
      // Manifest mode + run overlay: dag.canvas paints the longest-path
      // layered layout and recolors per task status. No agentContext flag
      // — this is a deterministic-zone page.
      this._widgetHandle = createDagCanvasWidget(this._canvasHost, {
        mode: "manifest",
        data
      });
    },

    destroy() {
      if (this._widgetHandle && typeof this._widgetHandle.destroy === "function") {
        this._widgetHandle.destroy();
      }
      this._widgetHandle = null;
    }
  };
};

function readRunIdFromQuery() {
  try {
    // Hash routes carry their own query string after the route segment.
    const hash = typeof window !== "undefined" && window.location ? window.location.hash : "";
    if (!hash) return "";
    const queryIndex = hash.indexOf("?");
    if (queryIndex < 0) return "";
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    return params.get("run_id") || "";
  } catch {
    return "";
  }
}

// Exported for tests — kept off the default surface so consumers don't
// pull implementation detail.
export const __testing = {
  readRunIdFromQuery
};
