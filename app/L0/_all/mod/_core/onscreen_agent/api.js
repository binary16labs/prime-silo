import * as config from "/mod/_core/onscreen_agent/config.js";
import * as llmParams from "/mod/_core/onscreen_agent/llm-params.js";
import { prepareOnscreenAgentCompletionRequest } from "/mod/_core/onscreen_agent/llm.js";
import { getHuggingFaceManager } from "/mod/_core/huggingface/manager.js";

function extractTextContent(value) {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function extractStreamingDelta(payload) {
  console.debug("[onscreen_agent] extractStreamingDelta payload:", payload);
  const choice = payload.choices?.[0];

  if (choice) {
    const delta = choice.delta || choice.message || {};
    const content = extractTextContent(delta.content || choice.text || "");
    if (content) {
      console.debug("[onscreen_agent] extracted from choices:", content);
      return content;
    }
    // Qwen3 thinking mode: delta.content is empty but reasoning_content has text.
    // With enable_thinking:false this shouldn't happen, but handle it as a fallback
    // so we return something rather than triggering the protocol-correction loop.
    const thinking = extractTextContent(delta.reasoning_content || "");
    if (thinking) {
      console.debug("[onscreen_agent] extracted reasoning_content (thinking fallback):", thinking.slice(0, 80));
      return thinking;
    }
    return "";
  }

  // Support Benny / OpenAI-adjacent top-level fields
  const topLevelContent = payload?.answer || payload?.message || payload?.content || "";
  
  if (typeof topLevelContent === "string" && topLevelContent.trim()) {
    console.debug("[onscreen_agent] extracted from top-level string:", topLevelContent);
    return topLevelContent;
  }

  if (topLevelContent && typeof topLevelContent === "object") {
    const content = extractTextContent(topLevelContent.content || "");
    if (content.trim()) {
      console.debug("[onscreen_agent] extracted from top-level object:", content);
      return content;
    }
  }

  // Support FastAPI / Workflow fields
  if (payload?.detail) {
    return `[Backend Error: ${payload.detail}]`;
  }

  if (payload?.execution_id) {
    return `[Workflow execution started: ${payload.execution_id} (Status: ${payload.status})]`;
  }

  console.warn("[onscreen_agent] could not extract content from payload:", payload);
  return "";
}

function extractNonStreamingMessage(payload) {
  console.log("[onscreen_agent] extractNonStreamingMessage payload:", payload);
  const choice = payload.choices?.[0];

  if (choice) {
    const message = choice.message || {};
    const content = extractTextContent(message.content || choice.text || "");
    console.log("[onscreen_agent] extracted from choices:", content);
    return content;
  }

  // Support Benny / OpenAI-adjacent top-level fields
  const topLevelContent = payload?.answer || payload?.message || payload?.content || "";

  if (typeof topLevelContent === "string" && topLevelContent.trim()) {
    console.log("[onscreen_agent] extracted from top-level string:", topLevelContent);
    return topLevelContent;
  }

  if (topLevelContent && typeof topLevelContent === "object") {
    const content = extractTextContent(topLevelContent.content || "");
    if (content.trim()) {
      console.log("[onscreen_agent] extracted from top-level object:", content);
      return content;
    }
  }

  // Support FastAPI / Workflow fields
  if (payload?.detail) {
    return `[Backend Error: ${payload.detail}]`;
  }

  if (payload?.execution_id) {
    return `[Workflow execution started: ${payload.execution_id} (Status: ${payload.status})]`;
  }

  console.warn("[onscreen_agent] could not extract content from payload:", payload);
  return "";
}

function createCompletionResponseMeta(mode) {
  return {
    finishReason: "",
    mode,
    payloadCount: 0,
    protocolObserved: false,
    sawDoneMarker: false,
    textChunkCount: 0,
    verifiedEmpty: false
  };
}

function noteCompletionPayload(meta, payload, textChunk = "") {
  meta.payloadCount += 1;

  const finishReason = payload?.choices?.[0]?.finish_reason;

  if (!meta.finishReason && typeof finishReason === "string" && finishReason) {
    meta.finishReason = finishReason;
  }

  if (typeof textChunk === "string" && textChunk.trim()) {
    meta.textChunkCount += 1;
  }
}

function finalizeCompletionResponseMeta(meta) {
  const protocolObserved = meta.mode === "standard" ? meta.payloadCount > 0 : meta.payloadCount > 0 || meta.sawDoneMarker;

  return {
    ...meta,
    protocolObserved,
    verifiedEmpty: protocolObserved && meta.textChunkCount === 0
  };
}

async function throwResponseError(response) {
  const contentType = response.headers.get("content-type") || "";
  let detail = "";

  if (contentType.includes("application/json")) {
    try {
      const payload = await response.json();
      detail = payload.error?.message || payload.error || JSON.stringify(payload);
    } catch {
      detail = "Unable to parse JSON error body.";
    }
  } else {
    detail = await response.text();
  }

  throw new Error(`Chat request failed with status ${response.status}: ${detail || response.statusText}`);
}

async function readStandardResponse(response, onDelta) {
  const meta = createCompletionResponseMeta("standard");
  const payload = await response.json();
  const message = extractNonStreamingMessage(payload);

  noteCompletionPayload(meta, payload, message);

  if (message) {
    onDelta(message);
  }

  return finalizeCompletionResponseMeta(meta);
}

function parseEventBlock(eventBlock, onDelta, meta) {
  const lines = eventBlock.split(/\r?\n/u);

  for (const line of lines) {
    if (!line.startsWith("data:")) {
      continue;
    }

    const value = line.slice(5).trim();

    if (!value) {
      continue;
    }

    if (value === "[DONE]") {
      meta.sawDoneMarker = true;
      return true;
    }

    const payload = JSON.parse(value);
    const delta = extractStreamingDelta(payload);

    noteCompletionPayload(meta, payload, delta);

    if (delta) {
      onDelta(delta);
    }
  }

  return false;
}

async function readStreamingResponse(response, onDelta) {
  const meta = createCompletionResponseMeta("stream");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), {
      stream: !done
    });

    let boundary = buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const eventBlock = buffer.slice(0, boundary).trim();
      buffer = buffer.slice(boundary + 2);

      if (eventBlock && parseEventBlock(eventBlock, onDelta, meta)) {
        return finalizeCompletionResponseMeta(meta);
      }

      boundary = buffer.indexOf("\n\n");
    }

    if (done) {
      const remaining = buffer.trim();

      if (remaining) {
        parseEventBlock(remaining, onDelta, meta);
      }

      return finalizeCompletionResponseMeta(meta);
    }
  }
}

