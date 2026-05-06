import { useRef } from 'react';
import { Download, Upload } from 'lucide-react';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';

interface WorkflowExportData {
  version: string;
  name: string;
  created_at: string;
  author: string;
  nodes: any[];
  edges: any[];
  config: {
    model?: string;
    max_concurrency?: number;
    workspace?: string;
  };
}

interface WorkflowExportImportProps {
  workflowName: string;
  config: {
    model?: string;
    max_concurrency?: number;
    workspace?: string;
  };
  onConfigChange: (config: any) => void;
}

export default function WorkflowExportImport({ 
  workflowName, 
  config, 
  onConfigChange 
}: WorkflowExportImportProps) {
  const nodes = useWorkflowStore((state) => state.nodes);
  const edges = useWorkflowStore((state) => state.edges);
  const setNodes = useWorkflowStore((state) => state.setNodes);
  const setEdges = useWorkflowStore((state) => state.setEdges);
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const exportData: WorkflowExportData = {
      version: '1.0',
      name: workflowName || 'untitled_workflow',
      created_at: new Date().toISOString(),
      author: 'Benny Studio',
      nodes: nodes.map(n => ({
        id: n.id,
        type: n.type,
        position: n.position,
        data: n.data
      })),
      edges: edges.map(e => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle
      })),
      config: {
        model: config.model || 'ollama/llama3.2',
        max_concurrency: config.max_concurrency || 1,
        workspace: config.workspace || 'default'
      }
    };

    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.href = url;
    a.download = `${exportData.name.replace(/\s+/g, '_')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleImport = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data: WorkflowExportData = JSON.parse(e.target?.result as string);
        
        // Validate structure
        if (!data.nodes || !data.edges) {
          alert('Invalid workflow file: missing nodes or edges');
          return;
        }

        // Import nodes and edges
        setNodes(data.nodes);
        setEdges(data.edges.map(e => ({
          ...e,
          animated: true,
          style: { stroke: 'var(--primary)' }
        })));

        // Import config if present
        if (data.config) {
          onConfigChange(data.config);
        }

        alert(`Imported workflow: ${data.name} (v${data.version})`);
      } catch (error) {
        alert('Failed to parse workflow file. Please ensure it is valid JSON.');
        console.error('Import error:', error);
      }
    };
    reader.readAsText(file);
    
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="workflow-export-import">
      <button 
        className="btn btn-secondary btn-sm"
        onClick={handleExport}
        title="Export workflow as JSON"
      >
        <Download size={14} />
        Export
      </button>
      
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        onChange={handleImport}
        style={{ display: 'none' }}
        id="workflow-import-input"
      />
      
      <button 
        className="btn btn-secondary btn-sm"
        onClick={() => fileInputRef.current?.click()}
        title="Import workflow from JSON"
      >
        <Upload size={14} />
        Import
      </button>
    </div>
  );
}
