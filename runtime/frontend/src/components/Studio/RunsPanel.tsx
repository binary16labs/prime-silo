import React, { useEffect } from 'react';
import { motion } from 'framer-motion';
import { X, History, RefreshCw, CheckCircle2, XCircle, Loader, Clock, ExternalLink } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import ManifestCanvas from './ManifestCanvas';
import type { RunRecord, RunStatus } from '../../types/manifest';

/**
 * RunsPanel — history of past executions, reusing the same canvas component.
 *
 * Clicking a run overlays its per-task status onto the graph so you can see
 * which tasks completed vs failed on that specific run.
 */
export default function RunsPanel() {
  const {
    isRunsPanelOpen,
    setRunsPanelOpen,
    runs,
    loadRuns,
    loadRun,
    activeRun,
    setActiveRun,
    currentManifest,
    loadManifest,
  } = useWorkflowStore();

  useEffect(() => {
    if (isRunsPanelOpen) loadRuns();
  }, [isRunsPanelOpen, loadRuns]);

  if (!isRunsPanelOpen) return null;

  const openRun = async (r: RunRecord) => {
    const full = await loadRun(r.run_id);
    setActiveRun(full ?? r);
    if (full?.manifest_id && currentManifest?.id !== full.manifest_id) {
      await loadManifest(full.manifest_id);
    }
  };

  const manifestForOverlay =
    activeRun?.manifest_snapshot ??
    (currentManifest && currentManifest.id === activeRun?.manifest_id ? currentManifest : null);

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="fixed inset-4 md:inset-10 z-40 rounded-lg border border-white/15 bg-[#0b0e13]/95 shadow-2xl backdrop-blur-xl flex flex-col"
      style={{ pointerEvents: 'auto' }}
    >
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 text-blue-400" />
          <h2 className="text-sm font-medium text-white">Runs</h2>
          <span className="text-xs text-white/40">{runs.length} total</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => loadRuns()}
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Refresh"
            title="Refresh"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
          <button
            onClick={() => setRunsPanelOpen(false)}
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: list */}
        <div className="w-[360px] border-r border-white/10 overflow-y-auto">
          {runs.length === 0 && (
            <div className="px-5 py-4 text-sm text-white/40">
              No runs yet. Plan a manifest and click Run.
            </div>
          )}
          {runs.map((r) => (
            <button
              key={r.run_id}
              onClick={() => openRun(r)}
              className={`block w-full border-b border-white/5 px-4 py-3 text-left hover:bg-white/5 ${
                activeRun?.run_id === r.run_id ? 'bg-white/10' : ''
              }`}
            >
              <div className="flex items-center gap-2">
                <StatusIcon status={r.status} />
                <span className="text-sm font-medium text-white truncate">
                  {r.run_id}
                </span>
              </div>
              <div className="mt-1 text-xs text-white/50 truncate">
                manifest · {r.manifest_id.slice(0, 24)}
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px] text-white/40">
                <Clock className="h-3 w-3" />
                {r.started_at ? new Date(r.started_at + 'Z').toLocaleString() : '—'}
                {r.duration_ms ? (
                  <span className="rounded bg-white/5 px-1.5 py-0.5">{r.duration_ms}ms</span>
                ) : null}
              </div>
            </button>
          ))}
        </div>

        {/* RIGHT: detail */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {!activeRun && (
            <div className="flex h-full items-center justify-center text-sm text-white/40">
              Pick a run to see its graph + details.
            </div>
          )}
          {activeRun && (
            <>
              <div className="border-b border-white/10 px-5 py-3">
                <div className="flex items-center gap-2">
                  <StatusIcon status={activeRun.status} />
                  <span className="text-sm font-medium text-white">{activeRun.run_id}</span>
                  <span className="text-xs text-white/40">· {activeRun.status}</span>
                  {activeRun.governance_url && (
                    <a
                      href={activeRun.governance_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto flex items-center gap-1 text-xs text-blue-400 hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" />
                      lineage
                    </a>
                  )}
                </div>
                {activeRun.errors?.length > 0 && (
                  <div className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                    {activeRun.errors.slice(0, 3).map((e, i) => (
                      <div key={i}>{e}</div>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-hidden">
                {manifestForOverlay ? (
                  <ManifestCanvas manifest={manifestForOverlay} run={activeRun} />
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-white/40">
                    Manifest snapshot not available for this run.
                  </div>
                )}
              </div>

              {activeRun.final_document && (
                <div className="max-h-[30%] overflow-y-auto border-t border-white/10 bg-black/30 p-4">
                  <div className="mb-1 text-[11px] uppercase tracking-wide text-white/40">
                    Output
                  </div>
                  <pre className="whitespace-pre-wrap text-xs text-white/80">
                    {activeRun.final_document.slice(0, 4000)}
                    {activeRun.final_document.length > 4000 ? '\n…(truncated)' : ''}
                  </pre>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </motion.div>
  );
}

function StatusIcon({ status }: { status: RunStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-emerald-400" />;
    case 'partial_success':
      return <CheckCircle2 className="h-4 w-4 text-yellow-400" />;
    case 'failed':
    case 'cancelled':
      return <XCircle className="h-4 w-4 text-red-400" />;
    case 'running':
    case 'planning':
      return <Loader className="h-4 w-4 animate-spin text-blue-400" />;
    default:
      return <Clock className="h-4 w-4 text-white/40" />;
  }
}