function normalizeCompletionMessagesForLocal(messages) {
  return (Array.isArray(messages) ? messages : [])
    .map((message) => {
      const role =
        message?.role === "system"
          ? "system"
          : message?.role === "assistant"
            ? "assistant"
            : message?.role === "user"
              ? "user"
              : "";
      const content = extractTextContent(message?.content || "");

      if (!role || !content.trim()) {
        return null;
      }

      return {
        content,
        role
      };
    })
    .filter(Boolean);
}

function createApiRequestHeaders(apiKey) {
  const headers = {
    "Content-Type": "application/json"
  };

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  return headers;
}

// Minimal system prompt for local models (localhost/127.0.0.1).
// The full 499-line prime-silo operator prompt uses formatting tokens
// (_____javascript, _____user) and "invalid:" lists that cause local
// Qwen3/Llama models to produce zero output. A plain prompt avoids this,
// but must instruct the local model how to run JavaScript using the
// _____javascript separator.
const LOCAL_MODEL_MINIMAL_SYSTEM_PROMPT = `You are a browser runtime operator. You can execute javascript code on the page.

If the user asks you to load, render, or show a widget, or perform an action on the page or space, you MUST respond in the following format:
Line 1: A short description of the action.
Line 2: The separator "_____javascript"
Line 3+: Runnable javascript code.

If the previous turn's input is framework execution telemetry (starting with "_____framework") and indicates success (such as "execution success" or "execution returned no result"), you MUST respond with "Done." and stop. Do not re-execute the code, loop, or repeat the command.

Conversation Flow Example:
User: _____user
load the "Big Bang" space

Assistant:
Loading the "Big Bang" space...
_____javascript
return await space.spaces.openSpace("big-bang")

User: _____framework
execution success
execution returned no result and no console logs were printed

Assistant:
Done.

Example 1 (render custom widget):
Rendering the widget now...
_____javascript
return await space.current.renderWidget({
  id: "my-widget",
  name: "My Widget",
  cols: 8,
  rows: 6,
  renderer: async (parent) => {
    parent.innerHTML = "<div>Hello World</div>";
  }
})

Example 2 (render standard drilldown_table widget):
Rendering the drilldown table widget now...
_____javascript
return await space.current.renderWidget({
  id: "drilldown-table",
  name: "Drilldown Table",
  cols: 12,
  rows: 8,
  renderer: async (parent) => {
    const { createDrilldownTableWidget } = await import("/mod/_prime_silo/widgets/run/drilldown_table/index.js");
    createDrilldownTableWidget(parent, {
      run_id: "73d2a5dddb64",
      step_id: "gold_counterparty_exposure",
      workspace: "cmr_demo"
    });
  }
})

Example 3 (save layout view):
Saving the layout view now...
_____javascript
const { createAgentRuntimeClient } = await import("/mod/_prime_silo/runtime_client/runtime-client.js");
const client = createAgentRuntimeClient("sandbox");
return await client.saveView("cmr_demo", "risk-analysis.aamp.view", {
  schema: "aamp.view/1",
  panels: [
    {
      widget: "run.drilldown_table",
      run_id: "73d2a5dddb64",
      step_id: "gold_counterparty_exposure",
      workspace: "cmr_demo"
    }
  ]
})

Example 4 (load layout view):
Loading the layout view now...
_____javascript
const { createAgentRuntimeClient } = await import("/mod/_prime_silo/runtime_client/runtime-client.js");
const client = createAgentRuntimeClient("sandbox");
const envelope = await client.loadView("cmr_demo", "risk-analysis.aamp.view");
const panel = envelope.view.panels[0];
return await space.current.renderWidget({
  id: "drilldown-table",
  name: "Drilldown Table",
  cols: 12,
  rows: 8,
  renderer: async (parent) => {
    const { createDrilldownTableWidget } = await import("/mod/_prime_silo/widgets/run/drilldown_table/index.js");
    createDrilldownTableWidget(parent, {
      run_id: panel.run_id,
      step_id: panel.step_id,
      workspace: panel.workspace
    });
  }
})

Example 5 (read file):
Reading file now...
_____javascript
return await space.api.fileRead("~/contacts.yaml", "utf8")

Available helpers:
- space.api.fileList(path, recursive?)
- space.api.fileRead(path, encoding?)
- space.api.fileWrite(path, content, encoding?)
- space.current.readWidget(widgetName)
- space.current.seeWidget(widgetName)
- space.current.patchWidget(widgetId, { edits })
- space.current.renderWidget({ id, name, cols, rows, renderer })
- space.spaces.listSpaces()
- space.spaces.openSpace(id)

Standard widgets to import and mount inside the renderWidget's renderer function:
- run.drilldown_table: import { createDrilldownTableWidget } from "/mod/_prime_silo/widgets/run/drilldown_table/index.js" (props: { run_id, step_id, workspace })
- run.lineage_timeline: import { createLineageTimelineWidget } from "/mod/_prime_silo/widgets/run/lineage_timeline/index.js" (props: { run_id, step_id, workspace })
- run.frame_inspector: import { createFrameInspectorWidget } from "/mod/_prime_silo/widgets/run/frame_inspector/index.js" (props: { run_id, step_id, workspace })
- run.reasoning_trace: import { createReasoningTraceWidget } from "/mod/_prime_silo/widgets/run/reasoning_trace/index.js" (props: { run_id, step_id, workspace })

If a JavaScript execution completes successfully (for example, space.spaces.openSpace, space.current.renderWidget, or space.api.fileWrite returns success or completed with no errors), you MUST respond with "Done." and stop. Do not re-execute the code, loop, or repeat the command.

If no browser/space action is required, answer directly in prose. Always output the separator "_____javascript" on its own line when running code.`;

