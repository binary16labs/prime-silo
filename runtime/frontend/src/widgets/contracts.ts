/**
 * ADR-001 — Widget registry frontend types.
 *
 * Mirrors `benny/api/widget_routes.py`. Phase A ships the contract; Phase C
 * migrates the existing Studio/Notebook/AgentAmp components into this folder
 * (one subdirectory per category) and registers their concrete manifests.
 *
 * The agent in the Review zone composes layouts as `LayoutDSL` documents —
 * pure JSON, signed when pinned, replayable.
 */

export type WidgetAuthority =
  | 'read_only'
  | 'read_write_sandbox'
  | 'deterministic_only';

export type WidgetCategory =
  | 'graph'
  | 'table'
  | 'timeline'
  | 'inspector'
  | 'dag'
  | 'text';

export interface FrameBinding {
  field: string;
  required: boolean;
  description?: string | null;
}

export interface WidgetManifest {
  id: string;
  schema_version: string;
  title: string;
  description: string;
  category: WidgetCategory;
  /** JSON Schema for the widget's props. */
  props: Record<string, unknown>;
  frame_bindings: FrameBinding[];
  authority: WidgetAuthority;
  defaults: Record<string, unknown>;
}

/**
 * Layout DSL — what the agent emits and what the shell renders.
 *
 * A LayoutDSL document is the JSON form of an `.aamp.view` bundle. Pinning a
 * layout HMAC-signs the document via `benny.agentamp.signing.sign_skin_pack`
 * (canonical-payload approach) so views are tamper-evident and replayable.
 */
export interface LayoutDSL {
  schema_version: '1.0.0';
  /** Stable id within the workspace's agent_sandbox/views/ directory. */
  id: string;
  title: string;
  /** Human-readable description shown in the playlist / palette. */
  description?: string;
  /** Optional binding to a frozen run output the layout reviews. */
  bound_run_id?: string;
  /** Tile layout — each entry references a registered widget by manifest id. */
  tiles: LayoutTile[];
  /** Filled in by the signing step; never authored by the agent directly. */
  signature?: AampViewSignature | null;
}

export interface LayoutTile {
  /** Stable id within the layout — used for keyed React reconciliation. */
  tile_id: string;
  /** References a `WidgetManifest.id`. */
  widget_id: string;
  /** Validated against `WidgetManifest.props` JSON Schema. */
  props: Record<string, unknown>;
  /** Snap-and-clamp coordinates per AgentAmp Phase 6 Layout DSL. */
  position: { x: number; y: number; w: number; h: number };
  /** Optional title override for this instance. */
  title?: string;
}

export interface AampViewSignature {
  algorithm: 'HMAC-SHA256';
  signature_hex: string;
  signed_at: string;
  signed_by: string;
}

/**
 * Header constants for talking to the backend with agent authority.
 *
 * The shell's agent runtime sets `X-Benny-Agent-Scope: sandbox` for any
 * mutating request. The `AgentScopeMiddleware` rejects sandbox-scoped writes
 * outside `/api/agent_sandbox/`. See ADR-001 §5.
 */
export const AGENT_SCOPE_HEADER = 'X-Benny-Agent-Scope';
export const AGENT_SCOPE_SANDBOX = 'sandbox';
export const AGENT_SCOPE_READ_ONLY = 'read_only';
