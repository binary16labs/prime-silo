import React, { useMemo, useRef } from 'react';
import { useWorkflowStore } from '../../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../../hooks/useWorkspaceStore';
import { Sonification } from './SonificationEngine';
import { Clock, ChevronsRight } from 'lucide-react';

export function TimeTravelScrubber() {
  const { cognitiveMesh, setCognitiveMeshValue } = useWorkflowStore();
  const { graphCatalog, activeGraphId, setActiveGraphId } = useWorkspaceStore() as any;
  const lastEmit = useRef(0);

  const snapshots = useMemo(
    () => graphCatalog
      .filter((g: any) => g.type === 'code')
      .slice()
      .sort((a: any, b: any) => {
        const ta = typeof a.timestamp === 'number' ? a.timestamp : new Date(a.timestamp || 0).getTime();
        const tb = typeof b.timestamp === 'number' ? b.timestamp : new Date(b.timestamp || 0).getTime();
        return ta - tb;
      }),
    [graphCatalog]
  );

  if (!cognitiveMesh.timeTravelOpen) return null;
  if (snapshots.length < 2) {
    return (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 px-4 py-2 rounded-full bg-black/60 border border-white/10 text-[9px] font-mono text-white/40 tracking-widest uppercase pointer-events-none">
        Time Travel :: need ≥ 2 snapshots
      </div>
    );
  }

  const idx = Math.min(cognitiveMesh.timeScrubIndex, snapshots.length - 1);
  const current = snapshots[idx];

  const onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = Number(e.target.value);
    setCognitiveMeshValue('timeScrubIndex', v);
    const snap = snapshots[v];
    if (snap && snap.id !== activeGraphId) {
      setActiveGraphId(snap.id);
      const now = performance.now();
      if (now - lastEmit.current > 120) {
        Sonification.emit('commit', { pitchOffset: (v % 12) - 6 });
        lastEmit.current = now;
      }
    }
  };

  const formatDate = (t: any) => {
    if (!t) return '—';
    try { return new Date(t).toLocaleDateString(); } catch { return '—'; }
  };

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 w-[640px] max-w-[80vw] rounded-2xl bg-black/70 border border-[#FF5F1F]/30 backdrop-blur-xl px-5 py-4 shadow-2xl pointer-events-auto"
    >
      <div className="flex items-center justify-between mb-2 text-[8px] font-black tracking-[0.25em] uppercase">
        <div className="flex items-center gap-2 text-[#FF5F1F]/70">
          <Clock size={10} /> TIME_TRAVEL
        </div>
        <div className="flex items-center gap-2 text-white/50 font-mono">
          <span className="truncate max-w-[220px]" title={current?.name}>{current?.name || '—'}</span>
          <ChevronsRight size={10} />
          <span>{idx + 1}/{snapshots.length}</span>
        </div>
      </div>
      <input
        type="range"
        min={0}
        max={snapshots.length - 1}
        step={1}
        value={idx}
        onChange={onChange}
        className="w-full h-1.5 bg-white/10 rounded-full appearance-none cursor-pointer accent-[#FF5F1F]"
      />
      <div className="mt-2 flex items-center justify-between text-[7px] font-mono text-white/30">
        <span>{formatDate(snapshots[0].timestamp)}</span>
        <span>COMPRESSION {cognitiveMesh.timeCompression}x</span>
        <span>{formatDate(snapshots[snapshots.length - 1].timestamp)}</span>
      </div>
    </div>
  );
}
