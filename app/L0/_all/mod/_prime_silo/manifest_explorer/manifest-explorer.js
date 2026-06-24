// ADR-001 Phase E — manifest_explorer page entry.
//
// First deterministic-zone shell page. Routed at #/_prime_silo/manifest_explorer
// (the router resolves multi-segment routes to /mod/<author>/<repo>/<path>/view.html;
// in this fork the "author/repo" segment is `_prime_silo/manifest_explorer`).
//
// What this page does:
//   1. Fetch the manifest list at GET /api/runtime/manifests   (no scope).
//   2. Resolve a manifest id from the URL ?manifest_id= query, or default to
//      the first manifest in the list.
//   3. Fetch GET /api/runtime/manifests/<id>                   (no scope).
//   4. Map the SwarmManifest into {nodes, edges} via manifest-mapping.js.
//   5. Mount the dag.canvas widget in "manifest" mode against the result.
//
// Why no scope: the manifest registry IS the deterministic-zone surface.
// Reads are open to humans without an X-Benny-Agent-Scope header. An agent
// turn observing this page through the bound runtime client would still
// succeed (reads are unrestricted), but THIS page is human-driven by design.
//
// Why no agentContext flag on the dag.canvas mount: dag.canvas is
// `deterministic_only`. Rendering inside a deterministic-zone shell page
// hits the happy path; the agent-context refusal banner is exercised by its
// dedicated unit test.

// Relative imports so node-based tests can resolve the same module graph
// the shell mod loader resolves via /mod/<path> at runtime.
import { runtimeFetch, readRuntimeJson } from "../runtime_client/runtime-client.js";
import { createDagCanvasWidget } from "../widgets/dag/canvas/index.js";
import { mapManifestToDagData, summariseManifest } from "./manifest-mapping.js";

window.manifestExplorer = function manifestExplorer() {
  return {
    state: "loading", // "loading" | "ready" | "empty" | "error"
    error: "",
    manifests: [], // [{ id, requirement }]
    activeId: "",
    summary: null, // returned by summariseManifest
    _widgetHandle: null,
    _canvasHost: null,

    async init() {
      this._canvasHost = this.$refs && this.$refs.canvas;
      if (!this._canvasHost) {
        this.state = "error";
        this.error = "manifest_explorer: canvas host not found in DOM.";
        return;
      }
      try {
        await this.loadList();
        if (this.manifests.length === 0) {
          this.state = "empty";
          return;
        }
        const requested = readManifestIdFromQuery();
        const initialId =
          requested && this.manifests.some((m) => m.id === requested)
            ? requested
            : this.manifests[0].id;
        await this.selectManifest(initialId);
      } catch (err) {
        this.state = "error";
        this.error = err && err.message ? err.message : String(err);
      }
    },

    async loadList() {
      const response = await runtimeFetch("/manifests");
      const list = await readRuntimeJson(response);
      this.manifests = Array.isArray(list)
        ? list
            .map((m) => ({
              id: typeof m.id === "string" ? m.id : "",
              requirement: typeof m.requirement === "string" ? m.requirement : ""
            }))
            .filter((m) => m.id)
        : [];
    },

    async selectManifest(manifestId) {
      if (typeof manifestId !== "string" || !manifestId) return;
      this.activeId = manifestId;
      this.state = "loading";
      this.error = "";
      try {
        const response = await runtimeFetch(`/manifests/${encodeURIComponent(manifestId)}`);
        const manifest = await readRuntimeJson(response);
        this.summary = summariseManifest(manifest);
        const dagData = mapManifestToDagData(manifest);
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

function readManifestIdFromQuery() {
  try {
    // Hash routes carry their own query string after the route segment, so
    // window.location.search is empty. Parse from the hash if present.
    const hash = typeof window !== "undefined" && window.location ? window.location.hash : "";
    if (!hash) return "";
    const queryIndex = hash.indexOf("?");
    if (queryIndex < 0) return "";
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    return params.get("manifest_id") || "";
  } catch {
    return "";
  }
}

// Exported for tests — kept off the default surface so consumers don't pull
// implementation detail.
export const __testing = {
  readManifestIdFromQuery
};
