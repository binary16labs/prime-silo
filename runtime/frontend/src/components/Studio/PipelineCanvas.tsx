/**
 * PipelineCanvas — Studio surface for Benny Pypes manifests.
 *
 * Renders a manifest's DAG (one node per step) with stage-coloured nodes,
 * step status (SUCCESS / WARN / FAIL), and click-through drill-down into
 * checkpointed rows + CLP provenance via the /api/pypes endpoints.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

const API_KEY = 'benny-mesh-2026-auth';
const NODE_W = 260;
const NODE_H = 110;
const GAP_X = 320;
const GAP_Y = 150;

const STAGE_COLOR: Record<string, string> = {
  bronze: '#a16207',
  silver: '#94a3b8',
  gold: '#d97706',
  raw: '#475569',
  feature: '#7c3aed',
  governed: '#0891b2',
};

const STATUS_COLOR: Record<string, string> = {
  PASS: '#10b981',
  WARN: '#f59e0b',
  FAIL: '#ef4444',
  SUCCESS: '#10b981',
  PARTIAL: '#f59e0b',
  FAILED: '#ef4444',
  SKIPPED: '#6b7280',
};

interface PypesStep {
  id: string;
  description?: string;
  engine: string;
  stage: string;
  inputs: string[];
  outputs?: string[];
  operations: any[];
  destination?: any;
  clp_binding?: Record<string, string>;
}

interface PypesManifest {
  id: string;
  name?: string;
  description?: string;
  workspace: string;
  governance?: { compliance_tags?: string[]; owner?: string };
  steps: PypesStep[];
  reports?: { id: string; title: string; kind: string }[];
}

interface StepOutcome {
  step_id: string;
  status: string;
  duration_ms?: number;
  validation?: { status: string; checks: any[] };
  error?: string;
}

interface RunReceipt {
  run_id: string;
  manifest_id: string;
  status: string;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  step_results: Record<string, StepOutcome>;
  reports?: Record<string, string>;
  signature?: string;
}

interface DrilldownPayload {
  run_id: string;
  step_id: string;
  row_count: number;
  columns: string[];
  clp_binding: Record<string, string>;
  stage: string | null;
  rows: Record<string, any>[];
}

interface Props {
  workspace: string;
  runId?: string;
  manifest?: PypesManifest;
  receipt?: RunReceipt;
}

export default function PipelineCanvas({ workspace, runId, manifest: manifestProp, receipt: receiptProp }: Props) {
  const [manifest, setManifest] = useState<PypesManifest | null>(manifestProp || null);
  const [receipt, setReceipt] = useState<RunReceipt | null>(receiptProp || null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drill, setDrill] = useState<DrilldownPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ---------------------------------------------------------------- Fetch run
  useEffect(() => {
    if (!runId || manifestProp) return;
    let active = true;
    setLoading(true);
    fetch(`/api/pypes/runs/${runId}?workspace=${encodeURIComponent(workspace)}`, {
      headers: { 'X-Benny-API-Key': API_KEY },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((d) => {
        if (!active) return;
        setManifest(d.manifest);
        setReceipt(d.receipt);
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [runId, workspace, manifestProp]);

  // ------------------------------------------------------------- DAG layout
  const { nodes, edges, waveOf } = useMemo(() => {
    if (!manifest) return { nodes: [], edges: [], waveOf: {} as Record<string, number> };

    const producers: Record<string, string> = {};
    manifest.steps.forEach((s) => {
      (s.outputs && s.outputs.length ? s.outputs : [s.id]).forEach((o) => {
        producers[o] = s.id;
      });
    });

    const wave: Record<string, number> = {};
    const visit = (id: string): number => {
      if (wave[id] !== undefined) return wave[id];
      const step = manifest.steps.find((s) => s.id === id);
      if (!step) return 0;
      const parents = step.inputs.map((inp) => producers[inp]).filter(Boolean) as string[];
      const w = parents.length ? Math.max(...parents.map(visit)) + 1 : 0;
      wave[id] = w;
      return w;
    };
    manifest.steps.forEach((s) => visit(s.id));

    const perWave: Record<number, number> = {};
    const ns = manifest.steps.map((s) => {
      const w = wave[s.id] ?? 0;
      const idx = perWave[w] ?? 0;
      perWave[w] = idx + 1;
      const outcome = receipt?.step_results?.[s.id];
      const stageHex = STAGE_COLOR[s.stage] ?? '#475569';
      const statusHex = outcome ? STATUS_COLOR[outcome.status] ?? '#64748b' : '#1e293b';
      return {
        id: s.id,
        position: { x: w * GAP_X + 60, y: idx * GAP_Y + 40 },
        data: {
          label: (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 4 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 12, color: stageHex, textTransform: 'uppercase', letterSpacing: 1 }}>
                  {s.stage}
                </strong>
                <span style={{ fontSize: 10, color: '#94a3b8' }}>{s.engine}</span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#e2e8f0' }}>{s.id}</div>
              <div style={{ fontSize: 10, color: '#64748b' }}>{s.operations.length} op{s.operations.length === 1 ? '' : 's'}</div>
              {outcome && (
                <div style={{ display: 'flex', gap: 6, marginTop: 2, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: statusHex }}>{outcome.status}</span>
                  {outcome.duration_ms !== undefined && (
                    <span style={{ fontSize: 10, color: '#64748b' }}>· {outcome.duration_ms}ms</span>
                  )}
                </div>
              )}
            </div>
          ),
        },
        style: {
          width: NODE_W,
          height: NODE_H,
          background: '#0f172a',
          border: `2px solid ${outcome ? statusHex : stageHex}`,
          borderRadius: 8,
          color: '#e2e8f0',
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
      };
    });

    const es: any[] = [];
    manifest.steps.forEach((s) => {
      s.inputs.forEach((inp) => {
        const src = producers[inp];
        if (src && src !== s.id) {
          es.push({
            id: `${src}->${s.id}`,
            source: src,
            target: s.id,
            label: inp,
            type: 'smoothstep',
            animated: receipt?.step_results?.[src]?.status === 'SUCCESS',
            style: { stroke: '#475569', strokeWidth: 1.5 },
            labelStyle: { fontSize: 10, fill: '#94a3b8' },
          });
        }
      });
    });

    return { nodes: ns, edges: es, waveOf: wave };
  }, [manifest, receipt]);

  // --------------------------------------------------------------- Drilldown
  const handleNodeClick = async (_: any, node: any) => {
    setSelected(node.id);
    setDrill(null);
    if (!runId) return;
    try {
      const res = await fetch(
        `/api/pypes/runs/${runId}/steps/${node.id}?workspace=${encodeURIComponent(workspace)}&rows=20`,
        { headers: { 'X-Benny-API-Key': API_KEY } },
      );
      if (!res.ok) {
        setError(`drilldown failed: ${res.statusText}`);
        return;
      }
      const data: DrilldownPayload = await res.json();
      setDrill(data);
    } catch (e) {
      setError(String(e));
    }
  };

  if (loading && !manifest) return <div style={{ padding: 24, color: '#94a3b8' }}>Loading pypes run…</div>;
  if (error) return <div style={{ padding: 24, color: '#ef4444' }}>Error: {error}</div>;
  if (!manifest) return <div style={{ padding: 24, color: '#94a3b8' }}>No manifest loaded.</div>;

  const stepDetail = selected ? manifest.steps.find((s) => s.id === selected) : null;

  return (
    <div style={{ display: 'flex', height: '100%', width: '100%' }}>
      <div style={{ flex: 1, position: 'relative', background: '#020617' }}>
        <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, color: '#e2e8f0', background: 'rgba(15,23,42,0.85)', padding: '8px 12px', borderRadius: 6, fontSize: 12 }}>
          <div style={{ fontWeight: 700 }}>{manifest.name || manifest.id}</div>
          <div style={{ color: '#94a3b8' }}>workspace: {manifest.workspace} · {manifest.steps.length} steps</div>
          {receipt && (
            <div style={{ marginTop: 4 }}>
              run <code>{receipt.run_id.slice(0, 8)}</code> · status{' '}
              <span style={{ color: STATUS_COLOR[receipt.status] ?? '#94a3b8', fontWeight: 700 }}>{receipt.status}</span>
            </div>
          )}
        </div>
        <ReactFlow nodes={nodes} edges={edges} onNodeClick={handleNodeClick} fitView>
          <Background color="#1e293b" gap={20} />
          <Controls />
          <MiniMap nodeColor={(n: any) => n.style?.borderColor || '#475569'} />
        </ReactFlow>
      </div>

      {stepDetail && (
        <div style={{ width: 360, background: '#0f172a', borderLeft: '1px solid #1e293b', color: '#e2e8f0', overflowY: 'auto', padding: 16 }}>
          <div style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1 }}>{stepDetail.stage} · {stepDetail.engine}</div>
          <h3 style={{ margin: '4px 0 8px', fontSize: 16 }}>{stepDetail.id}</h3>
          {stepDetail.description && <p style={{ fontSize: 12, color: '#cbd5e1' }}>{stepDetail.description}</p>}

          <h4 style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', marginTop: 12 }}>Operations</h4>
          <ul style={{ paddingLeft: 16, fontSize: 12 }}>
            {stepDetail.operations.map((o: any, i: number) => (
              <li key={i}><code>{o.operation}</code></li>
            ))}
          </ul>

          {stepDetail.clp_binding && Object.keys(stepDetail.clp_binding).length > 0 && (
            <>
              <h4 style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', marginTop: 12 }}>CLP Binding</h4>
              <table style={{ width: '100%', fontSize: 11, borderCollapse: 'collapse' }}>
                <tbody>
                  {Object.entries(stepDetail.clp_binding).map(([col, logical]) => (
                    <tr key={col}>
                      <td style={{ padding: '2px 4px', color: '#94a3b8' }}><code>{col}</code></td>
                      <td style={{ padding: '2px 4px' }}>{logical}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {drill && (
            <>
              <h4 style={{ fontSize: 11, color: '#94a3b8', textTransform: 'uppercase', marginTop: 12 }}>
                Checkpoint sample · {drill.row_count} rows
              </h4>
              <div style={{ overflowX: 'auto', maxHeight: 240, border: '1px solid #1e293b', borderRadius: 4 }}>
                <table style={{ width: '100%', fontSize: 10, borderCollapse: 'collapse' }}>
                  <thead style={{ background: '#1e293b' }}>
                    <tr>{drill.columns.map((c) => <th key={c} style={{ padding: 4, textAlign: 'left' }}>{c}</th>)}</tr>
                  </thead>
                  <tbody>
                    {drill.rows.slice(0, 10).map((row, i) => (
                      <tr key={i} style={{ borderTop: '1px solid #1e293b' }}>
                        {drill.columns.map((c) => (
                          <td key={c} style={{ padding: 4 }}>{String(row[c] ?? '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {selected && !drill && runId && (
            <p style={{ fontSize: 11, color: '#64748b', marginTop: 12 }}>Loading checkpoint…</p>
          )}
        </div>
      )}
    </div>
  );
}
