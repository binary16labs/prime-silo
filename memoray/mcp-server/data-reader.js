import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve the Mem0Ray data dir. The canonical store is ~/.memoray/data (the same
// dir the dashboard server reads); the in-repo copies are only dev fallbacks.
// MEMORAY_DATA_DIR overrides everything. After prime-silo vendored memo-ray
// (MEMORAY-MERGE.md), the sibling layout is `../server/data`, not the upstream
// `../agent-os-dashboard/server/data` — both are probed for resilience.
function resolveDataDir() {
  const candidates = [
    process.env.MEMORAY_DATA_DIR,
    path.join(os.homedir(), '.memoray', 'data'),
    path.join(__dirname, '..', 'server', 'data'),
    path.join(__dirname, '..', 'agent-os-dashboard', 'server', 'data')
  ];
  for (const candidate of candidates) {
    if (candidate && fsSync.existsSync(path.join(candidate, 'index.json'))) {
      return candidate;
    }
  }
  // Nothing found yet (e.g. first run before a sync) — default to the canonical
  // home dir so a later sync lands where we read.
  return path.join(os.homedir(), '.memoray', 'data');
}

const DATA_DIR = resolveDataDir();
const ENTITIES_DIR = path.join(DATA_DIR, 'entities');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

export class DataReader {
    /**
     * Read the main index file containing session IDs.
     */
    static async getIndex() {
        try {
            const data = await fs.readFile(INDEX_PATH, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Failed to read Mem0Ray index:', error);
            return { sessions: [], artifacts: [] };
        }
    }

    /**
     * Read a specific entity by its ID.
     */
    static async getEntity(id) {
        try {
            const entityPath = path.join(ENTITIES_DIR, `${id}.json`);
            const data = await fs.readFile(entityPath, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            return null;
        }
    }

    /**
     * Get a list of recent sessions, optionally filtering by project or agent.
     * @param {number} limit Max number of sessions to return
     * @param {string} [projectPath] Optional path/cwd to filter by
     * @param {string} [agent] Optional agent name to filter by (e.g. 'claude' or 'antigravity')
     */
    static async getRecentSessions(limit = 10, projectPath = null, agent = null) {
        const index = await this.getIndex();
        const sessionIds = index.sessions || [];
        
        let sessions = [];
        for (const id of sessionIds) {
            const session = await this.getEntity(id);
            if (!session) continue;
            
            if (projectPath) {
                const sessionPath = session.metadata?.cwd || session.metadata?.projectPath || session.metadata?.project;
                if (!sessionPath || !sessionPath.toLowerCase().includes(projectPath.toLowerCase())) {
                    continue;
                }
            }

            if (agent) {
                const sessionAgent = session.agent;
                if (!sessionAgent || sessionAgent.toLowerCase() !== agent.toLowerCase()) {
                    continue;
                }
            }
            
            sessions.push(session);
        }

        // Sort descending by timestamp
        sessions.sort((a, b) => b.timestamp - a.timestamp);
        return sessions.slice(0, limit);
    }

    /**
     * Fetch a session and all its children to reconstruct the timeline.
     */
    static async getSessionTimeline(sessionId) {
        const session = await this.getEntity(sessionId);
        if (!session) return null;

        const timeline = [session];
        const queue = [...(session.children_ids || [])];
        
        while (queue.length > 0) {
            const childId = queue.shift();
            const child = await this.getEntity(childId);
            if (child) {
                timeline.push(child);
                if (child.children_ids) {
                    queue.push(...child.children_ids);
                }
            }
        }

        // Sort by timestamp just in case
        timeline.sort((a, b) => a.timestamp - b.timestamp);
        return timeline;
    }

    /**
     * Fetch a sliding window of the session timeline (e.g., last N events).
     */
    static async getSessionTimelineWindow(sessionId, limit = 50, offset = 0) {
        const fullTimeline = await this.getSessionTimeline(sessionId);
        if (!fullTimeline) return null;

        // Apply offset from the end (most recent first for slicing, then reverse back)
        // Or simpler: just slice from the end of the chronological timeline.
        // If we want a window of 50 items ending at `offset` from the end:
        const total = fullTimeline.length;
        
        // Let's treat offset as "skip N items from the end"
        // e.g., offset=0 means the very last `limit` items.
        // offset=10 means skip the last 10, take the `limit` items before that.
        const endIndex = Math.max(0, total - offset);
        const startIndex = Math.max(0, endIndex - limit);

        const windowSlice = fullTimeline.slice(startIndex, endIndex);
        return {
            totalEvents: total,
            windowSize: windowSlice.length,
            startIndex: startIndex,
            endIndex: endIndex,
            events: windowSlice
        };
    }

    /**
     * Get project summary and extract learned skills from its sessions.
     * Scans both summary AND content fields for richer extraction.
     */
    static async getProjectStatsAndSkills(projectPath) {
        const sessions = await this.getRecentSessions(100, projectPath);
        if (!sessions || sessions.length === 0) {
            return {
                projectName: projectPath,
                sessionCount: 0,
                totalSteps: 0,
                extractedSkills: [],
                summary: "No sessions found for this project."
            };
        }

        let totalSteps = 0;
        let learnedSkills = new Set();

        // Keyword → skill mapping for extraction
        const SKILL_PATTERNS = [
            { keywords: ['database', 'query', 'sql', 'schema'], skill: 'Database querying & schema design' },
            { keywords: ['api', 'rest', 'endpoint', 'fetch'], skill: 'REST API integration' },
            { keywords: ['design', 'ui', 'layout', 'css', 'style', 'responsive'], skill: 'UI/UX design patterns' },
            { keywords: ['graph', 'canvas', 'render', 'visuali'], skill: 'Data visualisation & graph rendering' },
            { keywords: ['test', 'benchmark', 'assert', 'spec'], skill: 'Testing & benchmarking' },
            { keywords: ['deploy', 'build', 'ci', 'pipeline'], skill: 'Build & deployment workflows' },
            { keywords: ['debug', 'error', 'fix', 'bug', 'patch'], skill: 'Debugging & error resolution' },
            { keywords: ['refactor', 'restructur', 'reorgani', 'clean'], skill: 'Code refactoring' },
            { keywords: ['config', 'setup', 'install', 'environment'], skill: 'Environment configuration' },
            { keywords: ['file', 'read', 'write', 'parse', 'json'], skill: 'File I/O & data parsing' },
            { keywords: ['mcp', 'server', 'tool', 'protocol'], skill: 'MCP server architecture' },
            { keywords: ['session', 'context', 'memory', 'history'], skill: 'Context & session management' },
        ];

        for (const session of sessions) {
            totalSteps += (session.children_ids ? session.children_ids.length : 0);
            
            // Combine all searchable text from both summary and content
            const searchText = [
                session.summary || '',
                session.content || '',
                session.metadata?.taskType || ''
            ].join(' ').toLowerCase();

            if (searchText.length > 5) {
                for (const pattern of SKILL_PATTERNS) {
                    if (pattern.keywords.some(kw => searchText.includes(kw))) {
                        learnedSkills.add(pattern.skill);
                    }
                }
            }

            // Track which agents orchestrated work
            if (session.agent) {
                learnedSkills.add(`Multi-agent workflow (${session.agent})`);
            }
        }

        return {
            projectName: projectPath || "All Projects",
            sessionCount: sessions.length,
            totalSteps: totalSteps,
            extractedSkills: Array.from(learnedSkills),
            summary: `Analyzed ${sessions.length} sessions across ${totalSteps} steps. Extracted ${learnedSkills.size} learned patterns.`
        };
    }

    /**
     * Build a graph data structure { nodes, links } from a session timeline,
     * suitable for canvas rendering with force-directed or chronological layout.
     */
    static async getGraphData(sessionId) {
        const timeline = await this.getSessionTimeline(sessionId);
        if (!timeline || timeline.length === 0) return { nodes: [], links: [] };

        const nodes = [];
        const links = [];
        const idSet = new Set();

        for (const entity of timeline) {
            if (idSet.has(entity.id)) continue;
            idSet.add(entity.id);

            const contentPreview = (entity.content || '').substring(0, 120);
            const tokenEstimate = Math.ceil(JSON.stringify(entity).length / 4);

            nodes.push({
                id: entity.id,
                type: entity.type || 'Event',
                agent: entity.agent || 'System',
                label: contentPreview || entity.type || 'Node',
                timestamp: entity.timestamp,
                val: Math.max(4, Math.min(20, Math.sqrt(tokenEstimate))),
                tokens: tokenEstimate,
                sizeBytes: JSON.stringify(entity).length,
                metadata: entity.metadata || {}
            });

            // Link from parent to this node
            if (entity.parent_id && idSet.has(entity.parent_id)) {
                links.push({
                    source: entity.parent_id,
                    target: entity.id
                });
            }
        }

        return { nodes, links, sessionId, nodeCount: nodes.length, linkCount: links.length };
    }
}

