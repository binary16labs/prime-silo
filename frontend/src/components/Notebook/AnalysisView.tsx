import React from 'react';
import { Brain, Zap, Quote, Info, Activity, Layers } from 'lucide-react';

interface Triple {
  subject: string;
  predicate: string;
  object: string;
  citation?: string;
  confidence?: number;
  section_title?: string;
}

interface Analogy {
  concept_a: string;
  concept_b: string;
  description: string;
  pattern: string;
}

interface AnalysisViewProps {
  results: {
    triples?: Triple[];
    analogies?: Analogy[];
    conflicts?: any[];
    triples_extracted?: number;
    concepts_embedded?: number;
    status?: string;
  } | null;
}

export const AnalysisView: React.FC<AnalysisViewProps> = ({ results }) => {
  if (!results) {
    return (
      <div className="analysis-empty">
        <div className="empty-state">
          <Brain size={48} style={{ opacity: 0.2, marginBottom: '16px' }} />
          <h3>Awaiting Synthesis</h3>
          <p>Run the Synthesis Engine to generate structural blueprints.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="analysis-view">
      <div className="analysis-header">
        <h2 className="analysis-title">
          <Activity size={24} style={{ color: 'var(--branch-purple)' }} />
          Synthesis Blueprint
        </h2>
        <div className="analysis-stats">
          <div className="stat-pill-premium purple">
            <span className="stat-label">Knowledge Points</span>
            <span className="stat-value">{results.triples?.length || 0}</span>
          </div>
          <div className="stat-pill-premium teal">
            <span className="stat-label">Isomorphisms</span>
            <span className="stat-value">{results.analogies?.length || 0}</span>
          </div>
          {results.conflicts && results.conflicts.length > 0 && (
            <div className="stat-pill-premium orange">
              <span className="stat-label">Conflicts</span>
              <span className="stat-value">{results.conflicts.length}</span>
            </div>
          )}
        </div>
      </div>

      {/* 1. Structural Isomorphisms Section */}
      <section className="analysis-section-block">
        <h3 className="section-title-premium">
          <Layers size={18} style={{ color: 'var(--branch-teal)' }} /> 
          Structural Isomorphisms
        </h3>
        {(!results.analogies || results.analogies.length === 0) ? (
          <div className="info-card-premium">
            <Info size={16} />
            <p>Scanning for structural analogies... Cross-domain patterns will appear here as the graph evolves.</p>
          </div>
        ) : (
          <div className="analogy-grid-premium">
            {results.analogies.map((a, i) => (
              <div key={i} className="analogy-card-premium">
                <div className="analogy-pattern-badge">{a.pattern}</div>
                <div className="analogy-flow">
                  <div className="domain-token purple">{a.concept_a}</div>
                  <div className="flow-connector">
                    <Zap size={14} />
                  </div>
                  <div className="domain-token teal">{a.concept_b}</div>
                </div>
                <p className="analogy-description">{a.description}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 2. Knowledge Network Section */}
      <section className="analysis-section-block">
        <h3 className="section-title-premium">
          <Brain size={18} style={{ color: 'var(--branch-purple)' }} /> 
          Relational Inventory
        </h3>
        {(!results.triples || results.triples.length === 0) ? (
          <p className="no-data-text">No relational data captured in this cycle.</p>
        ) : (
          <div className="triples-stack-premium">
            {results.triples.map((t, i) => (
              <div key={i} className="triple-row-premium">
                <div className="triple-path">
                  <span className="path-node subject">{t.subject}</span>
                  <span className="path-edge">{t.predicate}</span>
                  <span className="path-node object">{t.object}</span>
                </div>
                {t.section_title && (
                    <div className="triple-meta">Source: {t.section_title}</div>
                )}
                {t.citation && (
                  <div className="triple-citation-premium">
                    <Quote size={12} style={{ color: 'var(--branch-purple)' }} />
                    <p>{t.citation}</p>
                  </div>
                )}
                {t.confidence !== undefined && (
                  <div className="confidence-meter-premium">
                    <div 
                      className="confidence-level" 
                      style={{ width: `${t.confidence * 100}%` }} 
                    />
                    <span className="confidence-text">{Math.round(t.confidence * 100)}% reliability</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <style>{`
        .analysis-view {
          padding: 32px;
          height: 100%;
          overflow-y: auto;
          background: var(--bg-canvas);
        }
        .analysis-header {
          margin-bottom: 40px;
        }
        .analysis-title {
          font-size: 26px;
          font-weight: 800;
          margin-bottom: 20px;
          display: flex;
          align-items: center;
          gap: 16px;
          color: var(--text-primary);
          letter-spacing: -0.5px;
        }
        .analysis-stats {
          display: flex;
          gap: 12px;
        }
        .stat-pill-premium {
          background: rgba(255,255,255,0.03);
          border: 1px solid var(--border-color);
          padding: 10px 20px;
          border-radius: var(--radius-pill);
          display: flex;
          flex-direction: column;
          min-width: 140px;
          transition: all var(--transition-normal);
        }
        .stat-pill-premium.purple { border-color: rgba(165, 110, 255, 0.3); }
        .stat-pill-premium.teal { border-color: rgba(77, 187, 255, 0.3); }
        .stat-pill-premium.orange { border-color: rgba(255, 159, 10, 0.3); }
        
        .stat-label {
          font-size: 10px;
          text-transform: uppercase;
          color: var(--text-muted);
          font-weight: 700;
          letter-spacing: 0.8px;
        }
        .stat-value {
          font-size: 22px;
          font-weight: 800;
          color: var(--text-primary);
        }
        
        .analysis-section-block {
          margin-bottom: 48px;
        }
        .section-title-premium {
          font-size: 16px;
          font-weight: 700;
          margin-bottom: 24px;
          display: flex;
          align-items: center;
          gap: 12px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 1px;
        }
        
        .info-card-premium {
          background: rgba(165, 110, 255, 0.05);
          border: 1px solid rgba(165, 110, 255, 0.1);
          padding: 20px;
          border-radius: var(--radius-lg);
          display: flex;
          gap: 16px;
          color: var(--text-secondary);
          font-size: 14px;
          line-height: 1.6;
        }
        
        .analogy-grid-premium {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
          gap: 20px;
        }
        .analogy-card-premium {
          background: var(--bg-card);
          border: 1px solid var(--border-color);
          border-radius: var(--radius-lg);
          padding: 24px;
          position: relative;
          transition: all var(--transition-normal);
        }
        .analogy-card-premium:hover {
          border-color: var(--branch-purple);
          transform: translateY(-4px);
          box-shadow: var(--shadow-lg), var(--shadow-glow);
        }
        .analogy-pattern-badge {
          position: absolute;
          top: -10px;
          right: 20px;
          background: var(--branch-purple);
          color: white;
          padding: 4px 12px;
          border-radius: var(--radius-pill);
          font-size: 10px;
          font-weight: 800;
          box-shadow: 0 4px 10px rgba(165, 110, 255, 0.4);
        }
        .analogy-flow {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .domain-token {
          padding: 8px 16px;
          border-radius: var(--radius-pill);
          font-size: 13px;
          font-weight: 700;
          border: 1px solid transparent;
        }
        .domain-token.purple { background: rgba(165, 110, 255, 0.1); color: var(--branch-purple); border-color: rgba(165, 110, 255, 0.2); }
        .domain-token.teal { background: rgba(77, 187, 255, 0.1); color: var(--branch-teal); border-color: rgba(77, 187, 255, 0.2); }
        
        .flow-connector {
          color: var(--text-muted);
          display: flex;
          align-items: center;
        }
        .analogy-description {
          font-size: 14px;
          color: var(--text-secondary);
          line-height: 1.5;
        }
        
        .triples-stack-premium {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .triple-row-premium {
          background: rgba(255,255,255,0.02);
          border-radius: var(--radius-md);
          padding: 16px 20px;
          border: 1px solid var(--border-color);
        }
        .triple-path {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 8px;
          flex-wrap: wrap;
        }
        .path-node {
          padding: 4px 12px;
          border-radius: var(--radius-pill);
          font-size: 12px;
          font-weight: 700;
          background: rgba(255,255,255,0.05);
        }
        .path-node.subject { color: var(--branch-purple); }
        .path-node.object { color: var(--branch-teal); }
        .path-edge {
          font-size: 12px;
          color: var(--text-muted);
          font-style: italic;
          font-weight: 500;
        }
        .triple-citation-premium {
          background: rgba(0,0,0,0.3);
          border-radius: var(--radius-sm);
          padding: 12px 16px;
          display: flex;
          gap: 12px;
          margin-top: 12px;
          font-size: 13px;
          color: var(--text-secondary);
          line-height: 1.4;
          border-left: 3px solid var(--branch-purple);
        }
        
        .confidence-meter-premium {
          height: 3px;
          background: rgba(255,255,255,0.05);
          border-radius: 2px;
          position: relative;
          margin-top: 16px;
        }
        .confidence-level {
          position: absolute;
          left: 0;
          top: 0;
          height: 100%;
          border-radius: 2px;
          background: var(--branch-purple);
          box-shadow: 0 0 8px var(--branch-purple);
        }
        .confidence-text {
          position: absolute;
          right: 0;
          top: -16px;
          font-size: 9px;
          color: var(--text-muted);
          text-transform: uppercase;
          font-weight: 600;
        }
        
        .analysis-empty {
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          text-align: center;
        }
        .no-data-text {
          color: var(--text-muted);
          font-size: 14px;
        }
      `}</style>
    </div>
  );
};

export default AnalysisView;
