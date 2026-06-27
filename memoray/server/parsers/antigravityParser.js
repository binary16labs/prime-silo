const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// Load central configuration contract
const { config, dataDir } = require('../lib/config');

// Override with MEM0RAY_ANTIGRAVITY_DIR for non-standard installs or fixtures
const ANTIGRAVITY_DIRS = process.env.MEM0RAY_ANTIGRAVITY_DIR 
    ? [process.env.MEM0RAY_ANTIGRAVITY_DIR] 
    : config.ANTIGRAVITY_BRAIN_DIRS;
const DATA_DIR = dataDir;
const ENTITIES_DIR = path.join(DATA_DIR, 'entities');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');

function loadIndex() {
    if (fs.existsSync(INDEX_FILE)) return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
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

// Extract a title from the transcript — the first USER_INPUT
function extractTranscriptTitle(filePath) {
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const entry = JSON.parse(line);
                if (entry.type === 'USER_INPUT' && entry.content) {
                    // Strip XML-like tags and markdown
                    const clean = entry.content
                        .replace(/<[^>]+>/g, '')
                        .replace(/[#*\-_`]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (clean.length > 5) return clean.substring(0, 80) + (clean.length > 80 ? '…' : '');
                }
            } catch { continue; }
        }
    } catch { /* ignore */ }
    return null;
}

