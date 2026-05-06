// ADR-001 Phase C — `text.markdown` widget.
//
// First migrated widget. Reads its source file from agent_sandbox/notes/
// through the runtime client, renders it, and lets the agent (or a human)
// save updates back through fetchAsAgent. Authority on the manifest is
// `read_write_sandbox`, so the runtime's AgentScopeMiddleware confines any
// write to the sandbox subtree regardless of what the widget tries.
//
// Public API
//   createMarkdownWidget(host, props, options)
//     host    — HTMLElement that the widget mounts into
//     props   — { source: string, workspace?: string, editable?: boolean }
//     options — { runtimeClient?, scope?: "sandbox"|"read_only" }
//
//   Returns { update, save, destroy } so the layout can drive the widget
//   when its tile re-renders or unmounts.
//
// The widget never assumes a build step. Plain ES modules + DOM APIs only.

import { renderMarkdown } from "./render.js";
import {
  runtimeFetch,
  fetchAsAgent,
  readRuntimeJson
} from "../../../runtime_client/runtime-client.js";

const STATE_LOADING = "loading";
const STATE_READY = "ready";
const STATE_ERROR = "error";

const DEFAULT_WORKSPACE = "default";

function buildReadPath(workspace, filename) {
  // Filename is constrained server-side (no path separators allowed). We
  // still encode each segment to keep the URL well-formed.
  return `/agent_sandbox/read/${encodeURIComponent(workspace)}/notes/${encodeURIComponent(filename)}`;
}

function setState(host, state) {
  host.dataset.widgetState = state;
}

function renderError(host, error) {
  setState(host, STATE_ERROR);
  const detail = error?.body?.detail || error?.message || String(error);
  host.innerHTML = `<div class="prime-silo-md__error">Markdown widget error: ${escape(detail)}</div>`;
}

function renderLoading(host, source) {
  setState(host, STATE_LOADING);
  host.innerHTML = `<div class="prime-silo-md__loading">Loading ${escape(source)}…</div>`;
}

function escape(text) {
  return String(text).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[ch]));
}

function ensureClient(options) {
  if (options && options.runtimeClient) {
    return options.runtimeClient;
  }
  return { runtimeFetch, fetchAsAgent, readRuntimeJson };
}

/**
 * Mount the widget into `host`. The host element should be empty; existing
 * children are replaced.
 */
export function createMarkdownWidget(host, initialProps, options = {}) {
  if (!host || typeof host.querySelector !== "function") {
    throw new Error("createMarkdownWidget: host must be an HTMLElement.");
  }
  const client = ensureClient(options);
  const scope = options.scope || "sandbox";

  let props = { ...initialProps };
  let currentContent = "";
  let aborted = false;

  host.classList.add("prime-silo-md");

  async function load() {
    const filename = props.source;
    if (!filename) {
      renderError(host, new Error("text.markdown widget requires props.source"));
      return;
    }
    const workspace = props.workspace || DEFAULT_WORKSPACE;
    renderLoading(host, filename);

    try {
      const response = await client.runtimeFetch(buildReadPath(workspace, filename));
      const payload = await client.readRuntimeJson(response);
      if (aborted) {
        return;
      }
      currentContent = payload?.content || "";
      setState(host, STATE_READY);
      host.innerHTML = `<article class="prime-silo-md__body">${renderMarkdown(currentContent)}</article>`;
    } catch (err) {
      if (aborted) {
        return;
      }
      // 404 is the legitimate "agent has not authored this note yet" case —
      // render an empty body, not an error, so the widget is usable.
      if (err && err.status === 404) {
        currentContent = "";
        setState(host, STATE_READY);
        host.innerHTML = `<article class="prime-silo-md__body prime-silo-md__body--empty"></article>`;
        return;
      }
      renderError(host, err);
    }
  }

  /**
   * Persist `nextContent` to agent_sandbox/notes/<source> via the agent
   * scope. Returns the parsed runtime response.
   *
   * Throws if the runtime rejects the write — including if the layout has
   * been (re)bound to a non-sandbox path, in which case the caller should
   * surface the 403 detail back to the user.
   */
  async function save(nextContent) {
    if (typeof nextContent !== "string") {
      throw new TypeError("save() requires a string content.");
    }
    const filename = props.source;
    if (!filename) {
      throw new Error("Cannot save without props.source.");
    }
    const workspace = props.workspace || DEFAULT_WORKSPACE;

    const response = await client.fetchAsAgent(
      "/agent_sandbox/write",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          workspace,
          subdir: "notes",
          filename,
          content: nextContent,
          agent_id: options.agentId || "text.markdown"
        })
      },
      { scope }
    );
    const payload = await client.readRuntimeJson(response);
    currentContent = nextContent;
    if (host.dataset.widgetState === STATE_READY) {
      const body = host.querySelector(".prime-silo-md__body");
      if (body) {
        body.innerHTML = renderMarkdown(currentContent);
        body.classList.toggle("prime-silo-md__body--empty", currentContent === "");
      }
    }
    return payload;
  }

  function update(nextProps) {
    const merged = { ...props, ...nextProps };
    const sourceChanged =
      merged.source !== props.source || merged.workspace !== props.workspace;
    props = merged;
    if (sourceChanged) {
      load();
    }
  }

  function destroy() {
    aborted = true;
    host.classList.remove("prime-silo-md");
    host.innerHTML = "";
    delete host.dataset.widgetState;
  }

  load();

  return { update, save, destroy, get content() { return currentContent; } };
}
