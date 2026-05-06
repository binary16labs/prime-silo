import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  BookOpen, 
  Search, 
  X, 
  ChevronRight, 
  Clock, 
  Zap, 
  Target,
  FileText,
  RefreshCw
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useWorkflowStore } from '../../hooks/useWorkflowStore';
import { useWorkspaceStore } from '../../hooks/useWorkspaceStore';
import { API_BASE_URL, GOVERNANCE_HEADERS } from '../../constants';

export function WikiHub() {
  const { isWikiHubOpen, setWikiHubOpen, activeWikiConcept, setActiveWikiConcept } = useWorkflowStore();
  const { currentWorkspace } = useWorkspaceStore();
  const [articles, setArticles] = useState<any[]>([]);
  const [currentArticle, setCurrentArticle] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchArticles = async () => {
    try {
      const resp = await fetch(`${API_BASE_URL}/api/rag/wiki/articles?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (resp.ok) {
        const data = await resp.json();
        setArticles(data.articles || []);
      }
    } catch (e) {
      console.error("Failed to fetch wiki articles", e);
    }
  };

  const fetchArticleContent = async (filename: string) => {
    setLoading(true);
    try {
      const resp = await fetch(`${API_BASE_URL}/api/rag/wiki/article/${filename}?workspace=${currentWorkspace}`, {
        headers: { ...GOVERNANCE_HEADERS }
      });
      if (resp.ok) {
        const data = await resp.json();
        setCurrentArticle(data);
      }
    } catch (e) {
      console.error("Failed to fetch article content", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isWikiHubOpen) {
      fetchArticles();
    }
  }, [isWikiHubOpen, currentWorkspace]);

  useEffect(() => {
    if (activeWikiConcept) {
      const filename = activeWikiConcept.replace(/ /g, '_') + '.md';
      fetchArticleContent(filename);
    }
  }, [activeWikiConcept]);

  if (!isWikiHubOpen) return null;

  const filteredArticles = articles.filter(a => 
    a.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <motion.div 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[100] flex items-center justify-center p-12 bg-[#020408]/90 backdrop-blur-2xl"
    >
      <div className="w-full h-full max-w-6xl bg-[#0c0c14] border border-white/10 rounded-3xl shadow-[0_30px_100px_rgba(0,0,0,0.8)] flex overflow-hidden relative">
        
        {/* Decorative Grid */}
        <div className="absolute inset-0 opacity-5 pointer-events-none bg-[linear-gradient(to_right,#80808012_1px,transparent_1px),linear-gradient(to_bottom,#80808012_1px,transparent_1px)] bg-[size:24px_24px]" />

        {/* Sidebar */}
        <div className="w-[320px] border-r border-white/5 flex flex-col z-10">
          <div className="p-8 space-y-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-[#FF00FF]/10 text-[#FF00FF]">
                  <BookOpen size={20} />
                </div>
                <div className="flex flex-col leading-none">
                  <span className="text-[10px] font-black text-[#FF00FF]/60 uppercase tracking-[.2em]">The_Librarian</span>
                  <span className="text-sm font-black text-white tracking-widest">RATIONALE_HUB</span>
                </div>
              </div>
              <button onClick={() => setWikiHubOpen(false)} className="p-2 text-white/20 hover:text-white transition-all">
                <X size={20} />
              </button>
            </div>

            <div className="relative group">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-white/20 transition-colors group-focus-within:text-[#FF00FF]" size={14} />
              <input 
                type="text"
                placeholder="SEARCH_CONCEPTS..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-xl py-3 pl-10 pr-4 text-[10px] font-mono text-white outline-none focus:border-[#FF00FF]/40 focus:bg-[#FF00FF]/5 transition-all"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-1 custom-scrollbar">
            {filteredArticles.map((article: any) => (
              <button
                key={article.filename}
                onClick={() => setActiveWikiConcept(article.name)}
                className={`w-full group flex items-center gap-3 p-4 rounded-2xl border transition-all ${activeWikiConcept === article.name ? 'bg-[#FF00FF]/10 border-[#FF00FF]/30 shadow-[0_0_20px_rgba(255,0,255,0.05)]' : 'border-transparent hover:bg-white/5 hover:border-white/10'}`}
              >
                <div className={`p-2 rounded-lg ${activeWikiConcept === article.name ? 'bg-[#FF00FF]/20 text-[#FF00FF]' : 'bg-white/5 text-white/30'} transition-all`}>
                  <Zap size={14} />
                </div>
                <div className="flex-1 text-left min-w-0">
                  <div className={`text-[11px] font-bold tracking-wider truncate transition-colors ${activeWikiConcept === article.name ? 'text-white' : 'text-white/60'}`}>
                    {article.name}
                  </div>
                  <div className="flex items-center gap-2 mt-0.5 text-[8px] text-white/20 font-mono">
                    <Clock size={10} />
                    <span>{new Date(article.modified).toLocaleDateString()}</span>
                  </div>
                </div>
                {activeWikiConcept === article.name && (
                  <ChevronRight size={14} className="text-[#FF00FF]" />
                )}
              </button>
            ))}
            
            {articles.length === 0 && (
              <div className="py-20 text-center opacity-20">
                <FileText size={32} className="mx-auto mb-3" />
                <div className="text-[10px] font-bold tracking-[.3em] uppercase">No_Artifacts_Sync</div>
              </div>
            )}
          </div>
        </div>

        {/* Main Content Area */}
        <div className="flex-1 flex flex-col bg-[#050508]/40 overflow-hidden relative">
          {loading ? (
             <div className="absolute inset-0 flex items-center justify-center">
                <RefreshCw size={24} className="text-[#FF00FF] animate-spin" />
             </div>
          ) : currentArticle ? (
            <div className="flex-1 overflow-y-auto p-12 custom-scrollbar">
              <motion.div 
                key={currentArticle.filename}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="max-w-3xl mx-auto prose prose-invert"
              >
                <div className="prose-headings:font-black prose-headings:tracking-tighter prose-headings:uppercase prose-h1:text-4xl prose-h1:text-[#FF00FF] prose-h2:text-xl prose-h2:text-white/80 prose-p:text-white/60 prose-p:leading-relaxed prose-strong:text-[#FF00FF] prose-code:text-[#00FFFF] prose-code:bg-[#00FFFF]/5 prose-code:px-1 prose-code:rounded">
                  <ReactMarkdown>{currentArticle.content}</ReactMarkdown>
                </div>
              </motion.div>
            </div>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center opacity-20 select-none">
               <Zap size={64} className="mb-6 animate-pulse" />
               <div className="text-xl font-black tracking-[0.4em] uppercase">Select_A_Nexus_Signal</div>
               <div className="text-[10px] font-mono mt-2 tracking-widest text-[#FF00FF]">Awaiting Concept Synchronization...</div>
            </div>
          )}

          {/* Bottom Bar Hints */}
          {currentArticle && (
            <div className="p-6 border-t border-white/5 flex items-center justify-between z-10">
               <div className="flex items-center gap-4">
                  <div className="text-[10px] font-black text-[#FF00FF]/40 uppercase tracking-[.2em]">Compounding_Record_P0</div>
                  <div className="h-4 w-[1px] bg-white/10" />
                  <div className="flex items-center gap-2 text-[9px] text-white/40 font-mono">
                     <Target size={10} /> WORKSPACE_GROUNDED
                  </div>
               </div>
               
               <div className="flex items-center gap-2">
                  <div className="px-3 py-1 rounded bg-white/5 border border-white/10 text-[8px] text-white/60 font-mono">
                     MD_V1
                  </div>
                  <div className="px-3 py-1 rounded bg-[#FF00FF]/5 border border-[#FF00FF]/20 text-[8px] text-[#FF00FF] font-mono">
                     SYNTHESIS_ENGINE
                  </div>
               </div>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}