function isLocalModelEndpoint(url) {
  try {
    const { hostname } = new URL(String(url || ""));
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}

function patchMessagesForLocalModel(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) =>
    msg && msg.role === "system"
      ? { ...msg, content: LOCAL_MODEL_MINIMAL_SYSTEM_PROMPT }
      : msg
  );
}

function createApiRequestBody(settings, preparedRequest) {
  const isLocal = isLocalModelEndpoint(settings?.apiEndpoint);

  if (preparedRequest?.requestBody && typeof preparedRequest.requestBody === "object") {
    const body = { ...preparedRequest.requestBody };
    if (isLocal) {
      // Disable Qwen3 extended-thinking mode — thinking-only output produces
      // zero visible content chunks which triggers the protocol-correction loop.
      body.enable_thinking = false;
      // Replace the full operator system prompt with a minimal one that local
      // models can process without producing empty responses.
      if (Array.isArray(body.messages)) {
        body.messages = patchMessagesForLocalModel(body.messages);
      }
    }
    return body;
  }

  const requestMessages = Array.isArray(preparedRequest?.messages) ? preparedRequest.messages : [];
  const finalMessages = isLocal ? patchMessagesForLocalModel(requestMessages) : requestMessages;

  return {
    ...llmParams.parseOnscreenAgentParamsText(settings?.paramsText || ""),
    ...(isLocal ? { enable_thinking: false } : {}),
    model: settings?.model || config.DEFAULT_ONSCREEN_AGENT_SETTINGS.model,
    stream: true,
    messages: finalMessages
  };
}

