import { addEdge, applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import type { Node, Edge, Connection, NodeChange, EdgeChange } from '@xyflow/react';

export interface WorkflowSlice {
  nodes: Node[];
  edges: Edge[];
  selectedNode: string | null;
  selectedEdge: string | null;
  currentWorkflow: any | null;

  setNodes: (nodes: Node[]) => void;
  setEdges: (edges: Edge[]) => void;
  onNodesChange: (changes: NodeChange[]) => void;
  onEdgesChange: (changes: EdgeChange[]) => void;
  onConnect: (connection: Connection) => void;
  addNode: (node: Node) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  deleteSelected: () => void;
  setSelectedNode: (nodeId: string | null) => void;
  setSelectedEdge: (edgeId: string | null) => void;
  updateNodeData: (nodeId: string, data: any) => void;
  getConnectedNodes: (nodeId: string) => { inputs: Node[]; outputs: Node[] };
  setCurrentWorkflow: (workflow: any | null) => void;
}

export const createWorkflowSlice = (set: any, get: any): WorkflowSlice => ({
  nodes: [],
  edges: [],
  selectedNode: null,
  selectedEdge: null,
  currentWorkflow: null,

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),

  onNodesChange: (changes) => {
    set({ nodes: applyNodeChanges(changes, get().nodes) });
  },

  onEdgesChange: (changes) => {
    set({ edges: applyEdgeChanges(changes, get().edges) });
  },

  onConnect: (connection) => {
    set({ 
      edges: addEdge({ 
        ...connection, 
        animated: true,
        style: { stroke: 'var(--primary)' } // This might need Tailwind update later
      }, get().edges) 
    });
  },

  addNode: (node) => {
    set({ nodes: [...get().nodes, node] });
  },

  deleteNode: (nodeId) => {
    const { nodes, edges, selectedNode } = get();
    set({
      nodes: nodes.filter((n: Node) => n.id !== nodeId),
      edges: edges.filter((e: Edge) => e.source !== nodeId && e.target !== nodeId),
      selectedNode: selectedNode === nodeId ? null : selectedNode,
    });
  },

  deleteEdge: (edgeId) => {
    const { edges, selectedEdge } = get();
    set({
      edges: edges.filter((e: Edge) => e.id !== edgeId),
      selectedEdge: selectedEdge === edgeId ? null : selectedEdge,
    });
  },

  deleteSelected: () => {
    const { selectedNode, selectedEdge, deleteNode, deleteEdge } = get();
    if (selectedNode) {
      deleteNode(selectedNode);
    } else if (selectedEdge) {
      deleteEdge(selectedEdge);
    }
  },

  setSelectedNode: (nodeId) => {
    set({ selectedNode: nodeId, selectedEdge: null });
  },

  setSelectedEdge: (edgeId) => {
    set({ selectedEdge: edgeId, selectedNode: null });
  },

  updateNodeData: (nodeId, data) => {
    set({
      nodes: get().nodes.map((node: Node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, ...data } } : node
      ),
    });
  },

  getConnectedNodes: (nodeId) => {
    const { nodes, edges } = get();
    const inputEdges = edges.filter((e: Edge) => e.target === nodeId);
    const outputEdges = edges.filter((e: Edge) => e.source === nodeId);
    
    return {
      inputs: nodes.filter((n: Node) => inputEdges.some((e: Edge) => e.source === n.id)),
      outputs: nodes.filter((n: Node) => outputEdges.some((e: Edge) => e.target === n.id)),
    };
  },

  setCurrentWorkflow: (workflow) => set({ currentWorkflow: workflow }),
});
