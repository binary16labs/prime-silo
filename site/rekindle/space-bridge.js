/**
 * space-bridge.js — API client bridging ReKindle UI to Space Agent + Benny
 *
 * ALL Benny requests go through the Space Agent same-origin proxy:
 *   /api/runtime/<path> → Benny :8005/api/<path>
 * The proxy injects the trusted X-Benny-API-Key server-side.
 * The Benny key NEVER reaches the device.
 *
 * Space Agent's own APIs are same-origin at /api/*.
 * Session cookie (credentials:'include') covers both.
 *
 * Usage:
 *   import { bridge } from './space-bridge.js';
 *   const files = await bridge.files.list('/');
 *   const chat  = await bridge.chat.send('Hello Benny');
 */

// ── Configuration ──────────────────────────────────────────────────

const DEFAULTS = {
  spaceUrl: '',          // same-origin by default
};

function loadConfig() {
  try {
    const saved = JSON.parse(localStorage.getItem('rekindle_config') || '{}');
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveConfig(cfg) {
  localStorage.setItem('rekindle_config', JSON.stringify(cfg));
}

// ── HTTP helpers ───────────────────────────────────────────────────

/**
 * Handle 401 — redirect to the existing /login page with a return-to URL.
 * This fires once; subsequent 401s within the same page load are suppressed
 * to avoid redirect loops.
 */
let redirecting401 = false;
function handle401() {
  if (redirecting401) return;
  redirecting401 = true;
  const returnTo = location.pathname + location.search;
  // Map /reader/* paths to the reader root for the next= param
  const next = returnTo.startsWith('/reader') ? returnTo : '/reader/';
  window.location.href = `/login?next=${encodeURIComponent(next)}`;
}

async function spaceRequest(method, path, body, opts = {}) {
  const cfg = loadConfig();
  const url = cfg.spaceUrl + path;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const init = { method, headers, credentials: 'include' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (res.status === 401) { handle401(); throw new SpaceBridgeError(401, 'Authentication required', 'space'); }
  if (!res.ok) throw new SpaceBridgeError(res.status, await res.text(), 'space');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Benny request via same-origin /api/runtime/* proxy.
 * The proxy strips the /api/runtime prefix, injects X-Benny-API-Key,
 * and forwards to http://127.0.0.1:8005/api/*.
 *
 * Path mapping: bennyRequest('GET', '/api/health')
 *   → fetch('/api/runtime/health')
 *   → proxy → http://127.0.0.1:8005/api/health
 */
async function bennyRequest(method, path, body, opts = {}) {
  const cfg = loadConfig();

  // Check for advanced direct-connection override
  if (cfg.bennyDirectUrl) {
    return bennyDirectRequest(method, path, body, opts, cfg);
  }

  // Rewrite: /api/<rest> → /api/runtime/<rest>
  const runtimePath = path.replace(/^\/api\//, '/api/runtime/');
  const url = cfg.spaceUrl + runtimePath;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  // No X-Benny-API-Key — the proxy injects it server-side
  const init = { method, headers, credentials: 'include' };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (res.status === 401) { handle401(); throw new SpaceBridgeError(401, 'Authentication required', 'benny'); }
  if (!res.ok) throw new SpaceBridgeError(res.status, await res.text(), 'benny');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

/**
 * Advanced fallback: direct Benny connection (only when explicitly configured
 * in Settings → Advanced). Not recommended — exposes the API key on-device.
 */
async function bennyDirectRequest(method, path, body, opts, cfg) {
  const url = cfg.bennyDirectUrl + path;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  if (cfg.bennyDirectKey) headers['X-Benny-API-Key'] = cfg.bennyDirectKey;
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) throw new SpaceBridgeError(res.status, await res.text(), 'benny');
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

class SpaceBridgeError extends Error {
  constructor(status, message, backend) {
    super(`[${backend}:${status}] ${message}`);
    this.status = status;
    this.backend = backend;
  }
}

// ── Auth ───────────────────────────────────────────────────────────

const auth = {
  /** Check current session status via Space Agent */
  async check() {
    try {
      return await spaceRequest('GET', '/api/login_check');
    } catch {
      return { authenticated: false };
    }
  },

  /** Get current user info */
  async userInfo() {
    return spaceRequest('GET', '/api/user_self_info');
  },

  /** Log out */
  async logout() {
    window.location.href = loadConfig().spaceUrl + '/logout';
  },
};

// ── Files (Space Agent app-file API) ──────────────────────────────

const files = {
  /**
   * List files at a logical app path.
   * @param {string} path — e.g. '~/' for user root, 'L0/' for firmware
   * @param {object} opts — { pattern, recursive }
   */
  async list(path = '~/', opts = {}) {
    return spaceRequest('POST', '/api/file_list', { path, ...opts });
  },

  /**
   * Read a file.
   * @param {string} path — logical app path
   * @returns {Promise<{content: string, path: string}>}
   */
  async read(path) {
    return spaceRequest('POST', '/api/file_read', { path });
  },

  /**
   * Write/create a file.
   * @param {string} path
   * @param {string} content
   */
  async write(path, content) {
    return spaceRequest('POST', '/api/file_write', { path, content });
  },

  /**
   * Delete a file.
   * @param {string} path
   */
  async remove(path) {
    return spaceRequest('POST', '/api/file_delete', { path });
  },

  /**
   * Get file info (size, modified, etc.)
   * @param {string} path
   */
  async info(path) {
    return spaceRequest('POST', '/api/file_info', { path });
  },
};

// ── Benny Workspace Files ─────────────────────────────────────────

const workspaceFiles = {
  /** List files in a Benny workspace */
  async list(workspace = 'default') {
    return bennyRequest('GET', `/api/files/list?workspace=${encodeURIComponent(workspace)}`);
  },

  /** Upload a file to Benny workspace — via same-origin /api/runtime/ proxy */
  async upload(file, workspace = 'default') {
    const cfg = loadConfig();

    // Use direct connection if configured (advanced override)
    if (cfg.bennyDirectUrl) {
      const form = new FormData();
      form.append('file', file);
      const headers = {};
      if (cfg.bennyDirectKey) headers['X-Benny-API-Key'] = cfg.bennyDirectKey;
      const res = await fetch(
        `${cfg.bennyDirectUrl}/api/files/upload?workspace=${encodeURIComponent(workspace)}`,
        { method: 'POST', body: form, headers }
      );
      if (!res.ok) throw new SpaceBridgeError(res.status, await res.text(), 'benny');
      return res.json();
    }

    // Same-origin proxy path (default)
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(
      `${cfg.spaceUrl}/api/runtime/files/upload?workspace=${encodeURIComponent(workspace)}`,
      { method: 'POST', body: form, credentials: 'include' }
    );
    if (res.status === 401) { handle401(); throw new SpaceBridgeError(401, 'Authentication required', 'benny'); }
    if (!res.ok) throw new SpaceBridgeError(res.status, await res.text(), 'benny');
    return res.json();
  },

  /** Extract text from a PDF via Benny */
  async pdfExtract(filePath, workspace = 'default') {
    return bennyRequest('POST', '/api/files/pdf-extract', {
      path: filePath,
      workspace,
    });
  },
};

// ── Chat (Benny AI) ───────────────────────────────────────────────

const chat = {
  /**
   * Send a chat message to Benny.
   * @param {string} message
   * @param {object} opts — { notebookId, temperature, topK, docContext }
   */
  async send(message, opts = {}) {
    const body = {
      notebook_id: opts.notebookId || 'rekindle-chat',
      message,
      temperature: opts.temperature ?? 0.7,
      top_k: opts.topK ?? 20,
    };
    // Pass document context for "Ask Benny about this document"
    if (opts.docContext) {
      body.context_files = [opts.docContext];
    }
    if (opts.workspace) {
      body.workspace = opts.workspace;
    }
    return bennyRequest('POST', '/api/chat/query', body);
  },

  /** Get chat history for a notebook */
  async history(notebookId = 'rekindle-chat') {
    return bennyRequest('GET', `/api/chat/history/${encodeURIComponent(notebookId)}`);
  },

  /** Clear chat history */
  async clear(notebookId = 'rekindle-chat') {
    return bennyRequest('DELETE', `/api/chat/history/${encodeURIComponent(notebookId)}`);
  },
};

// ── RAG (Benny Knowledge) ─────────────────────────────────────────

const rag = {
  /** Query the knowledge base */
  async query(question, opts = {}) {
    return bennyRequest('POST', '/api/rag/query', {
      query: question,
      workspace: opts.workspace || 'default',
      top_k: opts.topK || 10,
    });
  },
};

// ── Logs (SSE streaming) ──────────────────────────────────────────

const logs = {
  /**
   * Connect to log stream via SSE — same-origin /api/runtime/ proxy.
   * @param {object} opts — { source: 'benny'|'space'|'longview', lines: 100 }
   * @param {function} onLine — callback(lineText, severity)
   * @returns {{ close: function }} — call close() to disconnect
   */
  connect(opts = {}, onLine) {
    const cfg = loadConfig();
    const source = opts.source || 'benny';
    const lines = opts.lines || 100;

    // Same-origin proxy path: /api/runtime/live/logs
    // (Cookies are sent automatically for same-origin EventSource)
    let url;
    if (cfg.bennyDirectUrl) {
      // Advanced override: direct Benny connection
      url = `${cfg.bennyDirectUrl}/api/live/logs?source=${source}&lines=${lines}`;
    } else {
      url = `${cfg.spaceUrl}/api/runtime/live/logs?source=${source}&lines=${lines}`;
    }
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        onLine(data.line || e.data, data.severity || 'info');
      } catch {
        onLine(e.data, 'info');
      }
    };

    es.onerror = () => {
      onLine('[connection lost — reconnecting...]', 'warn');
    };

    return {
      close() { es.close(); },
      get readyState() { return es.readyState; },
    };
  },
};

// ── Connection Health ─────────────────────────────────────────────

const health = {
  /** Check if Space Agent server is reachable */
  async spaceAlive() {
    try {
      await spaceRequest('GET', '/api/health');
      return true;
    } catch {
      return false;
    }
  },

  /** Check if Benny API is reachable (via same-origin /api/runtime/ proxy) */
  async bennyAlive() {
    try {
      await bennyRequest('GET', '/api/health');
      return true;
    } catch {
      return false;
    }
  },

  /** Check both backends */
  async checkAll() {
    const [space, benny] = await Promise.all([
      this.spaceAlive(),
      this.bennyAlive(),
    ]);
    return { space, benny };
  },
};

// ── Local Cache (offline-first) ───────────────────────────────────

const cache = {
  _prefix: 'rk_cache_',

  set(key, value) {
    try {
      localStorage.setItem(this._prefix + key, JSON.stringify({
        ts: Date.now(),
        v: value,
      }));
    } catch { /* quota exceeded — ignore */ }
  },

  get(key, maxAgeMs = Infinity) {
    try {
      const raw = localStorage.getItem(this._prefix + key);
      if (!raw) return null;
      const { ts, v } = JSON.parse(raw);
      if (maxAgeMs !== Infinity && Date.now() - ts > maxAgeMs) return null;
      return v;
    } catch {
      return null;
    }
  },

  remove(key) {
    localStorage.removeItem(this._prefix + key);
  },

  clear() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(this._prefix)) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  },
};

// ── Reading Position Memory ───────────────────────────────────────

const readingPosition = {
  _key: 'rk_reading_positions',

  _load() {
    try {
      return JSON.parse(localStorage.getItem(this._key) || '{}');
    } catch { return {}; }
  },

  save(filePath, pageIndex, totalPages) {
    const positions = this._load();
    positions[filePath] = { page: pageIndex, total: totalPages, ts: Date.now() };
    try {
      localStorage.setItem(this._key, JSON.stringify(positions));
    } catch { /* quota */ }
  },

  get(filePath) {
    const positions = this._load();
    return positions[filePath] || null;
  },

  remove(filePath) {
    const positions = this._load();
    delete positions[filePath];
    try {
      localStorage.setItem(this._key, JSON.stringify(positions));
    } catch { /* quota */ }
  },

  /** Get all saved positions (for file list resume badges) */
  getAll() {
    return this._load();
  },
};

// ── Utility helpers ───────────────────────────────────────────────

function fileExtension(filename) {
  const dot = filename.lastIndexOf('.');
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

function fileIcon(filename, isDir) {
  if (isDir) return '📁';
  const ext = fileExtension(filename);
  const map = {
    md: '📝', txt: '📄', pdf: '📕', epub: '📖',
    json: '📋', yaml: '📋', yml: '📋',
    js: '⚙️', py: '🐍', html: '🌐', css: '🎨',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
    mp3: '🎵', wav: '🎵', mp4: '🎬',
    zip: '📦', gz: '📦', tar: '📦',
  };
  return map[ext] || '📄';
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function formatTime(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/**
 * Trigger a full e-ink screen refresh to clear ghosting.
 * Briefly flashes the screen black, then back to normal.
 */
function refreshScreen() {
  const flash = document.createElement('div');
  flash.className = 'eink-refresh-flash';
  document.body.appendChild(flash);
  // Force paint: black for 120ms, then remove
  requestAnimationFrame(() => {
    setTimeout(() => {
      flash.remove();
    }, 120);
  });
}

// ── Public API ─────────────────────────────────────────────────────

export const bridge = {
  auth,
  files,
  workspaceFiles,
  chat,
  rag,
  logs,
  health,
  cache,
  readingPosition,
  config: { load: loadConfig, save: saveConfig },
  utils: { fileExtension, fileIcon, formatBytes, formatTime, refreshScreen },
  SpaceBridgeError,
};

// Also expose on window for non-module scripts
if (typeof window !== 'undefined') {
  window.bridge = bridge;
}
