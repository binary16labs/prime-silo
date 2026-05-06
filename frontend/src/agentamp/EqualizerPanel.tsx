/**
 * AgentAmp Equalizer Panel — Phase 5 (AAMP-F9, AAMP-F10)
 *
 * Renders a list of EQ knobs and calls PUT /api/agentamp/eq on submit.
 * Allowed paths are the EQ_ALLOWED_PATHS allow-list from the backend.
 */

import { useState } from 'react';
import { Sliders, Lock, Unlock, Plus, Trash2, CheckCircle, AlertCircle, Loader } from 'lucide-react';

// Mirror of benny.agentamp.equalizer.EQ_ALLOWED_PATHS
const EQ_ALLOWED_PATHS = [
  'config.model',
  'config.max_concurrency',
  'config.max_depth',
  'config.handover_summary_limit',
  'config.allow_swarm',
  'config.skills_allowed',
  'config.model_per_persona',
  'tasks[*].assigned_model',
  'tasks[*].complexity',
  'tasks[*].deterministic',
  'tasks[*].estimated_tokens',
];

// Sensible default value placeholders per path
const VALUE_HINTS: Record<string, string> = {
  'config.model': 'e.g. gpt-4o',
  'config.max_concurrency': 'e.g. 4',
  'config.max_depth': 'e.g. 5',
  'config.handover_summary_limit': 'e.g. 2048',
  'config.allow_swarm': 'true / false',
  'config.skills_allowed': '["skill_a","skill_b"]',
  'config.model_per_persona': '{"aamp:user":"gpt-4o"}',
  'tasks[*].assigned_model': 'e.g. gpt-4o-mini',
  'tasks[*].complexity': '1..5',
  'tasks[*].deterministic': 'true / false',
  'tasks[*].estimated_tokens': 'e.g. 1024',
};

interface Knob {
  id: number;
  path: string;
  value: string;
  locked: boolean;
}

interface EqWriteResponse {
  updated_manifest: Record<string, unknown>;
  new_signature: { value: string; signed_at: string; algorithm: string };
  previous_signatures: unknown[];
  ledger_seq: number;
}

let _nextId = 1;

function makeKnob(): Knob {
  return { id: _nextId++, path: EQ_ALLOWED_PATHS[0], value: '', locked: false };
}

function parseValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  const n = Number(trimmed);
  if (!isNaN(n) && trimmed !== '') return n;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

