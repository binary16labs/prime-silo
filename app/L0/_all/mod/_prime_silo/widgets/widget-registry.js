// ADR-001 Phase C/D — widget registry client.
//
// Mirrors `runtime/frontend/src/widgets/contracts.ts` for browser-side use.
// Phase A registered the widget manifests in
// `runtime/benny/api/widget_routes.py`; this module fetches and caches them
// so layouts can resolve widget IDs to render-time props schemas.
//
// Public API
//   loadRegistry()      — fetches and caches the registry from the runtime
//   getRegistry()       — returns the cached registry; throws if not loaded
//   getWidget(id)       — returns a single widget manifest by id
//   isAuthorityAgentSafe(authority)
//                       — true if the agent may compose this widget
//
// Phase C: as canvases migrate (KG3D, dag.canvas, drill-down, frame
// inspector, lineage timeline), each gets a sibling folder here and is
// dynamically imported when its widget id appears in a layout.

import { listWidgets } from "../runtime_client/runtime-client.js";

/**
 * @typedef {"read_only"|"read_write_sandbox"|"deterministic_only"} WidgetAuthority
 *
 * @typedef {Object} FrameBinding
 * @property {string} field
 * @property {boolean} required
 * @property {string|null} [description]
 *
 * @typedef {Object} WidgetManifest
 * @property {string} id
 * @property {string} schema_version
 * @property {string} title
 * @property {string} description
 * @property {string} category
 * @property {Record<string, unknown>} props
 * @property {FrameBinding[]} frame_bindings
 * @property {WidgetAuthority} authority
 * @property {Record<string, unknown>} defaults
 */

let cachedRegistry = null;
let pendingLoad = null;

const AGENT_SAFE_AUTHORITIES = new Set(["read_only", "read_write_sandbox"]);

/**
 * Fetch the widget registry from the runtime. Subsequent calls return the
 * cached result; pass {refresh: true} to force a re-fetch.
 *
 * @param {{refresh?: boolean}} [options]
 * @returns {Promise<WidgetManifest[]>}
 */
export async function loadRegistry(options = {}) {
  if (cachedRegistry && !options.refresh) {
    return cachedRegistry;
  }

  if (pendingLoad && !options.refresh) {
    return pendingLoad;
  }

  pendingLoad = listWidgets()
    .then((registry) => {
      if (!Array.isArray(registry)) {
        throw new Error("Widget registry response was not an array.");
      }
      cachedRegistry = registry;
      return registry;
    })
    .finally(() => {
      pendingLoad = null;
    });

  return pendingLoad;
}

/** @returns {WidgetManifest[]} */
export function getRegistry() {
  if (!cachedRegistry) {
    throw new Error("Widget registry not loaded. Call loadRegistry() first.");
  }
  return cachedRegistry;
}

/**
 * @param {string} id
 * @returns {WidgetManifest|undefined}
 */
export function getWidget(id) {
  if (!cachedRegistry) {
    return undefined;
  }
  return cachedRegistry.find((w) => w.id === id);
}

/**
 * The agent may compose widgets whose authority is "read_only" or
 * "read_write_sandbox". `deterministic_only` widgets (e.g. `dag.canvas`)
 * may only be reached from static deterministic-zone shell pages.
 *
 * @param {WidgetAuthority} authority
 * @returns {boolean}
 */
export function isAuthorityAgentSafe(authority) {
  return AGENT_SAFE_AUTHORITIES.has(authority);
}

export const __testing = {
  resetCache() {
    cachedRegistry = null;
    pendingLoad = null;
  }
};
