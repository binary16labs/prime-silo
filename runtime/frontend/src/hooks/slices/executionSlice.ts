import type { Node } from '@xyflow/react';

export interface HITLRequest {
  nodeId: string;
  nodeName: string;
  action_description: string;
  reasoning: string;
  current_state_summary: string;
  options: Array<{
    label: string;
    value: string;
    description?: string;
  }>;
}

export interface ExecutionEvent {
  type: 'node_started' | 'node_completed' | 'node_error' | 'hitl_required' | 'workflow_completed' | 'workflow_failed' | 'node_progress' | 'tool_used' | 'resource_usage';
  nodeId?: string;
  timestamp: string | number;
  data?: any;
}

export interface AERTrace {
  intent: string;
  observation: string;
  inference: string;
  plan: string;
}

export interface ExecutionSlice {
  executionStatus: Record<string, 'idle' | 'running' | 'success' | 'error'>;
  nodeOutputs: Record<string, any>;
  swarmExecutionId: string | null;
  executionPhase: 'idle' | 'running' | 'paused_hitl' | 'completed' | 'failed';
  currentExecutingNodeId: string | null;
  hitlPendingData: HITLRequest | null;
  executionRunId: string | null;
  nodeExecutionTimers: Record<string, number>;
  executionEvents: ExecutionEvent[];
  reasoningTraces: Record<string, AERTrace>;
  activeRuns: Record<string, { status: string, progress: number }>;
  runHistory: any[];
  totalTasks: number;
  completedTasks: number;
  tokenUsage: number;
  npuActive: boolean;
  nodeHasTools: Record<string, boolean>;

  setSwarmExecutionId: (id: string | null) => void;
  setNodeStatus: (nodeId: string, status: 'idle' | 'running' | 'success' | 'error') => void;
  setNodeOutput: (nodeId: string, output: any) => void;
  clearExecution: () => void;
  setExecutionPhase: (phase: ExecutionSlice['executionPhase']) => void;
  setCurrentExecutingNodeId: (nodeId: string | null) => void;
  setHitlPendingData: (data: HITLRequest | null) => void;
  setExecutionRunId: (runId: string | null) => void;
  addExecutionEvent: (event: ExecutionEvent) => void;
  setReasoningTrace: (nodeId: string, trace: AERTrace) => void;
  startNodeTimer: (nodeId: string) => void;
  stopNodeTimer: (nodeId: string) => void;
  resetExecution: () => void;
  setRunHistory: (history: any[]) => void;
  updateActiveRun: (runId: string, data: { status: string, progress: number }) => void;
}

export const createExecutionSlice = (set: any, get: any): ExecutionSlice => ({
  executionStatus: {},
  nodeOutputs: {},
  swarmExecutionId: null,
  executionPhase: 'idle',
  currentExecutingNodeId: null,
  hitlPendingData: null,
  executionRunId: null,
  nodeExecutionTimers: {},
  executionEvents: [],
  reasoningTraces: {},
  activeRuns: {},
  runHistory: [],
  totalTasks: 0,
  completedTasks: 0,
  tokenUsage: 0,
  npuActive: false,
  nodeHasTools: {},

  setSwarmExecutionId: (id) => set({ swarmExecutionId: id }),
  setNodeStatus: (nodeId, status) => set({
    executionStatus: { ...get().executionStatus, [nodeId]: status },
  }),
  setNodeOutput: (nodeId, output) => set({
    nodeOutputs: { ...get().nodeOutputs, [nodeId]: output },
  }),
  clearExecution: () => set({
    executionStatus: {},
    nodeOutputs: {},
  }),
  setExecutionPhase: (phase) => set({ executionPhase: phase }),
  setCurrentExecutingNodeId: (nodeId) => set({ currentExecutingNodeId: nodeId }),
  setHitlPendingData: (data) => set({ 
    hitlPendingData: data,
    executionPhase: data ? 'paused_hitl' : get().executionPhase 
  }),
  setExecutionRunId: (runId) => set({ executionRunId: runId }),
  
  addExecutionEvent: (event) => {
    // Note: Depends on nodes from workflowSlice.
    const state = get();
    const nodes = state.nodes || []; 
    const executionEvents = state.executionEvents;
    const nodeHasTools = state.nodeHasTools;
    const executionStatus = state.executionStatus;
    
    let nodesUpdated = false;
    let nextNodes = nodes;
    let nextStatus = executionStatus;

    if (event.nodeId && (event.type === 'node_started' || event.type === 'node_completed' || event.type === 'node_error')) {
      const status = event.type === 'node_started' ? 'running' 
                   : event.type === 'node_completed' ? 'success' 
                   : 'error';
                   
      nextNodes = nodes.map((n: Node) => n.id === event.nodeId ? { ...n, data: { ...n.data, status } } : n);
      nextStatus = { ...executionStatus, [event.nodeId]: status };
      nodesUpdated = true;

      if (event.type === 'node_completed') {
        set({ completedTasks: state.completedTasks + 1 });
      }
    }

    if (event.type === 'tool_used' && event.nodeId && !nodeHasTools[event.nodeId]) {
      set({ nodeHasTools: { ...nodeHasTools, [event.nodeId]: true } });
    }

    if (event.type === 'resource_usage') {
      const tokens = event.data?.usage?.total_tokens || 0;
      set({ 
        tokenUsage: state.tokenUsage + tokens,
        npuActive: true 
      });
      setTimeout(() => set({ npuActive: false }), 2000);
    }

    if (event.type === 'node_progress' && event.data?.total_steps) {
      set({ totalTasks: event.data.total_steps });
    }

    const updatedEvents = [...executionEvents, event];
    const finalEvents = updatedEvents.length > 1000 ? updatedEvents.slice(-1000) : updatedEvents;

    set({ 
      executionEvents: finalEvents,
      ...(nodesUpdated ? { nodes: nextNodes, executionStatus: nextStatus } : {})
    });
  },

  setReasoningTrace: (nodeId, trace) => set({
    reasoningTraces: { ...get().reasoningTraces, [nodeId]: trace }
  }),

  startNodeTimer: (nodeId) => set({
    nodeExecutionTimers: { ...get().nodeExecutionTimers, [nodeId]: Date.now() }
  }),

  stopNodeTimer: (nodeId) => {
    const timers = { ...get().nodeExecutionTimers };
    delete timers[nodeId];
    set({ nodeExecutionTimers: timers });
  },

  resetExecution: () => set({
    executionPhase: 'idle',
    currentExecutingNodeId: null,
    hitlPendingData: null,
    executionRunId: null,
    nodeExecutionTimers: {},
    executionEvents: [],
    reasoningTraces: {},
    executionStatus: {},
    nodeOutputs: {},
    totalTasks: 0,
    completedTasks: 0,
    tokenUsage: 0,
    npuActive: false,
    nodeHasTools: {},
  }),

  setRunHistory: (history) => set({ runHistory: history }),
  updateActiveRun: (runId, data) => set({
    activeRuns: { ...get().activeRuns, [runId]: data }
  }),
});
