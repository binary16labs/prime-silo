import React, { useState } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { NotebookChat } from './NotebookChat';
import { AnalysisView } from './AnalysisView';
import { ArtifactLibrary } from './ArtifactLibrary';
import WorkspaceActivityLog from './WorkspaceActivityLog';
import { MessageSquare, BarChart2, Library, Activity } from 'lucide-react';

export const NotebookView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'chat' | 'analysis' | 'library' | 'activity'>('chat');
  const { synthesisResults } = useWorkspaceStore();

  return (
    <div className="notebook-discovery-pane" style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', background: 'var(--bg-canvas)' }}>
      {/* Tab Switcher - Simple & Integrated */}
      <div className="notebook-tabs" style={{ 
        display: 'flex', 
        padding: '12px', 
        gap: '8px', 
        borderBottom: '1px solid var(--border-color)',
        background: 'rgba(0,0,0,0.1)' 
      }}>
        <button 
          onClick={() => setActiveTab('chat')}
          className={`tab-btn-pill ${activeTab === 'chat' ? 'active' : ''}`}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '10px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: activeTab === 'chat' ? 'var(--branch-purple)' : 'transparent',
            color: activeTab === 'chat' ? 'white' : 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <MessageSquare size={16} />
          Chat
        </button>
        <button 
          onClick={() => setActiveTab('analysis')}
          className={`tab-btn-pill ${activeTab === 'analysis' ? 'active' : ''}`}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '10px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: activeTab === 'analysis' ? 'var(--branch-teal)' : 'transparent',
            color: activeTab === 'analysis' ? 'white' : 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <BarChart2 size={16} />
          Insights
        </button>
        <button 
          onClick={() => setActiveTab('library')}
          className={`tab-btn-pill ${activeTab === 'library' ? 'active' : ''}`}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '8px',
            padding: '10px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: activeTab === 'library' ? 'var(--branch-orange)' : 'transparent',
            color: activeTab === 'library' ? 'white' : 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <Library size={16} />
          Library
        </button>
        <button 
          onClick={() => setActiveTab('activity')}
          className={`tab-btn-pill ${activeTab === 'activity' ? 'active' : ''}`}
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '6px',
            padding: '10px',
            borderRadius: 'var(--radius-pill)',
            border: 'none',
            background: activeTab === 'activity' ? 'var(--primary)' : 'transparent',
            color: activeTab === 'activity' ? 'white' : 'var(--text-secondary)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
        >
          <Activity size={16} />
          Activity
        </button>
      </div>

      {/* Main Column Content */}
      <div className="discovery-tab-content" style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'chat' && <NotebookChat />}
        {activeTab === 'analysis' && <AnalysisView results={synthesisResults} />}
        {activeTab === 'library' && <ArtifactLibrary />}
        {activeTab === 'activity' && <WorkspaceActivityLog />}
      </div>
    </div>
  );
};

export default NotebookView;

