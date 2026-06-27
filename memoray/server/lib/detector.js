const path = require('path');
const fs = require('fs');
const os = require('os');

const home = os.homedir();
const isWin = os.platform() === 'win32';

// Standard known search locations for each path setting
const PROBE_LISTS = {
    CLAUDE_SESSIONS_DIR: [
        path.join(home, '.claude', 'sessions')
    ],
    CLAUDE_LOG_DIRS: [
        path.join(home, '.claude', 'projects'),
        path.join(home, 'AppData', 'Roaming', 'Claude', 'projects'),
        path.join(home, 'AppData', 'Roaming', 'Claude', 'local-agent-mode-sessions'),
        path.join(home, 'AppData', 'Roaming', 'Claude', 'claude-code-sessions'),
        path.join(home, 'Library', 'Application Support', 'Claude', 'projects'),
        path.join(home, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'),
        path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions')
    ],
    CLAUDE_WORKTREES_PATH: [
        isWin 
            ? path.join(home, 'AppData', 'Roaming', 'Claude', 'git-worktrees.json')
            : path.join(home, 'Library', 'Application Support', 'Claude', 'git-worktrees.json'),
        path.join(home, '.claude', 'git-worktrees.json')
    ],
    CLAUDE_CONFIG_PATH: [
        isWin
            ? path.join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
            : path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        path.join(home, '.claude', 'claude_desktop_config.json')
    ],
    ANTIGRAVITY_BRAIN_DIRS: [
        path.join(home, '.gemini', 'antigravity-ide', 'brain'),
        path.join(home, '.gemini', 'antigravity', 'brain'),
        path.join(home, '.gemini', 'brain')
    ],
    GEMINI_CONFIG_DIR: [
        path.join(home, '.gemini', 'config')
    ],
    OPENCODE_STORAGE_DIRS: [
        path.join(home, '.local', 'share', 'opencode', 'storage'),
        path.join(home, '.config', 'opencode', 'storage')
    ],
    OPENCODE_CONFIG_PATH: [
        path.join(home, '.config', 'opencode', 'opencode.json'),
        path.join(home, '.local', 'share', 'opencode', 'opencode.json')
    ]
};

// Friendly troubleshooting descriptions for when settings cannot be resolved
const GUIDES = {
    CLAUDE_SESSIONS_DIR: "Contains active Claude Code process PIDs. Created when Claude runs. If missing, try running a command like 'claude' in any directory to initialize.",
    CLAUDE_LOG_DIRS: "Directories where Claude Code saves session JSONL conversation histories. Normally created under ~/.claude/projects or local workspace AppData folder.",
    CLAUDE_WORKTREES_PATH: "JSON file created by Claude Code to track active git worktrees. Generated automatically when you create a new workspace in Claude.",
    CLAUDE_CONFIG_PATH: "Claude Desktop configuration file. Required to analyze active tools and MCP servers.",
    ANTIGRAVITY_BRAIN_DIRS: "Folder where Antigravity (Gemini IDE plugin) saves conversation trajectories. Ensure Antigravity pair programming has run at least once in your editor.",
    GEMINI_CONFIG_DIR: "Configuration folder for Gemini developer skills and global permissions.",
    OPENCODE_STORAGE_DIRS: "Folder where opencode saves its session/message/part JSON tree. Created under ~/.local/share/opencode/storage after you run opencode at least once.",
    OPENCODE_CONFIG_PATH: "opencode configuration file (providers, models, MCP servers, permissions). Normally ~/.config/opencode/opencode.json. Required to audit what opencode is allowed to do."
};

function detectSinglePath(key, userValue) {
    const probes = PROBE_LISTS[key] || [];
    const probedPaths = [];
    
    // 1. Saved Config (User override or saved setting)
    if (userValue) {
        const exists = fs.existsSync(userValue);
        return {
            value: userValue,
            exists,
            source: 'saved_config',
            probed: [{ path: userValue, exists }]
        };
    }
    
    // 2. Auto-Detect: scan candidates
    for (const p of probes) {
        const exists = fs.existsSync(p);
        probedPaths.push({ path: p, exists });
        if (exists) {
            return {
                value: p,
                exists: true,
                source: 'auto_detected',
                probed: probedPaths
            };
        }
    }
    
    // 3. Default Guess: fallback to first standard location
    const fallbackPath = probes[0] || '';
    probedPaths.push({ path: fallbackPath, exists: false });
    return {
        value: fallbackPath,
        exists: false,
        source: 'default_guess',
        probed: probedPaths
    };
}

function detectArrayPaths(key, userValueArray) {
    const probes = PROBE_LISTS[key] || [];
    const probedPaths = [];
    
    // 1. Saved Config
    if (Array.isArray(userValueArray) && userValueArray.length > 0) {
        const checked = userValueArray.map(p => {
            const exists = fs.existsSync(p);
            return { path: p, exists };
        });
        const exists = checked.some(c => c.exists);
        return {
            value: userValueArray,
            exists,
            source: 'saved_config',
            probed: checked
        };
    }
    
    // 2. Auto-Detect: find all standard paths that exist
    const detected = [];
    for (const p of probes) {
        const exists = fs.existsSync(p);
        probedPaths.push({ path: p, exists });
        if (exists) {
            detected.push(p);
        }
    }
    
    if (detected.length > 0) {
        return {
            value: detected,
            exists: true,
            source: 'auto_detected',
            probed: probedPaths
        };
    }
    
    // 3. Default Guess
    return {
        value: probes,
        exists: false,
        source: 'default_guess',
        probed: probedPaths
    };
}

function detectPaths(userConfig = {}) {
    const results = {};
    let isComplete = true;
    
    const singleKeys = ['CLAUDE_SESSIONS_DIR', 'CLAUDE_WORKTREES_PATH', 'CLAUDE_CONFIG_PATH', 'GEMINI_CONFIG_DIR', 'OPENCODE_CONFIG_PATH'];
    const arrayKeys = ['CLAUDE_LOG_DIRS', 'ANTIGRAVITY_BRAIN_DIRS', 'OPENCODE_STORAGE_DIRS'];
    
    for (const key of singleKeys) {
        results[key] = detectSinglePath(key, userConfig[key]);
        results[key].guide = GUIDES[key];
        // We consider it "incomplete" if critical files/folders don't exist
        // Note: CLAUDE_WORKTREES_PATH and CLAUDE_CONFIG_PATH might not exist if they aren't using desktop/worktrees,
        // so we only strictly flag CLAUDE_SESSIONS_DIR or GEMINI_CONFIG_DIR as critical blocks if missing.
        // But for UX, we will show errors for all missing folders in the UI.
        if (!results[key].exists && (key === 'CLAUDE_SESSIONS_DIR' || key === 'GEMINI_CONFIG_DIR')) {
            isComplete = false;
        }
    }
    
    for (const key of arrayKeys) {
        results[key] = detectArrayPaths(key, userConfig[key]);
        results[key].guide = GUIDES[key];
        // Log folders or Antigravity directories are critical. If both log dirs and brain dirs are missing, setup is incomplete.
        // opencode is an optional third agent — its absence never blocks setup.
        if (!results[key].exists && key !== 'OPENCODE_STORAGE_DIRS') {
            isComplete = false;
        }
    }
    
    return {
        isComplete,
        results
    };
}

module.exports = {
    detectPaths,
    PROBE_LISTS
};
