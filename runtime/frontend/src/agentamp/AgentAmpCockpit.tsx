/**
 * AgentAmp Cockpit — AAMP-001 browser surface
 *
 * Renders the skinnable Winamp-style cockpit view inside the main Benny app.
 * Phases visible here:
 *   Phase 5 → Equalizer panel (PUT /api/agentamp/eq)
 *   Phase 6 → Playlist view (GET /api/agentamp/playlist)
 *   Phase 2 → AgentVis plugin sandbox placeholder
 *   Phase 3 → DSP-A visualizer placeholder
 *
 * Skins / signing live entirely in the backend; the cockpit shows skin
 * metadata from the active skin (stubbed until the skin listing endpoint
 * is added in a future phase).
 */

import { useState } from 'react';
import {
  Music2,
  Sliders,
  Cpu,
  Activity,
  Info,
  ChevronDown,
  ChevronUp,
  List,
} from 'lucide-react';
import EqualizerPanel from './EqualizerPanel';
import PlaylistPanel from './PlaylistPanel';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SkinStatusCard() {
  return (
    <div
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Music2 size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          Active Skin
        </span>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '8px',
        }}
      >
        {[
          { label: 'Skin ID', value: 'benny-default' },
          { label: 'Version', value: '1.0.0' },
          { label: 'Signed', value: '✓ HMAC-SHA256' },
          { label: 'Schema', value: '1.0' },
        ].map(({ label, value }) => (
          <div key={label}>
            <div
              style={{
                fontSize: '10px',
                color: 'var(--text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
                marginBottom: '2px',
              }}
            >
              {label}
            </div>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--text-primary)',
                fontFamily: 'monospace',
              }}
            >
              {value}
            </div>
          </div>
        ))}
      </div>

      <div
        style={{
          fontSize: '11px',
          color: 'var(--text-tertiary)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <Info size={11} />
        Install skins via{' '}
        <code
          style={{
            fontFamily: 'monospace',
            background: 'var(--surface)',
            padding: '1px 4px',
            borderRadius: '3px',
          }}
        >
          benny agentamp install
        </code>
      </div>
    </div>
  );
}

function DSPVisualizerStub() {
  // Phase 3 visualizer — renders a placeholder bar chart using SVG
  const bins = Array.from({ length: 32 }, (_, i) =>
    Math.max(4, Math.round(30 * Math.abs(Math.sin(i * 0.4 + Date.now() * 0))))
  );

  return (
    <div
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Activity size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          DSP-A Spectrum
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--text-tertiary)',
            background: 'var(--surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '4px',
            padding: '1px 6px',
          }}
        >
          Phase 3 · demo
        </span>
      </div>

      <svg
        width="100%"
        height="48"
        viewBox={`0 0 ${bins.length * 8} 48`}
        preserveAspectRatio="none"
        style={{ borderRadius: '6px', background: 'var(--surface)' }}
      >
        {bins.map((h, i) => (
          <rect
            key={i}
            x={i * 8 + 1}
            y={48 - h}
            width={6}
            height={h}
            rx={2}
            fill={`hsl(${180 + i * 4}, 70%, 55%)`}
            opacity={0.8}
          />
        ))}
      </svg>

      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
        Live spectrum updates when a swarm run is active (SSE feed).
      </div>
    </div>
  );
}

function AgentVisStub() {
  return (
    <div
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        padding: '16px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <Cpu size={16} style={{ color: 'var(--accent-primary)' }} />
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          AgentVis Plugin Host
        </span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '10px',
            color: 'var(--text-tertiary)',
            background: 'var(--surface)',
            border: '1px solid var(--border-color)',
            borderRadius: '4px',
            padding: '1px 6px',
          }}
        >
          Phase 2 · sandbox ready
        </span>
      </div>

      <div
        style={{
          height: '80px',
          background: 'var(--surface)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: '1px dashed var(--border-color)',
          color: 'var(--text-tertiary)',
          fontSize: '12px',
          gap: '6px',
        }}
      >
        <Cpu size={14} />
        No plugin mounted — install a .aamp pack with a plugin.manifest.json
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>
        Plugins run in a sandboxed iframe (
        <code
          style={{
            fontFamily: 'monospace',
            background: 'var(--surface)',
            padding: '1px 4px',
            borderRadius: '3px',
          }}
        >
          sandbox="allow-scripts"
        </code>
        , CSP connect-src none). See AAMP-SEC1/SEC2.
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collapsible section wrapper
// ---------------------------------------------------------------------------

function Section({
  title,
  icon,
  children,
  defaultOpen = true,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border-color)',
        borderRadius: '12px',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '12px 16px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          borderBottom: open ? '1px solid var(--border-color)' : 'none',
        }}
      >
        {icon}
        <span
          style={{
            fontSize: '13px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            flex: 1,
            textAlign: 'left',
          }}
        >
          {title}
        </span>
        {open ? (
          <ChevronUp size={14} style={{ color: 'var(--text-tertiary)' }} />
        ) : (
          <ChevronDown size={14} style={{ color: 'var(--text-tertiary)' }} />
        )}
      </button>

      {open && <div style={{ padding: '16px' }}>{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main cockpit
// ---------------------------------------------------------------------------

export default function AgentAmpCockpit() {
  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        background: 'var(--background)',
      }}
    >
      {/* ── Header ── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          paddingBottom: '8px',
          borderBottom: '1px solid var(--border-color)',
        }}
      >
        <div
          style={{
            width: '36px',
            height: '36px',
            background: 'var(--gradient-primary)',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <Music2 size={18} color="#fff" />
        </div>
        <div>
          <h1
            style={{
              fontSize: '16px',
              fontWeight: 700,
              color: 'var(--text-primary)',
              margin: 0,
            }}
          >
            AgentAmp
          </h1>
          <p
            style={{
              fontSize: '12px',
              color: 'var(--text-tertiary)',
              margin: 0,
            }}
          >
            Skinnable agent cockpit · AAMP-001
          </p>
        </div>

        {/* Phase badges */}
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            gap: '6px',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
          }}
        >
          {['Ph1 Skins', 'Ph2 Plugins', 'Ph3 DSP', 'Ph4 TUI', 'Ph5 EQ', 'Ph6 Playlist'].map(
            (ph, i) => (
              <span
                key={ph}
                style={{
                  fontSize: '10px',
                  padding: '2px 8px',
                  borderRadius: '4px',
                  background:
                    i >= 4
                      ? 'rgba(99,102,241,0.2)'
                      : 'var(--surface-raised)',
                  border: `1px solid ${i >= 4 ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                  color: i >= 4 ? 'var(--accent-primary)' : 'var(--text-tertiary)',
                  fontWeight: i >= 4 ? 600 : 400,
                }}
              >
                {ph}
              </span>
            )
          )}
        </div>
      </div>

      {/* ── Two-column layout ── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '280px 1fr',
          gap: '16px',
          alignItems: 'start',
        }}
      >
        {/* Left column: skin status + visualizers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <SkinStatusCard />
          <DSPVisualizerStub />
          <AgentVisStub />
        </div>

        {/* Right column: playlist + equalizer panel */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          <Section
            title="Playlist — Run History"
            icon={<List size={15} style={{ color: 'var(--accent-primary)' }} />}
            defaultOpen
          >
            <PlaylistPanel />
          </Section>

          <Section
            title="Equalizer — Manifest Write"
            icon={<Sliders size={15} style={{ color: 'var(--accent-primary)' }} />}
            defaultOpen={false}
          >
            <EqualizerPanel />
          </Section>
        </div>
      </div>
    </div>
  );
}
