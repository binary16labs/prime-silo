import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import { X, Sparkles, FileText, Play, Download, Loader, Upload } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import ManifestCanvas from './ManifestCanvas';
import type { OutputFormat } from '../../types/manifest';

/**
 * ManifestPlanner — the plan-then-approve-then-run surface.
 *
 * Flow:
 *   1. User types a requirement (and optional output spec)
 *   2. POST /api/manifests/plan returns a full SwarmManifest (no execution)
 *   3. The right pane renders the manifest as a live graph + JSON view
 *   4. User clicks Run → POST /api/manifests/{id}/run
 *
 * The JSON that appears here is the *exact* contract that ships to the CLI.
 */
export default function ManifestPlanner() {
  const {
    isManifestPanelOpen,
    setManifestPanelOpen,
    planManifest,
    runManifest,
    currentManifest,
    isPlanning,
    isRunning,
    planError,
    setCurrentManifest,
    saveManifest,
  } = useWorkflowStore();

  const fileInputRef = useRef<HTMLInputElement>(null);

  const [requirement, setRequirement] = useState('');
  const [name, setName] = useState('');
  const [wordCount, setWordCount] = useState<number | ''>('');
  const [format, setFormat] = useState<OutputFormat>('md');
  const [inputs, setInputs] = useState('');
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [tab, setTab] = useState<'graph' | 'json' | 'ascii'>('graph');

  if (!isManifestPanelOpen) return null;

  const handlePlan = async () => {
    if (!requirement.trim()) return;
    await planManifest({
      requirement: requirement.trim(),
      name: name.trim() || undefined,
      max_concurrency: maxConcurrency,
      inputs: {
        files: inputs
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      },
      outputs: {
        files: [],
        format,
        word_count_target: wordCount === '' ? null : Number(wordCount),
        sections: [],
        spec: '',
      },
    });
  };

  const handleRun = async () => {
    if (!currentManifest) return;
    await runManifest(currentManifest.id);
  };

  const downloadJson = () => {
    if (!currentManifest) return;
    const blob = new Blob([JSON.stringify(currentManifest, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentManifest.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        
        // Basic validation: does it look like a manifest?
        if (!data.id || !data.plan) {
          alert('Invalid manifest: Must contain "id" and "plan" fields.');
          return;
        }

        // Set in state (designer will react)
        setCurrentManifest(data);
        
        // Optionally save to backend so it persists
        await saveManifest(data);
        
        alert('Manifest imported to designer.');
      } catch (error) {
        alert('Failed to parse manifest. Please ensure it is valid JSON.');
        console.error('Import error:', error);
      }
    };
    reader.readAsText(file);
    if (event.target) event.target.value = '';
  };

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
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h2 className="text-sm font-medium text-white">Manifest Planner</h2>
          <span className="text-xs text-white/40">plan → approve → run</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setManifestPanelOpen(false)}
            className="rounded p-1 text-white/50 hover:bg-white/10 hover:text-white"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* LEFT: planner form */}
        <div className="w-[380px] border-r border-white/10 p-5 overflow-y-auto">
          <input
            ref={fileInputRef}
            type="file"
            accept=".json"
            onChange={handleImport}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            className="mb-5 flex w-full items-center justify-center gap-2 rounded border border-white/15 bg-white/5 py-2.5 text-xs font-bold text-[#00FFFF] shadow-[0_0_10px_rgba(0,255,255,0.1)] hover:bg-[#00FFFF]/10 hover:shadow-[0_0_20px_rgba(0,255,255,0.2)] transition-all uppercase tracking-widest"
          >
            <Upload size={14} />
            Import Manifest JSON
          </button>

          <label className="block text-xs font-medium text-white/70 mb-1">Requirement</label>
          <textarea
            value={requirement}
            onChange={(e) => setRequirement(e.target.value)}
            rows={6}
            placeholder="e.g. Generate a 10,000-word market analysis comparing the LLM inference stacks of Cerebras, Groq, and SambaNova, using the attached whitepapers."
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500 focus:outline-none"
          />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-white/70 mb-1">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-report"
                className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/70 mb-1">Concurrency</label>
              <input
                type="number"
                min={1}
                max={16}
                value={maxConcurrency}
                onChange={(e) => setMaxConcurrency(Math.max(1, Number(e.target.value) || 1))}
                className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
          </div>

          <label className="mt-3 block text-xs font-medium text-white/70 mb-1">
            Input files (comma / newline separated)
          </label>
          <textarea
            value={inputs}
            onChange={(e) => setInputs(e.target.value)}
            rows={2}
            placeholder="whitepaper_a.pdf, whitepaper_b.pdf"
            className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder-white/30 focus:border-emerald-500 focus:outline-none"
          />

          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-white/70 mb-1">Target words</label>
              <input
                type="number"
                min={0}
                value={wordCount}
                onChange={(e) =>
                  setWordCount(e.target.value === '' ? '' : Number(e.target.value))
                }
                placeholder="10000"
                className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-white/70 mb-1">Format</label>
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value as OutputFormat)}
                className="w-full rounded border border-white/15 bg-black/30 px-3 py-2 text-sm text-white focus:border-emerald-500 focus:outline-none"
              >
                <option value="md">markdown</option>
                <option value="docx">docx</option>
                <option value="pdf">pdf</option>
                <option value="html">html</option>
                <option value="code">code</option>
                <option value="json">json</option>
                <option value="txt">txt</option>
              </select>
            </div>
          </div>

          <button
            onClick={handlePlan}
            disabled={isPlanning || !requirement.trim()}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
          >
            {isPlanning ? (
              <>
                <Loader className="h-4 w-4 animate-spin" />
                Planning…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Plan workflow
              </>
            )}
          </button>

          {planError && (
            <div className="mt-3 rounded border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
              {planError}
            </div>
          )}

          {currentManifest && (
            <>
              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="text-[11px] uppercase tracking-wide text-white/40">
                  Current manifest
                </div>
                <div className="mt-1 text-sm font-medium text-white">
                  {currentManifest.name}
                </div>
                <div className="mt-0.5 text-xs text-white/50">
                  {currentManifest.plan.tasks.length} tasks ·{' '}
                  {currentManifest.plan.waves.length} waves · id{' '}
                  <code className="text-emerald-400">{currentManifest.id.slice(0, 16)}</code>
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <button
                  onClick={handleRun}
                  disabled={isRunning}
                  className="flex flex-1 items-center justify-center gap-2 rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
                >
                  {isRunning ? (
                    <Loader className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  Run
                </button>
                <button
                  onClick={downloadJson}
                  title="Download manifest.json"
                  className="flex items-center justify-center rounded border border-white/15 px-3 py-2 text-white/70 hover:bg-white/5"
                >
                  <Download className="h-4 w-4" />
                </button>
              </div>
            </>
          )}
        </div>

        {/* RIGHT: manifest viewer */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-4 border-b border-white/10 px-5 py-2">
            {(['graph', 'json', 'ascii'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`text-xs capitalize ${
                  tab === t ? 'text-white' : 'text-white/40 hover:text-white/80'
                }`}
              >
                {t}
              </button>
            ))}
            <div className="ml-auto flex items-center gap-1 text-[11px] text-white/40">
              <FileText className="h-3 w-3" />
              schema {currentManifest?.schema_version ?? '—'}
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {!currentManifest && (
              <div className="flex h-full items-center justify-center text-sm text-white/40">
                No manifest yet. Describe a requirement on the left and click “Plan workflow”.
              </div>
            )}
            {currentManifest && tab === 'graph' && (
              <ManifestCanvas manifest={currentManifest} />
            )}
            {currentManifest && tab === 'json' && (
              <pre className="m-0 h-full overflow-auto bg-black/30 p-4 text-xs text-emerald-100">
                {JSON.stringify(currentManifest, null, 2)}
              </pre>
            )}
            {currentManifest && tab === 'ascii' && (
              <pre className="m-0 h-full overflow-auto bg-black/30 p-4 text-xs text-emerald-100">
                {currentManifest.plan.ascii_dag ?? '(no ASCII DAG emitted)'}
              </pre>
            )}
          </div>
        </div>
      </div>
    </motion.div>
  );
}