function buildFetchRequestInit(apiRequest, signal) {
  const requestInit =
    apiRequest?.requestInit && typeof apiRequest.requestInit === "object"
      ? { ...apiRequest.requestInit }
      : {};
  const headers =
    apiRequest?.headers && typeof apiRequest.headers === "object"
      ? { ...apiRequest.headers }
      : {};

  requestInit.method = typeof apiRequest?.method === "string" && apiRequest.method.trim() ? apiRequest.method : "POST";
  requestInit.headers = headers;
  requestInit.signal = signal;

  if (!("body" in requestInit)) {
    if (apiRequest && "body" in apiRequest) {
      requestInit.body = apiRequest.body;
    } else if (apiRequest?.requestBody !== undefined) {
      requestInit.body = JSON.stringify(apiRequest.requestBody);
    }
  }

  return requestInit;
}

export class OnscreenAgentLlmClient {
  constructor(options = {}) {
    this.settings =
      options.settings && typeof options.settings === "object"
        ? options.settings
        : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
  }

  async resolvePreparedRequest(options = {}) {
    if (options.preparedRequest && typeof options.preparedRequest === "object") {
      return options.preparedRequest;
    }

    const promptOptions =
      options.promptOptions && typeof options.promptOptions === "object"
        ? options.promptOptions
        : {};

    return prepareOnscreenAgentCompletionRequest({
      messages: options.messages,
      options: promptOptions,
      promptInput: options.promptInput,
      settings: this.settings,
      systemPrompt: options.systemPrompt
    });
  }

  async streamCompletion() {
    throw new Error("LLM client subclasses must implement streamCompletion().");
  }
}

export class OnscreenAgentApiLlmClient extends OnscreenAgentLlmClient {
  validateSettings(settings = this.settings) {
    if (!settings?.apiEndpoint?.trim()) {
      throw new Error("Set an API endpoint before sending a message.");
    }

    const isLocal =
      settings.apiEndpoint.includes("localhost") ||
      settings.apiEndpoint.includes("127.0.0.1");

    if (!isLocal && !settings.apiKey.trim()) {
      throw new Error("Set an API key before sending a message.");
    }

    if (!settings.model.trim()) {
      throw new Error("Set a model before sending a message.");
    }
  }

  async resolveApiRequest(options = {}) {
    const preparedRequest = await this.resolvePreparedRequest(options);
    const effectiveSettings =
      preparedRequest?.settings && typeof preparedRequest.settings === "object"
        ? preparedRequest.settings
        : this.settings;

    return prepareOnscreenAgentApiRequest({
      preparedRequest,
      settings: effectiveSettings
    });
  }

  async streamCompletion(options = {}) {
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
    const effectiveRequest = await this.resolveApiRequest(options);
    const effectiveSettings =
      effectiveRequest?.settings && typeof effectiveRequest.settings === "object"
        ? effectiveRequest.settings
        : this.settings;

    this.validateSettings(effectiveSettings);

    const response = await fetch(effectiveRequest.requestUrl, {
      ...buildFetchRequestInit(effectiveRequest, options.signal)
    });

    if (!response.ok) {
      await throwResponseError(response);
    }

    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream")) {
      return readStandardResponse(response, onDelta);
    }

    if (!response.body) {
      throw new Error("Streaming response body is not available.");
    }

    return readStreamingResponse(response, onDelta);
  }
}

