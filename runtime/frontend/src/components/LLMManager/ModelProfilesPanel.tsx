import React, { useEffect, useState, useCallback } from 'react';
import { BrainCircuit } from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

/**
 * Model Profiles — capability-aware thinking control (default-safe).
 *
 * Per provider you pick an active profile; per model you set its thinking class:
 *   capable  — reasons but safe to /no_think → auto-suppressed for synthesis
 *   fragile  — /no_think EMPTIES it → never suppressed (FLM family)
 *   none     — not a reasoning model
 *
 * Backed by /api/llm/profiles (built-in defaults < configs file < workspace file).
 */

const CAP_COLOR: Record<string, string> = {
  capable: 'var(--accent-success)',
  fragile: '#f59e0b',
  none: 'var(--text-muted)',
};

interface ProfilesData {
  available_profiles: string[];
  active_by_provider: Record<string, string>;
  capabilities: Record<string, Record<string, string>>;
  suppress_thinking_roles: string[];
}

export default function ModelProfilesPanel({ workspace }: { workspace: string }) {
  const [data, setData] = useState<ProfilesData | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE_URL}/api/llm/profiles?workspace=${encodeURIComponent(workspace)}`, {
        headers: { ...GOVERNANCE_HEADERS },
      });
      if (r.ok) setData(await r.json());
    } catch (e) {
      console.error('load profiles failed', e);
    }
  }, [workspace]);

  useEffect(() => { load(); }, [load]);

  const post = async (body: any) => {
    setBusy(true);
    try {
      const r = await fetch(`${API_BASE_URL}/api/llm/profiles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...GOVERNANCE_HEADERS },
        body: JSON.stringify({ workspace, ...body }),
      });
      if (r.ok) setData(await r.json());
    } catch (e) {
      console.error('save profiles failed', e);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return null;

  // Capabilities of the 'default' profile drive the editable table.
  const models = data.capabilities?.default || {};

  return (
    <div style={{ gridColumn: '1 / -1', marginTop: '8px' }}>
      <h3 style={{ fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-muted)', marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
        <BrainCircuit size={14} /> Model Profiles · Thinking Capability
      </h3>

      {/* Per-provider active profile */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px' }}>
        {Object.entries(data.active_by_provider).map(([provider, active]) => (
          <div key={provider} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '8px 12px', background: 'rgba(255,255,255,0.03)', border: '1px solid var(--border-color)', borderRadius: '10px' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>{provider}</span>
            <select
              value={active}
              disabled={busy}
              onChange={(e) => post({ provider_profiles: { [provider]: e.target.value } })}
              style={{ background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: '6px', fontSize: '11px', padding: '3px 6px', color: 'var(--text-main)' }}
            >
              {data.available_profiles.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
        ))}
      </div>

      {/* Per-model capability table */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: '8px 16px', alignItems: 'center' }}>
        {Object.entries(models).map(([model, cap]) => (
          <React.Fragment key={model}>
            <span style={{ fontSize: '11px', fontFamily: 'monospace', color: 'var(--text-main)' }}>{model}</span>
            <select
              value={cap}
              disabled={busy}
              onChange={(e) => post({ model_overrides: { [model]: e.target.value } })}
              style={{ background: 'var(--bg-input)', border: `1px solid ${CAP_COLOR[cap] || 'var(--border-color)'}`, color: CAP_COLOR[cap] || 'var(--text-main)', borderRadius: '6px', fontSize: '11px', padding: '3px 8px', fontWeight: 600 }}
            >
              <option value="capable">capable</option>
              <option value="fragile">fragile</option>
              <option value="none">none</option>
            </select>
          </React.Fragment>
        ))}
      </div>

      <div style={{ marginTop: '14px', padding: '12px 14px', borderRadius: '10px', background: 'rgba(57, 255, 20, 0.05)', border: '1px dotted var(--accent-success)', color: 'var(--accent-success)', fontSize: '11px' }}>
        Default-safe: <b>capable</b> models auto-run with <code>/no_think</code> for {data.suppress_thinking_roles.join(', ') || 'synthesis'} (no toggle needed); <b>fragile</b> FLM models are never suppressed. Edits persist to <code>&lt;workspace&gt;/.benny/model_profiles.json</code>.
      </div>
    </div>
  );
}
