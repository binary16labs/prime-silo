import { useState, useEffect } from 'react';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';
import { FileText, Loader, FileCode } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export default function DocumentViewer() {
  const { currentWorkspace, activeDocument } = useWorkspaceStore();
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeDocument) {
      setContent(null);
      return;
    }

    const fetchDocument = async () => {
      setLoading(true);
      setError(null);
      try {
        if (activeDocument.subdir === 'rag_status') {
          const res = await fetch(`${API_BASE_URL}/api/rag/status?workspace=${currentWorkspace}`, {
            headers: { ...GOVERNANCE_HEADERS }
          });
          if (!res.ok) throw new Error('Failed to fetch ChromaDB status');
          const data = await res.json();
          setContent(JSON.stringify(data, null, 2));
        } else {
          const response = await fetch(`${API_BASE_URL}/api/files/${currentWorkspace}/${activeDocument.subdir}/${activeDocument.name}`, {
            headers: { ...GOVERNANCE_HEADERS }
          });
          if (!response.ok) throw new Error('Failed to fetch document');
          
          const text = await response.text();
          setContent(text);
        }
      } catch (err: any) {
        console.error('Document fetch failed:', err);
        setError('Failed to load document content.');
      } finally {
        setLoading(false);
      }
    };

    fetchDocument();
  }, [activeDocument, currentWorkspace]);

  if (!activeDocument) {
    return (
      <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', color: 'var(--text-muted)' }}>
        <FileText size={64} style={{ opacity: 0.5, marginBottom: '16px' }} />
        <h3>No Document Selected</h3>
        <p>Select a document from the Data Management panel to view its contents.</p>
      </div>
    );
  }

  const isMarkdown = activeDocument.name.endsWith('.md');
  const isJson = activeDocument.name.endsWith('.json');

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--surface)' }}>
      {/* Header bar */}
      <div style={{ 
        padding: '16px 24px', 
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        background: 'var(--surface-elevated)'
      }}>
        {activeDocument.subdir === 'rag_status' ? <FileCode size={20} className="text-purple-500" /> :
         isMarkdown ? <FileText size={20} className="text-blue-500" /> : 
         isJson ? <FileCode size={20} className="text-green-500" /> : 
         <FileText size={20} className="text-gray-400" />}
        <div>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: '600' }}>{activeDocument.name}</h3>
          <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            workspace/{currentWorkspace}/{activeDocument.subdir}
          </div>
        </div>
      </div>

      {/* Content Area */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '32px' }}>
        {loading ? (
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', color: 'var(--text-muted)' }}>
            <Loader className="animate-spin" size={16} /> Loading document...
          </div>
        ) : error ? (
          <div style={{ color: '#ef4444' }}>{error}</div>
        ) : content ? (
          <div style={{ 
            maxWidth: '850px', 
            margin: '0 auto', 
            background: 'var(--surface-elevated)', 
            padding: '32px', 
            borderRadius: '12px',
            border: '1px solid var(--border-color)',
            boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)'
          }}>
            {isMarkdown ? (
              <div className="prose prose-invert max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
              </div>
            ) : isJson ? (
              <pre style={{ 
                fontFamily: 'monospace', 
                fontSize: '13px', 
                whiteSpace: 'pre-wrap', 
                wordBreak: 'break-word',
                color: '#a8c7fa' 
              }}>
                {content}
              </pre>
            ) : (
              <pre style={{ 
                fontFamily: 'monospace', 
                fontSize: '14px', 
                whiteSpace: 'pre-wrap', 
                wordBreak: 'break-word',
                color: 'var(--text-color)' 
              }}>
                {content}
              </pre>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
