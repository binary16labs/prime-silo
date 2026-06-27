const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// Load central configuration contract
const { config, dataDir } = require('../lib/config');

// Active Claude Code sessions directory
const CLAUDE_SESSIONS_DIR = config.CLAUDE_SESSIONS_DIR;

// Override with MEM0RAY_CLAUDE_DIRS for testing against fixtures
const CLAUDE_BASE_DIRS = process.env.MEM0RAY_CLAUDE_DIRS
    ? process.env.MEM0RAY_CLAUDE_DIRS.split(';').map(p => p.trim()).filter(Boolean)
    : config.CLAUDE_LOG_DIRS;
const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, 'entities');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(ENTITIES_DIR)) fs.mkdirSync(ENTITIES_DIR, { recursive: true });

function loadIndex() {
    if (fs.existsSync(INDEX_FILE)) {
        return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
    return { claude_last_sync_timestamp: 0, antigravity_last_sync_timestamp: 0, sessions: [], artifacts: [] };
}

function saveIndex(index) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

function saveEntity(entity, overwrite = false) {
    const file = path.join(ENTITIES_DIR, `${entity.id}.json`);
    if (!overwrite && fs.existsSync(file)) return;
    fs.writeFileSync(file, JSON.stringify(entity, null, 2));
}

function hash(str) {
    return crypto.createHash('md5').update(str).digest('hex');
}

function updateParentChild(parentId, childId) {
    if (parentId === childId) return;
    const parentFile = path.join(ENTITIES_DIR, `${parentId}.json`);
    if (!fs.existsSync(parentFile)) return;
    const parent = JSON.parse(fs.readFileSync(parentFile, 'utf-8'));
    if (!parent.children_ids) parent.children_ids = [];
    if (!parent.children_ids.includes(childId)) {
        parent.children_ids.push(childId);
        saveEntity(parent, true); // Force overwrite for parent update
    }
}

// Extract a meaningful session title from the first user message
function extractSessionTitle(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'ai-title' && entry.aiTitle) {
                    return entry.aiTitle;
                }
                if (entry.type === 'user' && entry.message?.content) {
                    const text = typeof entry.message.content === 'string'
                        ? entry.message.content
                        : JSON.stringify(entry.message.content);
                    // Get first meaningful line, strip markdown
                    const clean = text.replace(/[#*\-_`]/g, '').trim();
                    if (clean.length > 5) {
                        return clean.substring(0, 80) + (clean.length > 80 ? '…' : '');
                    }
                }
            } catch { continue; }
        }
    } catch { /* ignore */ }
    return null;
}