async function parseTranscript(filePath, sessionUUID) {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    let lastNodeId = sessionUUID;
    let nodesProcessed = 0;
    let tokens = 0;
    let projectName = null;
    let lineIndex = 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        lineIndex++;
        try {
            const entry = JSON.parse(line);
            const id = hash(filePath + lineIndex);
            
            if (entry.usage) tokens += (entry.usage.input_tokens || 0) + (entry.usage.output_tokens || 0);
            if (entry.tokens) tokens += entry.tokens;
            if (!projectName) {
                if (entry.workspaceUris && entry.workspaceUris.length > 0) {
                    projectName = path.basename(entry.workspaceUris[0].replace('file:///', ''));
                } else if (entry.content) {
                    const cwdMatch = entry.content.match(/CWD:\s*([^\r\n]+)/);
                    if (cwdMatch) {
                        const cwdPath = cwdMatch[1].trim().replace(/^['"]|['"]$/g, '');
                        projectName = path.basename(cwdPath.replace(/\\/g, '/'));
                    }
                }
            }

            const timestamp = new Date(entry.created_at || entry.timestamp || Date.now()).getTime();

            if (entry.type === 'USER_INPUT') {
                const content = (entry.content || '').replace(/<[^>]+>/g, '').trim();
                saveEntity({
                    id, type: 'User Input', agent: 'Antigravity',
                    timestamp,
                    content,
                    metadata: { stepIndex: entry.step_index, status: entry.status },
                    parent_id: lastNodeId, children_ids: []
                });
                updateParentChild(lastNodeId, id);
                lastNodeId = id;
                nodesProcessed++;
            } else if (entry.type === 'PLANNER_RESPONSE') {
                const content = (entry.thinking || entry.content || '').substring(0, 2000);
                saveEntity({
                    id, type: 'Thought', agent: 'Antigravity',
                    timestamp,
                    content,
                    metadata: { stepIndex: entry.step_index, status: entry.status },
                    parent_id: lastNodeId, children_ids: []
                });
                updateParentChild(lastNodeId, id);
                lastNodeId = id;
                nodesProcessed++;

                if (entry.tool_calls && entry.tool_calls.length > 0) {
                    for (let ti = 0; ti < entry.tool_calls.length; ti++) {
                        const tool = entry.tool_calls[ti];
                        const toolId = hash(filePath + lineIndex + 'tool' + ti);
                        
                        let toolFileName = null;
                        let toolFilePath = null;
                        let rawPath = tool.TargetFile || tool.file_path || tool.AbsolutePath || tool.CommandLine || (tool.args && (tool.args.TargetFile || tool.args.AbsolutePath || tool.args.DirectoryPath || tool.args.Url));
                        if (typeof rawPath === 'string') {
                            rawPath = rawPath.trim().replace(/^["']|["']$/g, '');
                            toolFilePath = rawPath;
                            toolFileName = path.basename(rawPath.replace(/\\/g, '/'));
                        }

                        saveEntity({
                            id: toolId, type: 'Tool Call', agent: 'Antigravity',
                            timestamp,
                            content: JSON.stringify(tool, null, 2).substring(0, 1500),
                            metadata: { toolName: tool.toolSummary || tool.name || 'unknown', fileName: toolFileName, filePath: toolFilePath },
                            parent_id: lastNodeId, children_ids: []
                        });
                        updateParentChild(lastNodeId, toolId);
                        lastNodeId = toolId;
                        nodesProcessed++;
                    }
                }
            } else if ([
                'LIST_DIRECTORY', 'VIEW_FILE', 'CODE_ACTION', 'RUN_COMMAND', 
                'GREP_SEARCH', 'SEARCH_WEB', 'INVOKE_SUBAGENT', 'GENERIC', 'ERROR_MESSAGE'
            ].includes(entry.type) || entry.type.endsWith('_MESSAGE') || entry.type === 'TOOL_RESULT') {
                const content = (entry.content || '').substring(0, 2000);
                saveEntity({
                    id, type: 'Tool Result', agent: 'Antigravity',
                    timestamp,
                    content,
                    metadata: { stepIndex: entry.step_index, status: entry.status },
                    parent_id: lastNodeId, children_ids: []
                });
                updateParentChild(lastNodeId, id);
                lastNodeId = id;
                nodesProcessed++;
            }
        } catch (e) { /* skip */ }
    }
    return { nodesProcessed, tokens, projectName };
}

function parseArtifacts(sessionDir, sessionUUID, lastSyncTime) {
    if (!fs.existsSync(sessionDir)) return 0;
    let count = 0;
    const files = fs.readdirSync(sessionDir);

    for (const file of files) {
        if (!file.endsWith('.md')) continue;
        const fullPath = path.join(sessionDir, file);
        let stats;
        try { stats = fs.statSync(fullPath); } catch { continue; }
        if (stats.mtimeMs <= lastSyncTime) continue;

        const content = fs.readFileSync(fullPath, 'utf-8').substring(0, 3000);
        const artifactId = hash(fullPath);

        saveEntity({
            id: artifactId, type: 'Artifact', agent: 'Antigravity',
            timestamp: stats.mtimeMs,
            content,
            metadata: { fileName: file, filePath: fullPath },
            parent_id: sessionUUID, children_ids: []
        }, true);
        updateParentChild(sessionUUID, artifactId);
        count++;
    }
    return count;
}

const SYNC_BUFFER_MS = 5 * 60 * 1000; // 5 minutes overlap to prevent write buffering race conditions

async function syncAntigravity() {
    console.log('[Antigravity Sync] Starting...');
    const index = loadIndex();
    const newSyncTime = Date.now();
    let totalNodes = 0, totalArtifacts = 0;

    for (const baseDir of ANTIGRAVITY_DIRS) {
        if (!fs.existsSync(baseDir)) {
            continue;
        }

        const sessions = fs.readdirSync(baseDir);
        for (const sessionFolder of sessions) {
            const sessionPath = path.join(baseDir, sessionFolder);
            let stat;
            try { stat = fs.statSync(sessionPath); } catch { continue; }
            if (!stat.isDirectory()) continue;

        const sessionUUID = hash(sessionFolder);
        const transcriptPath = path.join(sessionPath, '.system_generated', 'logs', 'transcript.jsonl');

        let isNew = !index.sessions.includes(sessionUUID);
        let tStats;
        let shouldParseTranscript = false;

        if (fs.existsSync(transcriptPath)) {
            try { 
                tStats = fs.statSync(transcriptPath); 
                shouldParseTranscript = tStats.mtimeMs > (index.antigravity_last_sync_timestamp || 0) - SYNC_BUFFER_MS;
            } catch { /* skip */ }
        }

        if (shouldParseTranscript || isNew) {
            const title = fs.existsSync(transcriptPath)
                ? (extractTranscriptTitle(transcriptPath) || `Antigravity ${sessionFolder.substring(0, 8)}`)
                : `Antigravity ${sessionFolder.substring(0, 8)}`;

            let existingSession = { children_ids: [], metadata: {} };
            const existingFile = path.join(ENTITIES_DIR, `${sessionUUID}.json`);
            if (fs.existsSync(existingFile)) {
                try { existingSession = JSON.parse(fs.readFileSync(existingFile, 'utf-8')); } catch { /* ignore */ }
            }

            let sessionTimestamp = stat.mtimeMs;
            if (fs.existsSync(transcriptPath)) {
                try { sessionTimestamp = fs.statSync(transcriptPath).mtimeMs; } catch {}
            }

            saveEntity({
                id: sessionUUID, type: 'Session', agent: 'Antigravity',
                timestamp: Math.max(sessionTimestamp, existingSession.timestamp || 0),
                content: title,
                metadata: { ...existingSession.metadata, sessionPath },
                parent_id: null, children_ids: existingSession.children_ids || []
            }, true); // Force overwrite for session initialization

            if (isNew) {
                index.sessions.push(sessionUUID);
            }

            let result = { nodesProcessed: 0, tokens: 0, projectName: null };
            if (shouldParseTranscript) {
                console.log(`[Antigravity Sync] Parsing transcript: ${sessionFolder.substring(0, 8)}`);
                result = await parseTranscript(transcriptPath, sessionUUID);
                totalNodes += result.nodesProcessed;
            }

            // Update session metadata with parsed tokens and project name
            const sessionFile = path.join(ENTITIES_DIR, `${sessionUUID}.json`);
            if (fs.existsSync(sessionFile)) {
                const sessionEntity = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
                if (result.projectName) sessionEntity.metadata.project = result.projectName;
                if (result.tokens) sessionEntity.metadata.tokens = result.tokens;
                saveEntity(sessionEntity, true); // Force overwrite for session updates
            }
        }

        // Parse artifacts
        totalArtifacts += parseArtifacts(sessionPath, sessionUUID, (index.antigravity_last_sync_timestamp || 0) - SYNC_BUFFER_MS);
        }
    }

    index.antigravity_last_sync_timestamp = newSyncTime;
    saveIndex(index);
    console.log(`[Antigravity Sync] Done. ${totalNodes} nodes, ${totalArtifacts} artifacts.`);
}

module.exports = { syncAntigravity };
