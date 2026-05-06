import React, { useMemo } from 'react';
import { ReactFlow, Background, Controls, MiniMap, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { RunRecord, SwarmManifest, TaskStatus } from '../../types/manifest';

interface Props {
  manifest: SwarmManifest;
  run?: RunRecord | null;
}

const STATUS_COLOR: Record<string, string> = {
  pending: '#64748b',
  running: '#3b82f6',
  completed: '#10b981',
  failed: '#ef4444',
  skipped: '#6b7280',
};

const WAVE_WIDTH = 280;
const ROW_HEIGHT = 120;

export default function ManifestCanvas({ manifest, run }: Props) {
  const { nodes, edges } = useMemo(() => {
    if (!manifest || !manifest.plan) {
      return { nodes: [], edges: [] };
    }

    // 1. Normalize tasks into a list
    const rawTasks = manifest.plan.tasks || [];
    const taskList = Array.isArray(rawTasks)
      ? rawTasks
      : Object.entries(rawTasks).map(([id, t]: [string, any]) => ({
          ...t,
          id: t.id || id,
        }));

    // 2. Determine waves
    const waveOf: Record<string, number> = {};
    if (Array.isArray(manifest.plan.waves)) {
      manifest.plan.waves.forEach((waveTasks, waveIdx) => {
        if (Array.isArray(waveTasks)) {
          waveTasks.forEach((id) => {
            waveOf[id] = waveIdx;
          });
        }
      });
    }
    
    // Fallback for tasks not in plan.waves array
    taskList.forEach((t) => {
      if (waveOf[t.id] === undefined) {
        waveOf[t.id] = t.wave ?? 0;
      }
    });

    // 3. Vertical layout indexing
    const perWave: Record<number, number> = {};
    const yIndex: Record<string, number> = {};
    taskList.forEach((t) => {
      const w = waveOf[t.id] ?? 0;
      yIndex[t.id] = perWave[w] ?? 0;
      perWave[w] = (perWave[w] ?? 0) + 1;
    });

    // 4. Project Nodes
    const flowNodes = taskList.map((t) => {
      const status = run?.node_states?.[t.id] || t.status || 'pending';
      const color = STATUS_COLOR[status] || '#64748b';
      const wave = waveOf[t.id] ?? 0;
      const isPillar = Boolean(t.is_pillar);

      return {
        id: t.id,
        type: 'default',
        position: t.position || {
          x: wave * WAVE_WIDTH,
          y: (yIndex[t.id] ?? 0) * ROW_HEIGHT,
        },
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        style: {
          background: '#0b0e13',
          color: 'white',
          border: `2px solid ${color}`,
          borderRadius: '10px',
          padding: '12px',
          fontSize: '12px',
          minWidth: '220px',
          boxShadow: isPillar ? `0 0 15px ${color}40` : '0 4px 6px -1px rgb(0 0 0 / 0.1)',
        },
        data: {
          label: (
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontSize: '10px', textTransform: 'uppercase', opacity: 0.5, marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
                <span>Wave {wave}</span>
                {isPillar && <span style={{ color: 'var(--accent-primary)' }}>PILLAR</span>}
              </div>
              <div style={{ fontWeight: '600', marginBottom: '4px', whiteSpace: 'normal', lineBreak: 'anywhere' }}>
                {t.description || t.id}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: color }} />
                <span style={{ fontSize: '10px', color: color, fontWeight: 'bold', textTransform: 'uppercase' }}>{status}</span>
                {t.skill_hint && (
                  <span style={{ fontSize: '9px', background: 'rgba(16, 185, 129, 0.1)', color: '#10b981', padding: '1px 4px', borderRadius: '3px', marginLeft: 'auto' }}>
                    {t.skill_hint}
                  </span>
                )}
              </div>
            </div>
          ),
        },
      };
    });

    // 5. Project Edges
    const flowEdges = (manifest.plan.edges || []).map((e: any, i: number) => {
      const isArr = Array.isArray(e);
      const source = isArr ? e[0] : (e.source || '');
      const target = isArr ? e[1] : (e.target || '');
      
      return {
        id: e.id || `e-${source}-${target}-${i}`,
        source,
        target,
        animated: true,
        style: { stroke: 'rgba(255,255,255,0.3)', strokeWidth: 2 },
      };
    });

    return { nodes: flowNodes, edges: flowEdges };
  }, [manifest, run]);

  if (!nodes || nodes.length === 0) {
    return (
      <div style={{ 
        height: '100%', 
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        color: '#64748b',
        background: '#0b0e13',
        padding: '20px'
      }}>
        <div style={{ fontSize: '14px', fontWeight: '500' }}>No tasks to display</div>
        <div style={{ fontSize: '10px', marginTop: '8px', opacity: 0.6 }}>
          Manifest ID: {manifest?.id || 'unknown'}
        </div>
        {manifest?.plan?.tasks && (
          <div style={{ 
            marginTop: '20px', 
            padding: '12px', 
            border: '1px solid #1e293b', 
            borderRadius: '8px', 
            fontSize: '10px',
            maxHeight: '200px',
            overflow: 'auto',
            background: 'rgba(0,0,0,0.2)'
          }}>
             <div style={{ fontWeight: 'bold', color: '#94a3b8', marginBottom: '8px' }}>PLAN DATA PREVIEW:</div>
             <pre>{JSON.stringify(manifest.plan, null, 2)}</pre>
          </div>
        )}
      </div>
    );
  }

  return (
    <div style={{ width: '100%', height: '100%', minHeight: '500px' }}>
      <ReactFlow
        nodes={nodes as any}
        edges={edges as any}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#1f2937" gap={20} />
        <MiniMap pannable zoomable maskColor="rgba(0,0,0,0.6)" />
        <Controls />
      </ReactFlow>
    </div>
  );
}