async function parseAuditFile(filePath, sessionUUID) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let lastNodeId = sessionUUID;
    let nodesProcessed = 0;
    let tokens = 0;
    let lineIndex = 0;
    let sessionCwd = null;
    let gitBranch = null;
    let entrypoint = null;
    let version = null;
    let logSessionId = null;

    for await (const line of rl) {
        if (!line.trim()) continue;
        lineIndex++;
        try {
            const entry = JSON.parse(line);

            // Extract session-level metadata from any entry that carries it
            if (entry.cwd && !sessionCwd) sessionCwd = entry.cwd;
            if (entry.gitBranch && !gitBranch) gitBranch = entry.gitBranch;
            if (entry.entrypoint && !entrypoint) entrypoint = entry.entrypoint;
            if (entry.version && !version) version = entry.version;
            if (entry.sessionId && !logSessionId) logSessionId = entry.sessionId;

            // Resolve timestamp — Claude Desktop uses _audit_timestamp,
            // Claude Code uses timestamp (ISO string at entry level).
            const entryTs = new Date(
                entry._audit_timestamp || entry.timestamp || Date.now()
            ).getTime();

            if (entry.message?.usage) {
                tokens += (entry.message.usage.input_tokens || 0) + (entry.message.usage.output_tokens || 0);
            } else if (entry.usage) {
                tokens += (entry.usage.input_tokens || 0) + (entry.usage.output_tokens || 0);
            }

            if (entry.type === 'assistant') {
                const msgContent = entry.message?.content || [];
                for (const block of (Array.isArray(msgContent) ? msgContent : [])) {
                    const blockId = hash(filePath + lineIndex + (block.type || '') + nodesProcessed);
                    let blockType = 'Message';
                    let blockContent = '';
                    let fileName = null;

                    if (block.type === 'thinking') {
                        blockType = 'Thought';
                        blockContent = (block.thinking || '').substring(0, 2000);
                    } else if (block.type === 'text') {
                        blockType = 'Message';
                        blockContent = block.text || '';
                    } else if (block.type === 'tool_use') {
                        blockType = 'Tool Call';
                        let filePath = null;
                        if (block.input) {
                            let rawPath = block.input.path || block.input.TargetFile || block.input.target_file || block.input.absolute_path || block.input.file || block.input.AbsolutePath || block.input.file_path;
                            if (typeof rawPath === 'string') {
                                rawPath = rawPath.trim().replace(/^["']|["']$/g, '');
                                filePath = rawPath;
                                fileName = path.basename(rawPath.replace(/\\/g, '/'));
                            }
                        }

                        const editTools = [
                            'write_to_file', 'replace_file_content', 'str_replace_editor', 'edit_file',
                            'Write', 'Edit', 'write_file', 'edit_file_multi', 'patch_file', 'save_file'
                        ];
                        if (editTools.includes(block.name)) {
                            blockType = 'Artifact';
                        }
                        
                        blockContent = JSON.stringify({ name: block.name, input: block.input }, null, 2);
                    } else {
                        continue;
                    }

                    saveEntity({
                        id: blockId, type: blockType, agent: 'Claude',
                        timestamp: entryTs,
                        content: blockContent,
                        metadata: { model: entry.message?.model || 'claude', toolName: block.name, fileName, filePath },
                        parent_id: lastNodeId, children_ids: []
                    });
                    updateParentChild(lastNodeId, blockId);
                    lastNodeId = blockId;
                    nodesProcessed++;
                }
                continue;
            }

            if (entry.type === 'user') {
                const rawContent = entry.message?.content;
                // Normalize content to array of blocks
                const blocks = Array.isArray(rawContent) ? rawContent : [{ type: 'text', text: rawContent }];

                for (const block of blocks) {
                    const blockId = hash(filePath + lineIndex + (block.type || '') + nodesProcessed);
                    let blockType = 'User Input';
                    let blockContent = '';

                    if (block.type === 'tool_result') {
                        blockType = 'Tool Result';
                        blockContent = typeof block.content === 'string' ? block.content : JSON.stringify(block.content || '').substring(0, 2000);
                    } else if (block.type === 'text' || typeof block === 'string') {
                        blockType = 'User Input';
                        blockContent = typeof block === 'string' ? block : (block.text || '');
                    } else {
                        blockType = 'User Input';
                        blockContent = `[${block.type} payload]`;
                    }

                    if (!blockContent) continue;

                    saveEntity({
                        id: blockId, type: blockType, agent: 'Claude',
                        timestamp: entryTs,
                        content: blockContent.substring(0, 2000),
                        metadata: { model: 'user' },
                        parent_id: lastNodeId, children_ids: []
                    });
                    updateParentChild(lastNodeId, blockId);
                    lastNodeId = blockId;
                    nodesProcessed++;
                }
            }

            // Claude Code queue-operation entries carry the user's actual
            // prompt text in the `content` field when operation === 'enqueue'.
            if (entry.type === 'queue-operation' && entry.operation === 'enqueue' && entry.content) {
                const qId = hash(filePath + lineIndex + 'queue');
                const qContent = entry.content
                    .replace(/<[^>]+>/g, '')   // strip XML tags
                    .replace(/\s+/g, ' ')
                    .trim();
                if (qContent.length > 2) {
                    saveEntity({
                        id: qId, type: 'User Input', agent: 'Claude',
                        timestamp: entryTs,
                        content: qContent.substring(0, 2000),
                        metadata: { model: 'user', source: 'queue-operation' },
                        parent_id: lastNodeId, children_ids: []
                    });
                    updateParentChild(lastNodeId, qId);
                    lastNodeId = qId;
                    nodesProcessed++;
                }
            }

            // Claude Code attachment entries — file attachments the user
            // dragged onto the prompt (@ mentions).
            if (entry.type === 'attachment' && entry.displayPath) {
                const aId = hash(filePath + lineIndex + 'attachment');
                const aFileName = path.basename(entry.displayPath.replace(/\\/g, '/'));
                saveEntity({
                    id: aId, type: 'Artifact', agent: 'Claude',
                    timestamp: entryTs,
                    content: `Attached file: ${entry.displayPath}`,
                    metadata: { fileName: aFileName, filePath: entry.displayPath, source: 'attachment' },
                    parent_id: lastNodeId, children_ids: []
                });
                updateParentChild(lastNodeId, aId);
                nodesProcessed++;
            }

            // Skip system, rate_limit_event, and other noise
        } catch { /* skip malformed lines */ }
    }
    return {
        nodesProcessed, tokens,
        cwd: sessionCwd, gitBranch,
        entrypoint, version, logSessionId
    };
}

function findAuditFiles(dir, filesList = []) {
    if (!fs.existsSync(dir)) return filesList;
    try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    findAuditFiles(fullPath, filesList);
                } else {
                    const isAudit = file === 'audit.jsonl';
                    const isCliLog = file.endsWith('.jsonl') && fullPath.toLowerCase().includes('.claude' + path.sep + 'projects');
                    if (isAudit || isCliLog) {
                        filesList.push(fullPath);
                    }
                }
            } catch { /* permission error, skip */ }
        }
    } catch { /* dir read error, skip */ }
    return filesList;
}

