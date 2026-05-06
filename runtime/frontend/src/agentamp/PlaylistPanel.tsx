/**
 * AgentAmp Playlist Panel — Phase 6 (AAMP-F11, AAMP-F12)
 *
 * Reads run history from GET /api/agentamp/playlist and renders it as a
 * Winamp-style track list.  Clicking a row calls the optional onLoadManifest
 * callback so the parent can populate the manifest editor.
 *
 * Enqueueing a manifest is done via POST /api/agentamp/enqueue.
 */

import { useState, useEffect, useCallback } from 'react';
import {
  List,
  Play,
  RefreshCw,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  AlertCircle,
  Cpu,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlaylistEntry {
  run_id: string;
  manifest_id: string;
  workspace: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  model: string | null;
  cost_usd: number | null;
}

interface PlaylistPanelProps {
  /** Called when the user clicks "Load" on a playlist entry. */
  onLoadManifest?: (runId: string, manifestId: string) => void;
  workspace?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATUS_ICON: Record<string, React.ReactNode> = {
  completed: <CheckCircle2 size={12} style={{ color: '#10b981' }} />,
  failed: <XCircle size={12} style={{ color: '#ef4444' }} />,
  running: <Loader2 size={12} style={{ color: '#6366f1', animation: 'spin 1s linear infinite' }} />,
  pending: <Clock size={12} style={{ color: '#f59e0b' }} />,
  partial_success: <AlertCircle size={12} style={{ color: '#f59e0b' }} />,
};

function statusIcon(status: string): React.ReactNode {
  return STATUS_ICON[status] ?? <Clock size={12} style={{ color: 'var(--text-tertiary)' }} />;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = (ms / 1000).toFixed(1);
  return `${s}s`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// PlaylistPanel
// ---------------------------------------------------------------------------

export default function PlaylistPanel({ onLoadManifest, workspace }: PlaylistPanelProps) {
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);

  const fetchPlaylist = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const qs = workspace ? `?workspace=${encodeURIComponent(workspace)}&limit=50` : '?limit=50';
      const res = await fetch(`/api/agentamp/playlist${qs}`, {
        headers: { 'X-Benny-API-Key': 'benny-mesh-2026-auth' },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error(body.detail ?? res.statusText);
      }
      const data: PlaylistEntry[] = await res.json();
      setEntries(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [workspace]);

  useEffect(() => {
    fetchPlaylist();
  }, [fetchPlaylist]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <List size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Playlist
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginLeft: 'auto', fontFamily: 'monospace' }}>
          {entries.length} run{entries.length !== 1 ? 's' : ''}
        </span>
        <button
          onClick={fetchPlaylist}
          disabled={loading}
          title="Refresh playlist"
          style={{
            background: 'none',
            border: '1px solid var(--border-color)',
            borderRadius: '5px',
            padding: '3px 6px',
            cursor: loading ? 'not-allowed' : 'pointer',
            color: 'var(--text-tertiary)',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <RefreshCw
            size={12}
            style={loading ? { animation: 'spin 1s linear infinite' } : undefined}
          />
        </button>
      </div>

      {/* Error state */}
      {error && (
        <div style={{
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.3)',
          borderRadius: '6px',
          padding: '8px 10px',
          fontSize: '11px',
          color: '#ef4444',
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
        }}>
          <AlertCircle size={12} /> {error}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && entries.length === 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-tertiary)', fontSize: '12px', padding: '8px 0' }}>
          <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
          Loading runs…
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && entries.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '24px 0',
          color: 'var(--text-tertiary)',
          fontSize: '12px',
        }}>
          No runs yet — execute a manifest to see it here.
        </div>
      )}

      {/* Track list */}
      {entries.length > 0 && (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '2px',
          maxHeight: '340px',
          overflowY: 'auto',
        }}>
          {entries.map((entry, idx) => {
            const isSelected = selected === entry.run_id;
            return (
              <div
                key={entry.run_id}
                onClick={() => setSelected(isSelected ? null : entry.run_id)}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '16px 1fr auto auto',
                  alignItems: 'center',
                  gap: '8px',
                  padding: '6px 8px',
                  borderRadius: '5px',
                  cursor: 'pointer',
                  background: isSelected
                    ? 'rgba(var(--accent-primary-rgb, 99,102,241), 0.15)'
                    : idx % 2 === 0 ? 'var(--surface-raised)' : 'transparent',
                  border: isSelected
                    ? '1px solid var(--accent-primary)'
                    : '1px solid transparent',
                  transition: 'all 0.1s',
                }}
              >
                {/* Status icon */}
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {statusIcon(entry.status)}
                </span>

                {/* Run info */}
                <div style={{ minWidth: 0 }}>
                  <div style={{
                    fontSize: '11px',
                    fontFamily: 'monospace',
                    color: 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {entry.manifest_id}
                  </div>
                  <div style={{
                    fontSize: '10px',
                    color: 'var(--text-tertiary)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginTop: '1px',
                  }}>
                    {entry.model && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: '2px' }}>
                        <Cpu size={9} />
                        {entry.model}
                      </span>
                    )}
                    <span>{formatTimestamp(entry.started_at)}</span>
                  </div>
                </div>

                {/* Duration */}
                <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {formatDuration(entry.duration_ms)}
                </span>

                {/* Load button (visible when selected) */}
                {isSelected && onLoadManifest && (
                  <button
                    onClick={e => {
                      e.stopPropagation();
                      onLoadManifest(entry.run_id, entry.manifest_id);
                    }}
                    title="Load manifest into editor"
                    style={{
                      background: 'var(--accent-primary)',
                      border: 'none',
                      borderRadius: '4px',
                      padding: '3px 6px',
                      cursor: 'pointer',
                      color: '#fff',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '3px',
                      fontSize: '10px',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    <Play size={9} /> Load
                  </button>
                )}

                {/* Placeholder for alignment when not selected */}
                {!isSelected && <span />}
              </div>
            );
          })}
        </div>
      )}

      {/* Selected run detail */}
      {selected && (() => {
        const entry = entries.find(e => e.run_id === selected);
        if (!entry) return null;
        return (
          <div style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-color)',
            borderRadius: '6px',
            padding: '10px 12px',
            fontSize: '11px',
            color: 'var(--text-secondary)',
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>Run ID</span>
              <span style={{ fontFamily: 'monospace', color: 'var(--text-primary)' }}>
                {entry.run_id}
              </span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>Workspace</span>
              <span style={{ color: 'var(--text-primary)' }}>{entry.workspace}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-tertiary)' }}>Status</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                {statusIcon(entry.status)}
                <span style={{ color: 'var(--text-primary)' }}>{entry.status}</span>
              </span>
            </div>
            {entry.completed_at && (
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: 'var(--text-tertiary)' }}>Completed</span>
                <span style={{ color: 'var(--text-primary)' }}>{formatTimestamp(entry.completed_at)}</span>
              </div>
            )}
          </div>
        );
      })()}
    </div>
  );
}