export default function EqualizerPanel() {
  const [workspace, setWorkspace] = useState('default');
  const [knobs, setKnobs] = useState<Knob[]>([makeKnob()]);
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [result, setResult] = useState<EqWriteResponse | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  function addKnob() {
    setKnobs(prev => [...prev, makeKnob()]);
  }

  function removeKnob(id: number) {
    setKnobs(prev => prev.filter(k => k.id !== id));
  }

  function updateKnob(id: number, patch: Partial<Knob>) {
    setKnobs(prev => prev.map(k => (k.id === id ? { ...k, ...patch } : k)));
  }

  async function handleApply() {
    // Build a minimal demo manifest to send (real usage would pass an actual manifest)
    const demoManifest = {
      schema_version: '1.0',
      config: {
        model: 'gpt-4o',
        max_concurrency: 2,
        max_depth: 5,
        handover_summary_limit: 2048,
        allow_swarm: true,
        skills_allowed: [],
        model_per_persona: {},
      },
      plan: { tasks: [] },
    };

    const payload = {
      manifest: demoManifest,
      workspace,
      persona: 'aamp:user',
      knobs: knobs.map(k => ({
        path: k.path,
        value: parseValue(k.value),
        locked: k.locked,
      })),
    };

    setStatus('loading');
    setErrorMsg('');
    setResult(null);

    try {
      const res = await fetch('/api/agentamp/eq', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Benny-API-Key': 'benny-mesh-2026-auth',
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail ?? res.statusText);
      }

      const data: EqWriteResponse = await res.json();
      setResult(data);
      setStatus('success');
    } catch (err: unknown) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Sliders size={18} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Equalizer
        </span>
        <span style={{
          marginLeft: 'auto',
          fontSize: '11px',
          color: 'var(--text-tertiary)',
          fontFamily: 'monospace',
        }}>
          AAMP-F9 / F10
        </span>
      </div>

      {/* Workspace */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <label style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
          Workspace
        </label>
        <input
          type="text"
          value={workspace}
          onChange={e => setWorkspace(e.target.value)}
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '6px 10px',
            fontSize: '13px',
            color: 'var(--text-primary)',
            outline: 'none',
          }}
          placeholder="default"
        />
      </div>

      {/* Knob rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <label style={{ fontSize: '11px', color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Knobs
          </label>
          <button
            onClick={addKnob}
            style={{
              display: 'flex', alignItems: 'center', gap: '4px',
              background: 'none', border: '1px solid var(--border-color)',
              borderRadius: '6px', padding: '3px 8px', cursor: 'pointer',
              fontSize: '11px', color: 'var(--text-secondary)',
            }}
          >
            <Plus size={12} /> Add knob
          </button>
        </div>

        {knobs.map(knob => (
          <div
            key={knob.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr auto auto',
              gap: '6px',
              alignItems: 'center',
              background: 'var(--surface-raised)',
              borderRadius: '8px',
              padding: '8px',
              border: '1px solid var(--border-color)',
            }}
          >
            {/* Path selector */}
            <select
              value={knob.path}
              onChange={e => updateKnob(knob.id, { path: e.target.value })}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border-color)',
                borderRadius: '5px',
                padding: '5px 6px',
                fontSize: '12px',
                color: 'var(--text-primary)',
                cursor: 'pointer',
                fontFamily: 'monospace',
              }}
            >
              {EQ_ALLOWED_PATHS.map(p => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>

            {/* Value input */}
            <input
              type="text"
              value={knob.value}
              onChange={e => updateKnob(knob.id, { value: e.target.value })}
              placeholder={VALUE_HINTS[knob.path] ?? 'value'}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border-color)',
                borderRadius: '5px',
                padding: '5px 8px',
                fontSize: '12px',
                color: 'var(--text-primary)',
                outline: 'none',
              }}
            />

            {/* Lock toggle */}
            <button
              onClick={() => updateKnob(knob.id, { locked: !knob.locked })}
              title={knob.locked ? 'Locked across runs' : 'Unlocked'}
              style={{
                background: knob.locked ? 'rgba(var(--accent-primary-rgb, 99,102,241), 0.15)' : 'none',
                border: `1px solid ${knob.locked ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                borderRadius: '5px',
                padding: '5px',
                cursor: 'pointer',
                color: knob.locked ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                display: 'flex', alignItems: 'center',
              }}
            >
              {knob.locked ? <Lock size={13} /> : <Unlock size={13} />}
            </button>

            {/* Remove */}
            <button
              onClick={() => removeKnob(knob.id)}
              disabled={knobs.length === 1}
              style={{
                background: 'none',
                border: '1px solid var(--border-color)',
                borderRadius: '5px',
                padding: '5px',
                cursor: knobs.length === 1 ? 'not-allowed' : 'pointer',
                color: 'var(--text-tertiary)',
                display: 'flex', alignItems: 'center',
                opacity: knobs.length === 1 ? 0.4 : 1,
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>

      {/* Apply button */}
      <button
        onClick={handleApply}
        disabled={status === 'loading'}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
          padding: '10px 16px',
          background: status === 'loading' ? 'var(--surface-raised)' : 'var(--gradient-primary)',
          border: 'none',
          borderRadius: '8px',
          fontSize: '13px',
          fontWeight: 600,
          color: '#fff',
          cursor: status === 'loading' ? 'not-allowed' : 'pointer',
          transition: 'all 0.2s',
        }}
      >
        {status === 'loading' ? (
          <><Loader size={14} style={{ animation: 'spin 1s linear infinite' }} /> Applying…</>
        ) : (
          <><Sliders size={14} /> Apply EQ Write</>
        )}
      </button>

      {/* Result / Error */}
      {status === 'success' && result && (
        <div style={{
          background: 'rgba(16,185,129,0.08)',
          border: '1px solid rgba(16,185,129,0.3)',
          borderRadius: '8px',
          padding: '12px',
          display: 'flex', flexDirection: 'column', gap: '6px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#10b981', fontWeight: 600, fontSize: '13px' }}>
            <CheckCircle size={14} /> Write applied
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
            Ledger seq: <strong style={{ color: 'var(--text-primary)' }}>#{result.ledger_seq}</strong>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontFamily: 'monospace', wordBreak: 'break-all' }}>
            Sig: <strong style={{ color: 'var(--accent-primary)', fontSize: '11px' }}>
              {result.new_signature?.value?.slice(0, 32)}…
            </strong>
          </div>
          {result.previous_signatures.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
              {result.previous_signatures.length} previous signature(s) preserved (AAMP-COMP2)
            </div>
          )}
        </div>
      )}

      {status === 'error' && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: '8px',
          padding: '12px',
          display: 'flex', flexDirection: 'column', gap: '6px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', color: '#ef4444', fontWeight: 600, fontSize: '13px' }}>
            <AlertCircle size={14} /> Write failed
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{errorMsg}</div>
        </div>
      )}
    </div>
  );
}