export class OnscreenAgentLocalLlmClient extends OnscreenAgentLlmClient {
  validateSettings(settings = this.settings) {
    const selection = config.getOnscreenAgentLocalModelSelection(settings);

    if (selection.provider !== config.ONSCREEN_AGENT_LOCAL_PROVIDER.HUGGINGFACE) {
      throw new Error("Choose a supported local LLM provider.");
    }

    if (!selection.modelId.trim()) {
      throw new Error("Choose a Hugging Face model before sending a message.");
    }

    if (!selection.dtype.trim()) {
      throw new Error("Choose a Hugging Face dtype before sending a message.");
    }
  }

  getCompletionMessages(preparedRequest) {
    const requestBodyMessages = Array.isArray(preparedRequest?.requestBody?.messages)
      ? preparedRequest.requestBody.messages
      : [];
    const requestMessages = Array.isArray(preparedRequest?.messages) ? preparedRequest.messages : [];

    // Local generation should reuse the same final transport message shape as the API path.
    return normalizeCompletionMessagesForLocal(requestBodyMessages.length ? requestBodyMessages : requestMessages);
  }

  async streamCompletion(options = {}) {
    const onDelta = typeof options.onDelta === "function" ? options.onDelta : () => {};
    const effectiveRequest = await this.resolvePreparedRequest(options);
    const effectiveSettings =
      effectiveRequest?.settings && typeof effectiveRequest.settings === "object"
        ? effectiveRequest.settings
        : this.settings;

    this.validateSettings(effectiveSettings);

    const result = await getHuggingFaceManager().streamCompletion({
      messages: this.getCompletionMessages(effectiveRequest),
      modelSelection: config.getOnscreenAgentLocalModelSelection(effectiveSettings),
      onDelta,
      requestOptions: llmParams.parseOnscreenAgentParamsText(effectiveSettings.paramsText || ""),
      signal: options.signal
    });

    return result.responseMeta;
  }
}

export const prepareOnscreenAgentApiRequest = globalThis.space.extend(
  import.meta,
  async function prepareOnscreenAgentApiRequest({ preparedRequest, settings } = {}) {
    const effectivePreparedRequest =
      preparedRequest && typeof preparedRequest === "object" ? preparedRequest : {};
    const effectiveSettings =
      settings && typeof settings === "object"
        ? settings
        : effectivePreparedRequest?.settings && typeof effectivePreparedRequest.settings === "object"
          ? effectivePreparedRequest.settings
          : config.DEFAULT_ONSCREEN_AGENT_SETTINGS;
    const apiEndpoint = String(effectiveSettings?.apiEndpoint || "").trim();

    return {
      apiEndpoint,
      headers: createApiRequestHeaders(String(effectiveSettings?.apiKey || "").trim()),
      messages: Array.isArray(effectivePreparedRequest?.messages) ? effectivePreparedRequest.messages : [],
      method: "POST",
      preparedRequest: effectivePreparedRequest,
      promptInput:
        effectivePreparedRequest?.promptInput && typeof effectivePreparedRequest.promptInput === "object"
          ? effectivePreparedRequest.promptInput
          : null,
      requestBody: createApiRequestBody(effectiveSettings, effectivePreparedRequest),
      requestUrl:
        typeof effectivePreparedRequest?.requestUrl === "string" && effectivePreparedRequest.requestUrl.trim()
          ? effectivePreparedRequest.requestUrl
          : apiEndpoint,
      settings: effectiveSettings,
      systemPrompt:
        typeof effectivePreparedRequest?.systemPrompt === "string" ? effectivePreparedRequest.systemPrompt : ""
    };
  }
);

export function createOnscreenAgentLlmClient(settings = config.DEFAULT_ONSCREEN_AGENT_SETTINGS) {
  const provider = config.normalizeOnscreenAgentLlmProvider(settings?.provider);

  if (provider === config.ONSCREEN_AGENT_LLM_PROVIDER.LOCAL) {
    return new OnscreenAgentLocalLlmClient({
      settings
    });
  }

  return new OnscreenAgentApiLlmClient({
    settings
  });
}

export const streamOnscreenAgentCompletion = globalThis.space.extend(
  import.meta,
  async function streamOnscreenAgentCompletion({
    messages,
    onDelta,
    preparedRequest,
    promptOptions,
    promptInput,
    settings,
    signal,
    systemPrompt
  }) {
    const normalizedSettings =
      settings && typeof settings === "object" ? settings : preparedRequest?.settings;
    const client = createOnscreenAgentLlmClient(normalizedSettings);

    return client.streamCompletion({
      messages,
      onDelta,
      preparedRequest,
      promptOptions,
      promptInput,
      signal,
      systemPrompt
    });
  }
);
