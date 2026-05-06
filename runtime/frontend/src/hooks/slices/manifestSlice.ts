import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import type { OutputSpec, RunRecord, SwarmManifest } from '../../types/manifest';

export interface PlanRequest {
  requirement: string;
  name?: string;
  workspace?: string;
  model?: string;
  max_concurrency?: number;
  max_depth?: number;
  inputs?: { files: string[]; context?: Record<string, unknown> };
  outputs?: OutputSpec;
  save?: boolean;
}

export interface ManifestSlice {
  currentManifest: SwarmManifest | null;
  manifests: SwarmManifest[];
  runs: RunRecord[];
  activeRun: RunRecord | null;
  isPlanning: boolean;
  isRunning: boolean;
  planError: string | null;

  isManifestPanelOpen: boolean;
  isRunsPanelOpen: boolean;

  setManifestPanelOpen: (open: boolean) => void;
  setRunsPanelOpen: (open: boolean) => void;
  toggleManifestPanel: () => void;
  toggleRunsPanel: () => void;

  setCurrentManifest: (m: SwarmManifest | null) => void;
  planManifest: (req: PlanRequest) => Promise<SwarmManifest | null>;
  loadManifests: () => Promise<void>;
  loadManifest: (id: string) => Promise<SwarmManifest | null>;
  saveManifest: (m: SwarmManifest) => Promise<SwarmManifest | null>;
  runManifest: (id: string) => Promise<RunRecord | null>;
  runInlineManifest: (m: SwarmManifest) => Promise<RunRecord | null>;
  loadRuns: (manifestId?: string) => Promise<void>;
  loadRun: (runId: string) => Promise<RunRecord | null>;
  setActiveRun: (r: RunRecord | null) => void;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...GOVERNANCE_HEADERS,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const createManifestSlice = (set: any, get: any): ManifestSlice => ({
  currentManifest: null,
  manifests: [],
  runs: [],
  activeRun: null,
  isPlanning: false,
  isRunning: false,
  planError: null,

  isManifestPanelOpen: false,
  isRunsPanelOpen: false,

  setManifestPanelOpen: (open) => set({ isManifestPanelOpen: open }),
  setRunsPanelOpen: (open) => set({ isRunsPanelOpen: open }),
  toggleManifestPanel: () => set({ isManifestPanelOpen: !get().isManifestPanelOpen }),
  toggleRunsPanel: () => set({ isRunsPanelOpen: !get().isRunsPanelOpen }),

  setCurrentManifest: (m) => set({ currentManifest: m }),

  planManifest: async (req) => {
    set({ isPlanning: true, planError: null });
    try {
      const manifest = await api<SwarmManifest>('/api/manifests/plan', {
        method: 'POST',
        body: JSON.stringify({ save: true, ...req }),
      });
      set({
        currentManifest: manifest,
        manifests: [manifest, ...get().manifests.filter((m: SwarmManifest) => m.id !== manifest.id)],
      });
      return manifest;
    } catch (e: any) {
      set({ planError: String(e?.message ?? e) });
      return null;
    } finally {
      set({ isPlanning: false });
    }
  },

  loadManifests: async () => {
    try {
      const ms = await api<SwarmManifest[]>('/api/manifests');
      set({ manifests: ms });
    } catch (e) {
      console.error('loadManifests failed', e);
    }
  },

  loadManifest: async (id) => {
    try {
      const m = await api<SwarmManifest>(`/api/manifests/${encodeURIComponent(id)}`);
      set({ currentManifest: m });
      return m;
    } catch (e) {
      console.error('loadManifest failed', e);
      return null;
    }
  },

  saveManifest: async (m) => {
    try {
      const saved = await api<SwarmManifest>('/api/manifests', {
        method: 'POST',
        body: JSON.stringify(m),
      });
      set({
        currentManifest: saved,
        manifests: [saved, ...get().manifests.filter((x: SwarmManifest) => x.id !== saved.id)],
      });
      return saved;
    } catch (e) {
      console.error('saveManifest failed', e);
      return null;
    }
  },

  runManifest: async (id) => {
    set({ isRunning: true });
    try {
      const resp = await api<{ run_id: string; manifest_id: string; status: string }>(
        `/api/manifests/${encodeURIComponent(id)}/run`,
        { method: 'POST' },
      );
      // Fetch the run record immediately so the UI has a row to show.
      const rec = await api<RunRecord>(`/api/runs/${encodeURIComponent(resp.run_id)}`).catch(() => null);
      if (rec) {
        set({ activeRun: rec, runs: [rec, ...get().runs] });
      }
      return rec;
    } catch (e) {
      console.error('runManifest failed', e);
      return null;
    } finally {
      set({ isRunning: false });
    }
  },

  runInlineManifest: async (m) => {
    set({ isRunning: true });
    try {
      const resp = await api<{ run_id: string; manifest_id: string; status: string }>(
        '/api/manifests/run',
        { method: 'POST', body: JSON.stringify(m) },
      );
      const rec = await api<RunRecord>(`/api/runs/${encodeURIComponent(resp.run_id)}`).catch(() => null);
      if (rec) set({ activeRun: rec, runs: [rec, ...get().runs] });
      return rec;
    } catch (e) {
      console.error('runInlineManifest failed', e);
      return null;
    } finally {
      set({ isRunning: false });
    }
  },

  loadRuns: async (manifestId) => {
    try {
      const path = manifestId
        ? `/api/manifests/${encodeURIComponent(manifestId)}/runs`
        : '/api/manifests/runs';
      const rs = await api<RunRecord[]>(path);
      set({ runs: rs });
    } catch (e) {
      console.error('loadRuns failed', e);
    }
  },

  loadRun: async (runId) => {
    try {
      const r = await api<RunRecord>(`/api/runs/${encodeURIComponent(runId)}`);
      set({ activeRun: r });
      return r;
    } catch (e) {
      console.error('loadRun failed', e);
      return null;
    }
  },

  setActiveRun: (r) => set({ activeRun: r }),
});
