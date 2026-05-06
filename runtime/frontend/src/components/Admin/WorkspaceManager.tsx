import React, { useState, useEffect } from 'react';
import { 
  Database, 
  Folder, 
  Trash2, 
  Search, 
  RefreshCw, 
  FileText, 
  ChevronRight, 
  ChevronDown, 
  AlertCircle,
  CheckCircle,
  Layers,
  HardDrive
} from 'lucide-react';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

interface WorkspaceFile {
  name: string;
  path: string;
  size: number;
  modified: number;
  type: string;
  is_hidden: boolean;
}

interface Workspace {
  id: string;
  path: string;
  has_chromadb: boolean;
  has_data: boolean;
  manifest: any;
}

const WorkspaceManager: React.FC = () => {
  const [workspaces, setWorkspaces] = useState<string[]>([]);
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(null);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);

  const fetchWorkspaces = async () => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `Failed to fetch workspaces (${response.status})`);
      }
      const data = await response.json();
      setWorkspaces(data);
      if (data.length > 0 && !selectedWorkspace) {
        setSelectedWorkspace(data[0]);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchFiles = async (workspaceId: string) => {
    setIsLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/files/recursive-scan?workspace=${workspaceId}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.detail || `Failed to scan workspace files (${response.status})`);
      }
      const data = await response.json();
      setFiles(data.files || []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteWorkspace = async (workspaceId: string) => {
    if (!window.confirm(`CRITICAL ACTION: Are you sure you want to deep-delete workspace "${workspaceId}"? This will permanently remove all files, Neo4j graph nodes, and ChromaDB embeddings associated with this workspace.`)) {
      return;
    }

    setIsDeleting(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/workspaces/${workspaceId}`, {
        method: 'DELETE',
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to delete workspace');
      }
      
      alert(`Workspace "${workspaceId}" and associated metadata purged successfully.`);
      setSelectedWorkspace(null);
      await fetchWorkspaces();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  useEffect(() => {
    fetchWorkspaces();
  }, []);

  useEffect(() => {
    if (selectedWorkspace) {
      fetchFiles(selectedWorkspace);
    }
  }, [selectedWorkspace]);

  const filteredFiles = files.filter(f => 
    f.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
    f.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  };

  return (
    <div className="workspace-manager p-6 h-full overflow-auto bg-surface-darker text-gray-200">
      <header className="mb-8 flex justify-between items-end border-b border-white/10 pb-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2 text-white">
            <Layers className="text-primary" /> Workspace Persistence Manager
          </h1>
          <p className="text-secondary text-sm mt-1">Multi-tenant isolation control and deep-metadata orchestration.</p>
        </div>
        <button 
          onClick={fetchWorkspaces}
          className="btn-icon p-2 hover:bg-white/5 rounded-lg transition-colors"
          title="Refresh Workspaces"
        >
          <RefreshCw size={20} className={isLoading ? 'animate-spin' : ''} />
        </button>
      </header>

      {error && (
        <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400">
          <AlertCircle size={20} />
          <div className="text-sm font-medium">{error}</div>
          <button onClick={() => setError(null)} className="ml-auto text-xs hover:underline">Dismiss</button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 h-[calc(100%-120px)]">
        {/* Workspace Sidebar */}
        <div className="lg:col-span-3 space-y-4 overflow-y-auto pr-2 custom-scrollbar">
          <div className="text-[10px] uppercase tracking-widest text-secondary font-bold mb-2">Available Domains</div>
          {workspaces.map(ws => (
            <div 
              key={ws}
              onClick={() => setSelectedWorkspace(ws)}
              className={`p-4 rounded-xl border transition-all cursor-pointer flex items-center justify-between group ${
                selectedWorkspace === ws 
                  ? 'bg-primary/10 border-primary shadow-[0_0_15px_rgba(var(--primary-rgb),0.15)]' 
                  : 'bg-white/5 border-white/5 hover:border-white/20'
              }`}
            >
              <div className="flex items-center gap-3">
                <Database size={18} className={selectedWorkspace === ws ? 'text-primary' : 'text-gray-500'} />
                <div>
                  <div className={`text-sm font-semibold ${selectedWorkspace === ws ? 'text-white' : 'text-gray-300'}`}>
                    {ws}
                  </div>
                  <div className="text-[10px] text-secondary font-mono">/workspace/{ws}</div>
                </div>
              </div>
              <ChevronRight size={14} className={selectedWorkspace === ws ? 'text-primary' : 'text-gray-600 group-hover:text-gray-400'} />
            </div>
          ))}
          
          <button className="w-full p-4 rounded-xl border border-dashed border-white/10 hover:border-primary/50 hover:bg-primary/5 transition-all text-sm text-secondary flex items-center justify-center gap-2">
            + New Workspace
          </button>
        </div>

        {/* Workspace Detail View */}
        <div className="lg:col-span-9 flex flex-col gap-6">
          {selectedWorkspace ? (
            <>
              {/* Stats Bar */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                <div className="card-glass p-4 rounded-xl border border-white/5 bg-white/5">
                  <div className="text-xs text-secondary mb-1 flex items-center gap-1.5 uppercase tracking-wider font-bold">
                    <FileText size={12} /> Total Files
                  </div>
                  <div className="text-2xl font-bold text-white">{files.length}</div>
                </div>
                <div className="card-glass p-4 rounded-xl border border-white/5 bg-white/5">
                  <div className="text-xs text-secondary mb-1 flex items-center gap-1.5 uppercase tracking-wider font-bold">
                    <HardDrive size={12} /> Total Size
                  </div>
                  <div className="text-2xl font-bold text-white">
                    {formatSize(files.reduce((acc, f) => acc + f.size, 0))}
                  </div>
                </div>
                <div className="card-glass p-4 rounded-xl border border-white/5 bg-white/5">
                  <div className="text-xs text-secondary mb-1 flex items-center gap-1.5 uppercase tracking-wider font-bold">
                    <Database size={12} /> Graph Scope
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold text-white">ACTIVE</span>
                    <CheckCircle size={14} className="text-green-500" />
                  </div>
                </div>
                <div className="card-glass p-4 rounded-xl border border-white/5 bg-white/5 flex flex-col justify-center items-center">
                  <button 
                    onClick={() => handleDeleteWorkspace(selectedWorkspace)}
                    disabled={isDeleting || selectedWorkspace === 'default'}
                    className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-bold transition-all w-full justify-center ${
                      selectedWorkspace === 'default'
                        ? 'bg-gray-800 text-gray-600 cursor-not-allowed border border-gray-700'
                        : 'bg-red-500/10 text-red-500 border border-red-500/30 hover:bg-red-500 hover:text-white'
                    }`}
                  >
                    {isDeleting ? <RefreshCw className="animate-spin" size={14} /> : <Trash2 size={14} />}
                    PURGE WORKSPACE
                  </button>
                  {selectedWorkspace === 'default' && <span className="text-[9px] text-gray-500 mt-1 uppercase font-bold">Protected Domain</span>}
                </div>
              </div>

              {/* File Explorer */}
              <div className="flex-1 card-glass rounded-2xl border border-white/10 bg-white/5 flex flex-col min-h-0 overflow-hidden">
                <div className="p-4 border-b border-white/10 bg-black/20 flex justify-between items-center">
                  <h3 className="text-sm font-semibold flex items-center gap-2 text-white">
                    <Folder size={16} className="text-primary" /> Persistent Objects: {selectedWorkspace}
                  </h3>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" size={14} />
                    <input 
                      type="text" 
                      placeholder="Search objects..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="bg-black/40 border border-white/10 rounded-full py-1.5 pl-9 pr-4 text-xs focus:outline-none focus:border-primary/50 transition-all w-64"
                    />
                  </div>
                </div>
                
                <div className="flex-1 overflow-auto custom-scrollbar">
                  <table className="w-full text-left text-xs text-gray-300">
                    <thead className="sticky top-0 bg-surface-dark/90 backdrop-blur-md border-b border-white/10 z-10">
                      <tr>
                        <th className="p-3 font-bold text-secondary uppercase tracking-widest">Object Name</th>
                        <th className="p-3 font-bold text-secondary uppercase tracking-widest">Subdirectory</th>
                        <th className="p-3 font-bold text-secondary uppercase tracking-widest">Type</th>
                        <th className="p-3 font-bold text-secondary uppercase tracking-widest text-right">Size</th>
                        <th className="p-3 font-bold text-secondary uppercase tracking-widest text-right">Last Modified</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredFiles.length === 0 ? (
                        <tr>
                          <td colSpan={5} className="p-12 text-center text-secondary italic">
                            No persistent objects found matching your search query.
                          </td>
                        </tr>
                      ) : (
                        filteredFiles.map((file, idx) => (
                          <tr key={idx} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                            <td className="p-3">
                              <div className="flex items-center gap-2">
                                <FileIcon type={file.type} />
                                <span className="font-medium text-gray-100">{file.name}</span>
                              </div>
                            </td>
                            <td className="p-3 text-secondary font-mono text-[10px]">
                              {file.path.split('/').slice(0, -1).join('/') || '/'}
                            </td>
                            <td className="p-3 uppercase font-bold text-[10px] text-primary/80">{file.type}</td>
                            <td className="p-3 text-right text-gray-400">{formatSize(file.size)}</td>
                            <td className="p-3 text-right text-secondary">
                              {new Date(file.modified * 1000).toLocaleString()}
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-secondary gap-4 bg-white/2 backdrop-blur-sm rounded-3xl border border-dashed border-white/10">
              <Layers size={64} className="text-white/10" />
              <div className="text-lg font-medium">Select a Domain Context</div>
              <div className="text-sm">Choose a workspace from the sidebar to manage persistent objects and graph metadata.</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const FileIcon: React.FC<{ type: string }> = ({ type }) => {
  switch (type.toLowerCase()) {
    case 'pdf': return <FileText className="text-red-400" size={14} />;
    case 'json': return <Database className="text-yellow-400" size={14} />;
    case 'yaml':
    case 'yml': return <Layers className="text-primary" size={14} />;
    case 'py': return <Terminal className="text-blue-400" size={14} />;
    default: return <FileText className="text-gray-400" size={14} />;
  }
};

export default WorkspaceManager;
