// Mirrors benny/core/manifest.py. Keep in sync when the Python model changes.
// Intentionally loose (string unions) so the UI doesn't crash on a schema bump.

export type OutputFormat = 'md' | 'docx' | 'pdf' | 'html' | 'code' | 'json' | 'txt';
export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
export type RunStatus =
  | 'pending'
  | 'planning'
  | 'running'
  | 'completed'
  | 'partial_success'
  | 'failed'
  | 'cancelled';

export interface OutputSpec {
  files: string[];
  format: OutputFormat;
  word_count_target?: number | null;
  sections: string[];
  spec: string;
}

export interface InputSpec {
  files: string[];
  context: Record<string, unknown>;
}

export interface ManifestConfig {
  model: string;
  max_concurrency: number;
  max_depth: number;
  handover_summary_limit: number;
  allow_swarm: boolean;
  skills_allowed: string[];
}

export interface ManifestTask {
  id: string;
  description: string;
  skill_hint?: string | null;
  assigned_skills: string[];
  assigned_model?: string | null;
  dependencies: string[];
  wave: number;
  depth: number;
  parent_id?: string | null;
  is_pillar: boolean;
  is_expanded: boolean;
  complexity: 'low' | 'medium' | 'high';
  files_touched: string[];
  estimated_tokens?: number | null;
  status: TaskStatus;
  position?: { x: number; y: number } | null;
  node_type: string;
}

export interface ManifestEdge {
  id?: string | null;
  source: string;
  target: string;
  label?: string | null;
  animated: boolean;
}

export interface ManifestPlan {
  tasks: ManifestTask[];
  edges: ManifestEdge[];
  waves: string[][];
  ascii_dag?: string | null;
}

export interface RunRecord {
  run_id: string;
  manifest_id: string;
  workspace: string;
  status: RunStatus;
  started_at?: string | null;
  completed_at?: string | null;
  duration_ms?: number | null;
  final_document?: string | null;
  artifact_paths: string[];
  node_states: Record<string, TaskStatus>;
  governance_url?: string | null;
  errors: string[];
  trace_id?: string | null;
  manifest_snapshot?: SwarmManifest | null;
  created_at: string;
}

export interface SwarmManifest {
  schema_version: string;
  id: string;
  name: string;
  description: string;
  requirement: string;
  workspace: string;
  inputs: InputSpec;
  outputs: OutputSpec;
  plan: ManifestPlan;
  config: ManifestConfig;
  created_at: string;
  updated_at: string;
  created_by: string;
  tags: string[];
  metadata: Record<string, unknown>;
  latest_run?: RunRecord | null;
}

// -----------------------------------------------------------------------------
// Canvas projection — convert a manifest's plan into xyflow nodes/edges.
//
// Auto-layout: tasks laid out left-to-right by wave index, stacked vertically
// within a wave. Saved positions (task.position) win over auto-layout.
// -----------------------------------------------------------------------------

interface CanvasNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: Record<string, unknown>;
}

interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  animated: boolean;
  label?: string;
  style?: Record<string, unknown>;
}

const WAVE_WIDTH = 260;
const ROW_HEIGHT = 110;

export function manifestToCanvas(
  manifest: SwarmManifest,
  runOverlay?: RunRecord | null,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  // Resilience: handle tasks as either an array or an object
  const rawTasks = manifest.plan?.tasks || [];
  const taskList: ManifestTask[] = Array.isArray(rawTasks)
    ? rawTasks
    : Object.entries(rawTasks).map(([id, t]: [string, any]) => ({
        ...t,
        id: t.id || id,
      }));

  // Resilience: Derive wave index from plan.waves if not explicitly on the task
  const waveOf: Record<string, number> = {};
  if (manifest.plan && Array.isArray(manifest.plan.waves)) {
    manifest.plan.waves.forEach((waveTasks, waveIdx) => {
      if (Array.isArray(waveTasks)) {
        waveTasks.forEach((id) => {
          waveOf[id] = waveIdx;
        });
      }
    });
  }
  
  // Fallback for tasks not in plan.waves
  taskList.forEach((t) => {
    if (waveOf[t.id] === undefined) {
      waveOf[t.id] = t.wave ?? 0;
    }
  });

  // Count tasks per wave so we can stack them vertically.
  const perWave: Record<number, number> = {};
  const yIndex: Record<string, number> = {};
  taskList.forEach((t) => {
    const w = waveOf[t.id] ?? 0;
    yIndex[t.id] = perWave[w] ?? 0;
    perWave[w] = (perWave[w] ?? 0) + 1;
  });

  const nodes: CanvasNode[] = taskList.map((t) => {
    const overlayStatus = runOverlay?.node_states?.[t.id];
    const status = overlayStatus ?? t.status ?? 'pending';
    const wave = waveOf[t.id] ?? 0;

    return {
      id: t.id,
      type: nodeTypeForTask(t),
      position:
        t.position ?? {
          x: wave * WAVE_WIDTH,
          y: (yIndex[t.id] ?? 0) * ROW_HEIGHT,
        },
      data: {
        label: t.description || t.id,
        task_id: t.id,
        wave,
        depth: t.depth,
        is_pillar: t.is_pillar,
        skill_hint: t.skill_hint,
        model: t.assigned_model,
        complexity: t.complexity,
        status,
        config: {
          skill_hint: t.skill_hint ?? null,
          assigned_model: t.assigned_model ?? null,
        },
      },
    };
  });

  // Resilience: handle edges as objects {source, target} or arrays [source, target]
  const edges: CanvasEdge[] = (manifest.plan.edges || []).map((e: any, i: number) => {
    const isArr = Array.isArray(e);
    const source = isArr ? e[0] : (e.source || '');
    const target = isArr ? e[1] : (e.target || '');
    
    return {
      id: (e as any).id ?? `e_${source}_${target}_${i}`,
      source,
      target,
      animated: (e as any).animated ?? true,
      label: (e as any).label ?? undefined,
    };
  });

  return { nodes, edges };
}

function nodeTypeForTask(t: ManifestTask): string {
  if (t.node_type && t.node_type !== 'task') return t.node_type;
  if (t.is_pillar) return 'logic';
  if (t.skill_hint) return 'tool';
  return 'llm';
}
