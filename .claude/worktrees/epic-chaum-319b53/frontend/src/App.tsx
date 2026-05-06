import { useState, useEffect } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import WorkflowCanvas from './components/Studio/WorkflowCanvas';
import NodePalette from './components/Studio/NodePalette';
import ConfigPanel from './components/Studio/ConfigPanel';
import ExecutionBar from './components/Studio/ExecutionBar';
import LLMManager from './components/LLMManager/LLMManager';
import WorkflowList from './components/Studio/WorkflowList';
import SourcePanel from './components/Studio/SourcePanel';
import ResultPanel from './components/Studio/ResultPanel';
import NotebookView from './components/Notebook/NotebookView';
import DocumentViewer from './components/Notebook/DocumentViewer';
import SwarmStatePanel from './components/Studio/SwarmStatePanel';
import SwarmConfigPanel from './components/Studio/SwarmConfigPanel';
import KnowledgeGraphCanvas from './components/Notebook/KnowledgeGraphCanvas';
import SynthesisPanel from './components/Notebook/SynthesisPanel';
import V2GraphSelector from './components/Studio/V2GraphSelector';
import GlobalAdminDashboard from './components/Admin/GlobalAdminDashboard';
import ExecutionAuditHub from './components/Studio/ExecutionAuditHub';
import ErrorBoundary from './components/Shared/ErrorBoundary';
import { useWorkflowStore } from './hooks/useWorkflowStore';
import { useWorkspaceStore } from './hooks/useWorkspaceStore';
import AppV2 from './AppV2Beta';



import { Layers, Cpu, BookOpen, PanelLeftClose, PanelLeft, PanelRightClose, PanelRight, Shield } from 'lucide-react';

type View = 'studio' | 'notebook' | 'llm' | 'admin';

import WorkspaceSelector from './components/Shared/WorkspaceSelector';
import SidebarTabs from './components/Studio/SidebarTabs';