const SYNC_BUFFER_MS = 5 * 60 * 1000; // 5 minutes overlap to prevent write buffering race conditions

async function syncClaude() {
    console.log('[Claude Sync] Starting...');
    const index = loadIndex();
    const newSyncTime = Date.now();
    let totalNodes = 0;

    for (const baseDir of CLAUDE_BASE_DIRS) {
        const auditFiles = findAuditFiles(baseDir);
        for (const file of auditFiles) {
            let stats;
            try { stats = fs.statSync(file); } catch { continue; }
            if (stats.mtimeMs <= (index.claude_last_sync_timestamp || 0) - SYNC_BUFFER_MS) continue;

            // Derive a rough project name from the path — will be refined
            // below with cwd from the parsed entries.
            let projectName = path.basename(path.dirname(path.dirname(file)));
            const isSelfProject = file.toLowerCase().includes('.claude' + path.sep + 'projects');

            console.log(`[Claude Sync] Parsing: ${path.basename(file)}`);

            const sessionUUID = hash(file);
            const title = extractSessionTitle(file) || `Session ${path.basename(file, '.jsonl')}`;

            let taskType = 'Chat';
            if (file.includes('claude-code-sessions') || isSelfProject) taskType = 'Code';
            else if (file.includes('local-agent-mode-sessions')) taskType = 'Co-work';

            // Initialize Session so blocks can attach to it
            saveEntity({
                id: sessionUUID, type: 'Session', agent: 'Claude',
                timestamp: stats.mtimeMs,
                content: title,
                metadata: { filePath: file, project: projectName, tokens: 0, taskType: taskType },
                parent_id: null, children_ids: []
            }, true); // Force overwrite for session initialization

            if (!index.sessions.includes(sessionUUID)) {
                index.sessions.push(sessionUUID);
            }

            // Parse blocks (this updates children_ids of the Session)
            const result = await parseAuditFile(file, sessionUUID);

            // Derive project name from the working directory the session
            // actually ran in — far more reliable than decoding the encoded
            // path directory name.
            if (result.cwd) {
                projectName = path.basename(result.cwd.replace(/\\/g, '/'));
            }

            // Re-save session with all extracted metadata
            const updatedSession = JSON.parse(fs.readFileSync(path.join(ENTITIES_DIR, `${sessionUUID}.json`), 'utf-8'));
            updatedSession.metadata.tokens = result.tokens;
            updatedSession.metadata.project = projectName;
            if (result.cwd) updatedSession.metadata.cwd = result.cwd;
            if (result.gitBranch) updatedSession.metadata.gitBranch = result.gitBranch;
            if (result.entrypoint) updatedSession.metadata.entrypoint = result.entrypoint;
            if (result.version) updatedSession.metadata.version = result.version;
            if (result.logSessionId) updatedSession.metadata.logSessionId = result.logSessionId;

            // Check if this session is currently live
            updatedSession.metadata.isActive = isSessionActive(result.logSessionId);

            saveEntity(updatedSession, true); // Force overwrite for session updates

            totalNodes += result.nodesProcessed;
        }
    }

    index.claude_last_sync_timestamp = newSyncTime;
    saveIndex(index);
    console.log(`[Delta Sync] Complete. Parsed ${totalNodes} new/updated nodes.`);
}

/**
 * Check whether a given sessionId has a live Claude Code process.
 * Reads ~/.claude/sessions/*.json — each file maps a PID to a sessionId.
 */
function isSessionActive(sessionId) {
    if (!sessionId) return false;
    try {
        if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) return false;
        const files = fs.readdirSync(CLAUDE_SESSIONS_DIR);
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), 'utf-8'));
                if (data.sessionId === sessionId) {
                    // The PID is the filename (without .json)
                    const pid = parseInt(f.replace('.json', ''), 10);
                    try { process.kill(pid, 0); return true; } catch { return false; }
                }
            } catch { continue; }
        }
    } catch { /* ignore */ }
    return false;
}

/**
 * Return a summary of all currently active Claude Code sessions.
 */
function getActiveSessions() {
    const sessions = [];
    try {
        if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) return sessions;
        const files = fs.readdirSync(CLAUDE_SESSIONS_DIR);
        for (const f of files) {
            if (!f.endsWith('.json')) continue;
            try {
                const data = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), 'utf-8'));
                const pid = parseInt(f.replace('.json', ''), 10);
                let alive = false;
                try { process.kill(pid, 0); alive = true; } catch { /* not running */ }
                sessions.push({
                    pid,
                    sessionId: data.sessionId,
                    cwd: data.cwd,
                    project: data.cwd ? path.basename(data.cwd.replace(/\\/g, '/')) : 'Unknown',
                    startedAt: data.startedAt,
                    version: data.version,
                    kind: data.kind,
                    entrypoint: data.entrypoint,
                    alive
                });
            } catch { continue; }
        }
    } catch { /* ignore */ }
    return sessions;
}

module.exports = { syncClaude, getActiveSessions };
