import React from 'react';
import { motion } from 'framer-motion';
import type { MeshAnalysis } from './CognitiveMeshEngine';

export interface AgenticWidget {
  kind: 'panel';
  title: string;
  fields: Array<{ label: string; value: string }>;
  actions: Array<{ id: string; label: string; color?: string }>;
}

interface Props {
  selectedNode: any | null;
  analysis: MeshAnalysis | null;
  enabled: boolean;
  onAction: (actionId: string) => void;
}

export function buildWidgetForNode(node: any, analysis: MeshAnalysis | null): AgenticWidget {
  const degree = analysis?.degreeMap.get(node.id) ?? 0;
  return {
    kind: 'panel',
    title: node.name || node.id,
    fields: [
      { label: 'Type', value: String(node.type) },
      { label: 'Degree', value: String(degree) },
      { label: 'Community', value: String(node.metadata?.community_name || node.metadata?.community_id || '—') },
    ],
    actions: [
      { id: 'trace',  label: 'Trace',  color: '#00FFFF' },
      { id: 'prune',  label: 'Prune',  color: '#FF5F1F' },
      { id: 'summon', label: 'Summon', color: '#FF00FF' },
    ],
  };
}

export function AgenticPanel({ selectedNode, analysis, enabled, onAction }: Props) {
  if (!enabled || !selectedNode) return null;
  const widget = buildWidgetForNode(selectedNode, analysis);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.9, y: 20 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9, y: 20 }}
      className="absolute bottom-[120px] left-4 z-40 w-64 rounded-2xl border border-[#FF00FF]/20 bg-black/60 backdrop-blur-[40px] p-4 shadow-[0_0_24px_rgba(255,0,255,0.08)]"
    >
      <div className="text-[8px] font-black text-[#FF00FF]/50 uppercase tracking-[0.2em] mb-2 flex items-center gap-2">
        <div className="w-1 h-1 rounded-full bg-[#FF00FF] animate-pulse" />
        A2UI_CONTEXT
      </div>
      <div className="text-[11px] font-black text-white tracking-wider truncate" title={widget.title}>{widget.title}</div>
      <div className="mt-3 space-y-1.5">
        {widget.fields.map(f => (
          <div key={f.label} className="flex items-center justify-between text-[9px] font-mono">
            <span className="text-white/40">{f.label}</span>
            <span className="text-white/90 truncate max-w-[140px]" title={f.value}>{f.value}</span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {widget.actions.map(a => (
          <button
            key={a.id}
            onClick={(e) => { e.stopPropagation(); onAction(a.id); }}
            className="px-2.5 py-1 rounded-lg border text-[8px] font-black tracking-widest uppercase hover:bg-white/10 transition-all"
            style={{ color: a.color || '#FFFFFF', borderColor: (a.color || '#FFFFFF') + '40' }}
          >
            {a.label}
          </button>
        ))}
      </div>
    </motion.div>
  );
}