function App() {
  const [view, setView] = useState<View>('studio');
  const [sidebarTab, setSidebarTab] = useState<'flows' | 'agents' | 'nodes' | 'sources'>('flows');
  const [showResults, setShowResults] = useState(false);
  const swarmExecutionId = useWorkflowStore((state) => state.swarmExecutionId);
  const [swarmConfig, setSwarmConfig] = useState({
    model: 'Qwen3-8B-Hybrid',
    max_concurrency: 1,
    workspace: 'default'
  });
  const selectedNode = useWorkflowStore((state) => state.selectedNode);
  const [isLeftPaneOpen, setIsLeftPaneOpen] = useState(true);
  const [isRightPaneOpen, setIsRightPaneOpen] = useState(false);
  const [rightPanelWidth, setRightPanelWidth] = useState(380);
  const [isDraggingRight, setIsDraggingRight] = useState(false);
  const [leftPanelWidth, setLeftPanelWidth] = useState(280);
  const [isDraggingLeft, setIsDraggingLeft] = useState(false);
  const [isDocPaneOpen, setIsDocPaneOpen] = useState(true);
  const [graphKey, setGraphKey] = useState(0); // used to force re-fetch in graph canvas
  const { currentWorkspace } = useWorkspaceStore();

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingRight) {
        const newWidth = window.innerWidth - e.clientX;
        if (newWidth >= 250 && newWidth <= window.innerWidth * 0.6) {
          setRightPanelWidth(newWidth);
        }
      } else if (isDraggingLeft) {
        const newWidth = e.clientX - 64; // nav rail is 64px width
        if (newWidth >= 200 && newWidth <= window.innerWidth * 0.5) {
          setLeftPanelWidth(newWidth);
        }
      }
    };

    const handleMouseUp = () => {
      setIsDraggingRight(false);
      setIsDraggingLeft(false);
    };

    if (isDraggingRight || isDraggingLeft) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'ew-resize';
    } else {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDraggingRight, isDraggingLeft]);

  const uiVersion = useWorkflowStore((state) => state.uiVersion);

  if (uiVersion === 'v2') {
    return <AppV2 />;
  }



  return (
    <ReactFlowProvider>

      <div className="app-layout">
        {/* Graph snapshot selector — fixed overlay, only in notebook view */}
        {view === 'notebook' && <V2GraphSelector />}

        {/* 1. Global Navigation Rail */}
        <div className="nav-rail">
          <div style={{
            width: '40px',
            height: '40px',
            background: 'var(--gradient-primary)',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            cursor: 'pointer',
            transition: 'all 0.2s ease'
          }}
          onClick={() => useWorkflowStore.getState().setUIVersion('v2')}
          title="Switch to God-Mode (V2)"
          >B</div>

          
          <button 
            className={`nav-rail-item ${view === 'studio' ? 'active' : ''}`}
            onClick={() => setView('studio')}
            title="Studio"
          >
            <Layers size={20} />
          </button>
          
          <button 
            className={`nav-rail-item ${view === 'notebook' ? 'active' : ''}`}
            onClick={() => {
              setView('notebook');
              setIsRightPaneOpen(true);
            }}
            title="Notebook"
          >
            <BookOpen size={20} />
          </button>

          <button 
            className={`nav-rail-item ${view === 'llm' ? 'active' : ''}`}
            onClick={() => setView('llm')}
            title="LLM Manager"
          >
            <Cpu size={20} />
          </button>
          
          <button 
            className={`nav-rail-item ${view === 'admin' ? 'active' : ''}`}
            onClick={() => setView('admin')}
            title="Mesh Governance"
          >
            <Shield size={20} />
          </button>

          <div style={{ flex: 1 }} />
          
          <button 
            className="nav-rail-item"
            onClick={() => setIsLeftPaneOpen(!isLeftPaneOpen)}
            title="Toggle Sidebar"
          >
            {isLeftPaneOpen ? <PanelLeftClose size={20} /> : <PanelLeft size={20} />}
          </button>
        </div>

        {/* 2. Left Contextual Sidebar */}
        <div className={`context-sidebar ${!isLeftPaneOpen ? 'collapsed' : ''}`} style={{ width: `${leftPanelWidth}px` }}>
          {/* Studio Sidebar - Tabbed view */}
          {view === 'studio' && (
            <div className="studio-sidebar" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)' }}>
                  <WorkspaceSelector />
              </div>
              
              <SidebarTabs activeTab={sidebarTab} onTabChange={setSidebarTab} />
              
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {sidebarTab === 'flows' && <WorkflowList mode="flows" />}
                {sidebarTab === 'agents' && <WorkflowList mode="agents" />}
                {sidebarTab === 'nodes' && <NodePalette />}
                {sidebarTab === 'sources' && <SourcePanel />}
              </div>

              {(sidebarTab === 'flows' || sidebarTab === 'agents') && (
                <div style={{ borderTop: '1px solid var(--border-color)', background: 'rgba(0,0,0,0.1)' }}>
                  <SwarmConfigPanel 
                    config={swarmConfig}
                    onChange={setSwarmConfig}
                  />
                  <SwarmStatePanel executionId={swarmExecutionId} />
                </div>
              )}
            </div>
          )}

          {/* Notebook Sidebar - Sources */}
          {view === 'notebook' && (
            <div className="notebook-sidebar" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)' }}>
                  <WorkspaceSelector />
              </div>
              <SourcePanel />
              <SynthesisPanel onGraphUpdated={() => setGraphKey(k => k + 1)} />
            </div>
          )}
        </div>

        {isLeftPaneOpen && (
          <div 
            className="resize-handle left-resize-handle"
            onMouseDown={() => setIsDraggingLeft(true)}
          />
        )}

        {/* 3. Main Content (Canvas) */}
        <div className="main-content">
          {view === 'studio' && (
            <>
              <ExecutionBar onNavigateToLLM={() => setView('llm')} />
              <div className="canvas-container">
                <WorkflowCanvas />
              </div>
            </>
          )}

          {view === 'notebook' && (
             <div className="canvas-container notebook-split" style={{ background: 'var(--surface)', position: 'relative' }}>
               {isDocPaneOpen && (
                 <div className="notebook-doc-pane" style={{ transition: 'all 0.3s ease' }}>
                   <DocumentViewer />
                 </div>
               )}
               <div className="notebook-graph-pane">
                 <button 
                   className="btn-icon"
                   onClick={() => setIsDocPaneOpen(!isDocPaneOpen)}
                   style={{
                     position: 'absolute',
                     top: '16px',
                     left: '16px',
                     zIndex: 100,
                     background: 'var(--surface)',
                     border: '1px solid var(--border-color)',
                     borderRadius: '8px',
                     boxShadow: '0 2px 4px rgba(0,0,0,0.1)',
                     padding: '6px'
                   }}
                   title={isDocPaneOpen ? "Collapse Document Reading Pane" : "Expand Document Reading Pane"}
                 >
                   {isDocPaneOpen ? <PanelLeftClose size={18} /> : <BookOpen size={18} />}
                 </button>
                 <KnowledgeGraphCanvas key={graphKey} workspace={currentWorkspace} />
               </div>
             </div>
          )}
          
          {view === 'llm' && <LLMManager />}
          {view === 'admin' && <GlobalAdminDashboard />}

          {(view === 'studio' || view === 'notebook') && (
            <button 
              className="btn btn-gradient"
              onClick={() => setIsRightPaneOpen(!isRightPaneOpen)}
              style={{ position: 'absolute', top: '16px', right: '16px', zIndex: 100, borderRadius: '50%', width: '40px', height: '40px', padding: 0 }}
              title="Toggle Right Panel"
            >
              {isRightPaneOpen ? <PanelRightClose size={20} /> : <PanelRight size={20} />}
            </button>
          )}
        </div>

        {/* 4. Right Panel (Config / Chat / Results) */}
        {(view === 'studio' || view === 'notebook') && (
          <>
            {isRightPaneOpen && (
              <div 
                className="resize-handle right-resize-handle"
                onMouseDown={() => setIsDraggingRight(true)}
              />
            )}
            <div 
              className={`right-panel ${!isRightPaneOpen ? 'collapsed' : ''}`}
              style={{ 
                width: isRightPaneOpen ? `${rightPanelWidth}px` : '0px',
                minWidth: isRightPaneOpen ? `${rightPanelWidth}px` : '0px',
                transition: isDraggingRight ? 'none' : 'width var(--transition-normal), min-width var(--transition-normal)'
              }}
            >
               <div style={{ padding: '16px', borderBottom: '1px solid var(--border-color)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                 <h2 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                     {view === 'studio' ? 'Configuration' : 'Notebook Chat'}
                 </h2>
                 <button className="btn-icon btn-ghost" onClick={() => setIsRightPaneOpen(false)}>
                     <PanelRightClose size={16} />
                 </button>
             </div>
            
            <div style={{ flex: 1, overflowY: 'auto' }}>
                {view === 'studio' && selectedNode && (
                  <ConfigPanel 
                    isOpen={!!selectedNode} 
                    nodeId={selectedNode} 
                  />
                )}
                
                {view === 'studio' && showResults && (
                  <ResultPanel 
                    isOpen={showResults}
                    onClose={() => setShowResults(false)}
                  />
                )}

                {view === 'notebook' && (
                    <NotebookView />
                )}
            </div>
          </div>
          </>
        )}
        
        {/* 5. Execution Audit Hub (Terminal) */}
        <ErrorBoundary name="AuditHub">
          <ExecutionAuditHub />
        </ErrorBoundary>
      </div>
    </ReactFlowProvider>
  );
}

export default App;
