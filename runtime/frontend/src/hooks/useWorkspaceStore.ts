import { create } from 'zustand';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../constants';

interface WorkspaceState {
  currentWorkspace: string;
  workspaces: string[];
  fetchWorkspaces: () => Promise<void>;
  createWorkspace: (name: string) => Promise<boolean>;
  setCurrentWorkspace: (workspace: string) => void;
  activeLLMProvider: string;
  setActiveLLMProvider: (provider: string) => void;
  activeLLMModels: Record<string, string>;
  setActiveLLMModel: (provider: string, model: string) => void;
  // LLM Roles
  modelRoles: Record<string, string>;
  setActiveModelRole: (role: string, modelId: string) => void;
  syncManifest: () => Promise<void>;
  
  // Spatial Navigation
  focusPath: string | null;
  setFocusPath: (path: string | null) => void;

  // Additional state properties found in implementation
  activeDocument: string | null;
  setActiveDocument: (doc: string | null) => void;
  selectedDocuments: string[];
  toggleSelectedDocument: (name: string) => void;
  synthesisResults: any | null;
  setSynthesisResults: (results: any) => void;
  synthesisHistory: any[];
  fetchSynthesisHistory: () => Promise<void>;
  deleteRun: (runId: string) => Promise<boolean>;
  graphCatalog: any[];
  activeGraphId: string;
  setActiveGraphId: (id: string) => void;
  fetchGraphCatalog: () => Promise<void>;
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  currentWorkspace: 'default',
  workspaces: ['default'],

  fetchWorkspaces: async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        const data = await response.json();
        const rawList = Array.isArray(data) ? data : (data.workspaces || []);
        
        // Robustness: ensure we only have strings (IDs)
        const workspaceList = rawList.map((ws: any) => typeof ws === 'object' ? ws.id : ws).filter(Boolean);
        
        // Ensure default is always there
        if (!workspaceList.includes('default')) {
          workspaceList.unshift('default');
        }
        
        set({ workspaces: workspaceList });
      }
    } catch (error) {
      console.error('Failed to fetch workspaces:', error);
    }
  },

  createWorkspace: async (name: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces/${name}`, {
        method: 'POST',
        headers: { ...GOVERNANCE_HEADERS }
      });
      
      if (response.ok) {
        await get().fetchWorkspaces();
        set({ currentWorkspace: name });
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to create workspace:', error);
      return false;
    }
  },

  setCurrentWorkspace: (workspace: string) => {
    set({ currentWorkspace: workspace });
  },

  activeLLMProvider: 'lemonade',
  setActiveLLMProvider: (provider: string) => {
    set({ activeLLMProvider: provider });
  },

  activeLLMModels: { 
    lemonade: 'deepseek-r1-8b-FLM',
    lmstudio: 'openai/Gemma-4-E4B-it-GGUF',
    litert: 'litert/gemma-4-E4B-it.litertlm'
  },

  setActiveLLMModel: (provider: string, model: string) => {
    set((state) => ({
      activeLLMModels: {
        ...state.activeLLMModels,
        [provider]: model
      }
    }));
  },

  modelRoles: {
    chat: 'lemonade/qwen3-tk-4b-FLM',
    swarm: 'lemonade/deepseek-r1-8b-FLM',
    stt: 'lemonade/Whisper-Large-v3-Turbo',
    tts: 'lemonade/kokoro-v1',
    graph_synthesis: 'lemonade/deepseek-r1-8b-FLM'
  },

  setActiveModelRole: (role, modelId) => {
    set((state) => ({
      modelRoles: {
        ...state.modelRoles,
        [role]: modelId
      }
    }));
    
    // Debounced sync
    const store = get() as any;
    if (store._syncTimeout) clearTimeout(store._syncTimeout);
    store._syncTimeout = setTimeout(() => {
      get().syncManifest();
    }, 1000);
  },

  syncManifest: async () => {
    const { currentWorkspace, modelRoles } = get();
    try {
      await fetch(`${API_BASE_URL}/api/workspaces/${currentWorkspace}/manifest`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          ...GOVERNANCE_HEADERS 
        },
        body: JSON.stringify({
          model_roles: modelRoles
        })
      });
    } catch (error) {
      console.error('Failed to sync manifest:', error);
    }
  },

  activeDocument: null,
  setActiveDocument: (doc) => {
    set({ activeDocument: doc });
  },

  selectedDocuments: [],
  toggleSelectedDocument: (name: string) => {
    set((state) => ({
      selectedDocuments: state.selectedDocuments.includes(name)
        ? state.selectedDocuments.filter((doc) => doc !== name)
        : [...state.selectedDocuments, name]
    }));
  },

  synthesisResults: null,
  setSynthesisResults: (results: any) => {
    set({ synthesisResults: results });
  },

  synthesisHistory: [],
  fetchSynthesisHistory: async () => {
    const { currentWorkspace } = get();
    try {
      const response = await fetch(`${API_BASE_URL}/api/graph/history?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        const data = await response.json();
        set({ synthesisHistory: data.history || [] });
      }
    } catch (error) {
      console.error('Failed to fetch synthesis history:', error);
    }
  },

  deleteRun: async (runId: string) => {
    const { currentWorkspace } = get();
    try {
      const response = await fetch(`${API_BASE_URL}/api/graph/runs/${runId}?workspace=${currentWorkspace}`, {
        method: 'DELETE',
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        await get().fetchSynthesisHistory();
        return true;
      }
      return false;
    } catch (error) {
      console.error('Failed to delete run:', error);
      return false;
    }
  },

  graphCatalog: [],
  activeGraphId: 'neural_nexus', // Default to global merged view

  setActiveGraphId: (id) => {
    set({ activeGraphId: id });
  },

  fetchGraphCatalog: async () => {
    const { currentWorkspace } = get();
    try {
      const response = await fetch(`${API_BASE_URL}/api/graph/catalog?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (response.ok) {
        const data = await response.json();
        set({ graphCatalog: data.catalog || [] });
      }
    } catch (error) {
      console.error('Failed to fetch graph catalog:', error);
    }
  },

  focusPath: null,
  setFocusPath: (path) => set({ focusPath: path }),
}));
