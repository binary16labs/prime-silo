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
  activeDocument: { name: string, subdir: 'data_in' | 'data_out' | 'rag_status' } | null;
  setActiveDocument: (doc: { name: string, subdir: 'data_in' | 'data_out' | 'rag_status' } | null) => void;
  selectedDocuments: string[];
  toggleSelectedDocument: (name: string) => void;
  synthesisResults: any;
  setSynthesisResults: (results: any) => void;
  synthesisHistory: any[];
  fetchSynthesisHistory: () => Promise<void>;
  deleteRun: (runId: string) => Promise<boolean>;
  
  fetchGraphCatalog: () => Promise<void>;
  
  // Spatial Navigation
  focusPath: string | null;
  setFocusPath: (path: string | null) => void;
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
