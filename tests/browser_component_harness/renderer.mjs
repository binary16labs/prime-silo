const BRIDGE_CHANNEL = "space.web_browsing.browser_frame";
const BRIDGE_PHASE = Object.freeze({
  EVENT: "event",
  REQUEST: "request",
  RESPONSE: "response"
});
const DEFAULT_BROWSER_ID = 1;
const DEFAULT_BROWSER_INTERNAL_ID = "browser-1";

function createDeferred() {
  let resolve = null;
  let reject = null;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });

  return {
    promise,
    reject,
    resolve
  };
}

function createNamedError(name, message, details = null) {
  const error = new Error(message);
  error.name = name;
  if (details && typeof details === "object") {
    error.details = details;
  }
  return error;
}

function createRequestId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `browser-component-harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, Math.max(0, Number(ms) || 0));
  });
}

function normalizeText(value) {
  return String(value || "").trim();
}

function stripUrlHash(value) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return "";
  }

  try {
    const parsedUrl = new URL(normalizedValue);
    parsedUrl.hash = "";
    return parsedUrl.href;
  } catch {
    return normalizedValue.replace(/#.*$/u, "");
  }
}

function isHashOnlyNavigation(previousUrl, nextUrl) {
  const normalizedPreviousUrl = normalizeText(previousUrl);
  const normalizedNextUrl = normalizeText(nextUrl);
  if (!normalizedPreviousUrl || !normalizedNextUrl || normalizedPreviousUrl === normalizedNextUrl) {
    return false;
  }

  return stripUrlHash(normalizedPreviousUrl) === stripUrlHash(normalizedNextUrl);
}

function looksLikeLocalHost(value) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return false;
  }

  const host = normalizedValue.split(/[/?#]/u, 1)[0] || "";
  return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3})(?::\d+)?$/iu.test(host);
}

function looksLikeTypedHost(value) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue || /\s/u.test(normalizedValue)) {
    return false;
  }

  const host = normalizedValue.split(/[/?#]/u, 1)[0] || "";
  return /^(?:localhost|\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d-]{2,63})(?::\d+)?$/iu.test(host);
}

function normalizeUrl(value) {
  const rawValue = normalizeText(value);
  if (!rawValue) {
    throw createNamedError("BrowserHarnessUrlError", "Browser harness navigation requires a non-empty URL.");
  }

  try {
    if (
      !/^[a-z][a-z\d+\-.]*:\/\//iu.test(rawValue)
      && !/^(about|blob|data|file|mailto|tel):/iu.test(rawValue)
      && !/^[/?#.]/u.test(rawValue)
      && looksLikeTypedHost(rawValue)
    ) {
      const protocol = looksLikeLocalHost(rawValue) ? "http://" : "https://";
      return new URL(`${protocol}${rawValue}`).href;
    }

    return new URL(rawValue).href;
  } catch {
    return new URL(`https://${rawValue}`).href;
  }
}

function parseSelectorInput(value) {
  const normalizedValue = normalizeText(value);
  if (!normalizedValue) {
    return null;
  }

  const parsed = JSON.parse(normalizedValue);
  if (!Array.isArray(parsed)) {
    throw createNamedError("BrowserHarnessSelectorError", "Browser harness selectors must be a JSON array of CSS selectors.");
  }

  return {
    selectors: parsed.map((selector) => String(selector || "").trim()).filter(Boolean)
  };
}

function formatValue(value) {
  if (value == null) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeEnvelope(envelope = {}) {
  return {
    phase: normalizeText(envelope.phase),
    requestId: normalizeText(envelope.requestId),
    type: normalizeText(envelope.type)
  };
}

class BrowserHarnessController {
  constructor({ host, log, setResult, webview }) {
    this.host = host;
    this.log = log;
    this.setResult = setResult;
    this.webview = webview;
    this.browserId = DEFAULT_BROWSER_ID;
    this.browserInternalId = DEFAULT_BROWSER_INTERNAL_ID;
    this.forceNextDocumentLifecycleReset = false;
    this.pendingRequests = new Map();
    this.browserState = {
      canGoBack: false,
      canGoForward: false,
      currentUrl: "about:blank",
      loading: false,
      title: ""
    };
    this.resetDocumentLifecycle("initial");
    this.bindEvents();
  }

  bindEvents() {
    this.webview.addEventListener("console-message", (event) => {
      const message = normalizeText(event.message);
      if (!message) {
        return;
      }

      this.log("info", message, {
        guestLine: Number(event.line) || 0,
        guestSourceId: normalizeText(event.sourceId)
      });
    });

    this.webview.addEventListener("did-start-navigation", (event) => {
      if (event?.isMainFrame === false) {
        return;
      }

      const nextUrl = normalizeText(event?.url) || this.browserState.currentUrl;
      const isSameDocument = !this.forceNextDocumentLifecycleReset && (
        event?.isSameDocument === true
        || isHashOnlyNavigation(this.browserState.currentUrl, nextUrl)
        || nextUrl === this.browserState.currentUrl
      );
      this.updateBrowserState({
        currentUrl: nextUrl,
        ...(isSameDocument ? {} : { loading: true })
      });
      if (!isSameDocument) {
        this.resetDocumentLifecycle("did-start-navigation");
      }
      this.forceNextDocumentLifecycleReset = false;
      this.log("info", isSameDocument ? "Guest same-document navigation started." : "Guest navigation started.", this.readStateSnapshot());
    });

    this.webview.addEventListener("did-start-loading", () => {
      this.updateBrowserState({
        loading: true
      });
    });

    this.webview.addEventListener("did-stop-loading", () => {
      this.updateBrowserState({
        loading: false
      });
      this.log("info", "Guest navigation stopped.", this.readStateSnapshot());
    });

    this.webview.addEventListener("did-navigate", (event) => {
      this.updateBrowserState({
        currentUrl: normalizeText(event.url)
      });
    });

    this.webview.addEventListener("did-navigate-in-page", (event) => {
      this.updateBrowserState({
        currentUrl: normalizeText(event.url)
      });
    });

    this.webview.addEventListener("page-title-updated", (event) => {
      this.updateBrowserState({
        title: normalizeText(event.title)
      });
    });

    this.webview.addEventListener("dom-ready", () => {
      const documentVersion = this.documentVersion;
      this.domReady = true;
      this.domReadyDeferred.resolve(true);
      this.log("info", "Guest document became DOM-ready.", {
        documentVersion,
        url: this.browserState.currentUrl
      });
      void this.injectGuestRuntime(documentVersion);
    });

    this.webview.addEventListener("ipc-message", (event) => {
      this.handleIpcMessage(event);
    });
  }

  resetDocumentLifecycle(reason = "reset") {
    this.rejectPendingRequests(reason);
    this.documentVersion = Number(this.documentVersion || 0) + 1;
    this.bridgeReady = false;
    this.coreReady = false;
    this.domReady = false;
    this.injectionInFlight = false;
    this.lastInjectionError = null;
    this.preloadReady = false;
    this.coreReadyDeferred = createDeferred();
    this.domReadyDeferred = createDeferred();
    this.log("debug", "Reset guest document lifecycle.", {
      documentVersion: this.documentVersion,
      reason
    });
  }

  rejectPendingRequests(reason = "reset") {
    if (!this.pendingRequests.size) {
      return;
    }

    const errorName = "BrowserHarnessDocumentReplacedError";
    const errorMessage = "Guest document changed before the pending browser request completed.";

    for (const [requestId, pendingRequest] of this.pendingRequests.entries()) {
      globalThis.clearTimeout(pendingRequest.timer);
      pendingRequest.reject(createNamedError(errorName, errorMessage, {
        nextDocumentVersion: Number(this.documentVersion || 0) + 1,
        reason,
        requestId,
        type: pendingRequest.type
      }));
      this.pendingRequests.delete(requestId);
    }
  }

  updateBrowserState(patch = {}) {
    if (!patch || typeof patch !== "object") {
      return;
    }

    if (Object.hasOwn(patch, "canGoBack")) {
      this.browserState.canGoBack = Boolean(patch.canGoBack);
    }

    if (Object.hasOwn(patch, "canGoForward")) {
      this.browserState.canGoForward = Boolean(patch.canGoForward);
    }

    if (Object.hasOwn(patch, "currentUrl")) {
      this.browserState.currentUrl = normalizeText(patch.currentUrl) || this.browserState.currentUrl;
    }

    if (Object.hasOwn(patch, "loading")) {
      this.browserState.loading = Boolean(patch.loading);
    }

    if (Object.hasOwn(patch, "title")) {
      this.browserState.title = normalizeText(patch.title) || this.browserState.title;
    }
  }

  readStateSnapshot() {
    return {
      ...this.browserState,
      bridgeReady: this.bridgeReady,
      browserId: this.browserId,
      browserInternalId: this.browserInternalId,
      coreReady: this.coreReady,
      preloadReady: this.preloadReady
    };
  }

  normalizeScopedArgs(args = [], { minimumArgumentCount = 0 } = {}) {
    const values = Array.isArray(args) ? [...args] : [];
    const firstValue = values[0];
    if (
      values.length > minimumArgumentCount
      && (
        firstValue === this.browserId
        || normalizeText(firstValue) === this.browserInternalId
      )
    ) {
      values.shift();
    }

    return values;
  }

  async injectGuestRuntime(documentVersion) {
    if (documentVersion !== this.documentVersion || this.injectionInFlight) {
      return;
    }

    this.injectionInFlight = true;
    const runtime = this.host.buildGuestRuntimeSource(this.browserInternalId);
    const bootstrap = {
      browserId: this.browserInternalId,
      iframeId: this.browserInternalId,
      scriptPath: runtime.injectPath,
      scriptUrl: runtime.scriptUrl
    };
    const injectSource = `(() => {\n  const bootstrap = ${JSON.stringify(bootstrap)};\n  globalThis.__spaceBrowserInjectBootstrap__ = bootstrap;\n  globalThis.__spaceBrowserFrameInjectBootstrap__ = bootstrap;\n  try {\n${runtime.source}\n  } finally {\n    delete globalThis.__spaceBrowserInjectBootstrap__;\n    delete globalThis.__spaceBrowserFrameInjectBootstrap__;\n  }\n})();\n//# sourceURL=${runtime.scriptUrl}`;

    try {
      await this.webview.executeJavaScript(injectSource, true);
      if (documentVersion === this.documentVersion) {
        this.log("info", `Injected browser runtime into ${this.browserInternalId}.`, {
          browserId: this.browserInternalId,
          injectPath: runtime.injectPath,
          scriptUrl: runtime.scriptUrl
        });
      }
    } catch (error) {
      this.lastInjectionError = error;
      this.log("error", `Failed to inject browser runtime into ${this.browserInternalId}.`, {
        error: String(error?.message || error),
        stack: normalizeText(error?.stack)
      });
      if (documentVersion === this.documentVersion) {
        this.coreReadyDeferred.reject(error);
      }
    } finally {
      this.injectionInFlight = false;
    }
  }

  async waitForCoreReady(timeoutMs = 30000) {
    const deadline = Date.now() + Math.max(1, Number(timeoutMs) || 0);

    while (Date.now() < deadline) {
      if (this.coreReady) {
        return true;
      }

      if (this.lastInjectionError) {
        throw this.lastInjectionError;
      }

      const remainingMs = Math.max(1, deadline - Date.now());
      try {
        await Promise.race([
          this.coreReadyDeferred.promise,
          delay(Math.min(remainingMs, 50))
        ]);
      } catch (error) {
        if (error?.name === "BrowserHarnessDocumentReplacedError") {
          continue;
        }

        throw error;
      }
    }

    if (this.coreReady) {
      return true;
    }

    if (this.lastInjectionError) {
      throw this.lastInjectionError;
    }

    throw createNamedError(
      "BrowserHarnessTimeoutError",
      "Timed out waiting for the guest browser runtime to become ready.",
      {
        timeoutMs
      }
    );
  }

  async waitForDocumentVersionChange(previousVersion, timeoutMs = 10000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (this.documentVersion !== previousVersion) {
        return this.documentVersion;
      }

      await delay(25);
    }

    throw createNamedError(
      "BrowserHarnessTimeoutError",
      "Timed out waiting for the guest browser to start a new document navigation.",
      {
        previousVersion,
        timeoutMs
      }
    );
  }

  handleIpcMessage(event) {
    if (normalizeText(event.channel) !== BRIDGE_CHANNEL) {
      return;
    }

    const envelope = event.args?.[0] || {};
    this.log("debug", "Received envelope from guest.", summarizeEnvelope(envelope));

    if (normalizeText(envelope.phase) === BRIDGE_PHASE.EVENT) {
      this.handleGuestEvent(envelope.type, envelope.payload);
      return;
    }

    if (normalizeText(envelope.phase) !== BRIDGE_PHASE.RESPONSE) {
      return;
    }

    const requestId = normalizeText(envelope.requestId);
    const pendingRequest = this.pendingRequests.get(requestId);
    if (!pendingRequest) {
      return;
    }

    this.pendingRequests.delete(requestId);
    globalThis.clearTimeout(pendingRequest.timer);

    if (envelope.ok === false) {
      const errorPayload = envelope.payload && typeof envelope.payload === "object"
        ? envelope.payload
        : {};
      const error = createNamedError(
        normalizeText(errorPayload.name) || "BrowserHarnessGuestError",
        normalizeText(errorPayload.message) || `Guest request "${normalizeText(envelope.type)}" failed.`,
        {
          code: errorPayload.code ?? null,
          details: errorPayload.details || {}
        }
      );
      pendingRequest.reject(error);
      return;
    }

    pendingRequest.resolve(envelope.payload ?? null);
  }

  handleGuestEvent(type, payload = null) {
    const normalizedType = normalizeText(type);

    if (normalizedType === "__preload_ready__") {
      const isMainFrame = payload?.isMainFrame !== false;
      if (!isMainFrame) {
        return;
      }

      this.preloadReady = true;
      this.log("info", "Guest preload ready.", payload);
      if (!this.coreReady && !this.injectionInFlight) {
        void this.injectGuestRuntime(this.documentVersion);
      }
      return;
    }

    if (normalizedType === "__bridge_ready__") {
      this.bridgeReady = true;
      this.log("info", "Guest bridge runtime ready.", payload);
      return;
    }

    if (normalizedType === "__core_handlers_ready__") {
      this.coreReady = true;
      this.log("info", "Guest core handlers ready.", payload);
      this.coreReadyDeferred.resolve(true);
      return;
    }

    if (normalizedType === "navigation_state") {
      if (payload && typeof payload === "object") {
        this.updateBrowserState({
          canGoBack: payload.canGoBack,
          canGoForward: payload.canGoForward,
          currentUrl: payload.url,
          title: payload.title
        });
      }
      return;
    }

    if (normalizedType === "open_window") {
      const nextUrl = normalizeText(payload?.url);
      if (nextUrl) {
        this.log("info", "Guest requested a new window; reusing the single harness browser view.", {
          url: nextUrl
        });
        void this.open(nextUrl);
      }
    }
  }

  sendRequest(type, payload = null, timeoutMs = 30000) {
    return this.waitForCoreReady(timeoutMs).then(() => {
      const requestId = createRequestId();
      const deferred = createDeferred();
      const timer = globalThis.setTimeout(() => {
        this.pendingRequests.delete(requestId);
        deferred.reject(createNamedError(
          "BrowserHarnessTimeoutError",
          `Browser webview bridge request "${type}" timed out after ${timeoutMs}ms.`,
          {
            requestId,
            timeoutMs,
            type
          }
        ));
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        documentVersion: this.documentVersion,
        reject: deferred.reject,
        resolve: deferred.resolve,
        timer,
        type
      });

      const envelope = {
        channel: BRIDGE_CHANNEL,
        payload,
        phase: BRIDGE_PHASE.REQUEST,
        requestId,
        type
      };

      this.log("debug", "Sending envelope to guest.", summarizeEnvelope(envelope));
      this.webview.send(BRIDGE_CHANNEL, envelope);
      return deferred.promise;
    });
  }

  async sendRequestWithRetry(type, payload = null, timeoutMs = 30000) {
    try {
      return await this.sendRequest(type, payload, timeoutMs);
    } catch (error) {
      if (error?.name !== "BrowserHarnessDocumentReplacedError") {
        throw error;
      }

      await this.waitForCoreReady(timeoutMs);
      return await this.sendRequest(type, payload, timeoutMs);
    }
  }

  async waitForPossibleNavigation(previousVersion, waitMs = 2500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < waitMs) {
      if (this.documentVersion !== previousVersion) {
        return true;
      }

      await delay(25);
    }

    return false;
  }

  async waitForGuestUsable(timeoutMs = 8000, quietMs = 250) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    let observedVersion = this.documentVersion;

    while (Date.now() < deadline) {
      await this.waitForCoreReady(Math.max(1, deadline - Date.now()));
      if (this.documentVersion !== observedVersion) {
        observedVersion = this.documentVersion;
        continue;
      }

      let stableSince = Date.now();

      while (Date.now() < deadline) {
        if (this.documentVersion !== observedVersion) {
          observedVersion = this.documentVersion;
          stableSince = Date.now();
          break;
        }

        if (this.browserState.loading) {
          stableSince = Date.now();
          await delay(25);
          continue;
        }

        if (Date.now() - stableSince >= quietMs) {
          return this.readStateSnapshot();
        }

        await delay(25);
      }
    }

    throw createNamedError(
      "BrowserHarnessTimeoutError",
      "Timed out waiting for the guest browser to become usable after navigation.",
      {
        browserState: this.readStateSnapshot(),
        quietMs,
        timeoutMs
      }
    );
  }

  async waitForGuestUsableOrSettled(timeoutMs = 8000, quietMs = 250) {
    try {
      return await this.waitForGuestUsable(timeoutMs, quietMs);
    } catch (error) {
      if (this.browserState.loading) {
        throw error;
      }

      this.log("warn", "Guest bridge readiness timed out after navigation; returning the settled page state instead.", {
        browserState: this.readStateSnapshot(),
        error: String(error?.message || error),
        quietMs,
        timeoutMs
      });
      return this.readStateSnapshot();
    }
  }

  buildActionResponse(action, beforeState, state, extraStatus = {}) {
    if (!action || typeof action !== "object" || Array.isArray(action)) {
      return state;
    }

    const status = {
      ...(action.status && typeof action.status === "object" ? action.status : {}),
      ...extraStatus
    };
    status.urlChanged = beforeState.currentUrl !== state.currentUrl;
    status.titleChanged = beforeState.title !== state.title;
    status.historyChanged = beforeState.canGoBack !== state.canGoBack
      || beforeState.canGoForward !== state.canGoForward;
    status.navigated = status.urlChanged || beforeState.currentUrl !== state.currentUrl;
    status.reacted = Object.entries(status).some(([key, value]) => key !== "reacted" && key !== "noObservedEffect" && value === true);
    status.noObservedEffect = !status.reacted;

    return {
      action: {
        ...action,
        status
      },
      state
    };
  }

  async runNavigatingAction(type, payload = null, {
    actionTimeoutMs = 30000,
    navigationReadyTimeoutMs = 8000,
    navigationWaitMs = 2500
  } = {}) {
    const beforeState = this.readStateSnapshot();
    const previousVersion = this.documentVersion;
    let result = null;

    try {
      result = await this.sendRequest(type, payload, actionTimeoutMs);
    } catch (error) {
      if (error?.name !== "BrowserHarnessDocumentReplacedError" || this.documentVersion === previousVersion) {
        throw error;
      }

      const state = await this.waitForGuestUsableOrSettled(navigationReadyTimeoutMs);
      return this.buildActionResponse({
        effect: {},
        status: {}
      }, beforeState, state, {
        navigated: true
      });
    }

    const navigated = await this.waitForPossibleNavigation(previousVersion, navigationWaitMs);
    if (navigated) {
      const state = await this.waitForGuestUsableOrSettled(navigationReadyTimeoutMs);
      return this.buildActionResponse(result, beforeState, state, {
        navigated: true
      });
    }

    return this.buildActionResponse(result, beforeState, this.readStateSnapshot());
  }

  async open(url) {
    const nextUrl = normalizeUrl(url);
    const previousVersion = this.documentVersion;
    this.forceNextDocumentLifecycleReset = true;
    this.updateBrowserState({
      currentUrl: nextUrl,
      loading: true
    });
    if (typeof this.webview.loadURL === "function") {
      const loadPromise = this.webview.loadURL(nextUrl);
      if (loadPromise && typeof loadPromise.catch === "function") {
        void loadPromise.catch((error) => {
          this.log("warn", "Guest loadURL reported an error; continuing to follow observed navigation state.", {
            error: String(error?.message || error),
            url: nextUrl
          });
        });
      }
    } else {
      this.webview.setAttribute("src", nextUrl);
    }

    await this.waitForDocumentVersionChange(previousVersion, 3000);
    return {
      id: this.browserId,
      state: await this.waitForGuestUsableOrSettled(6500)
    };
  }

  async state(...args) {
    this.normalizeScopedArgs(args);
    return this.readStateSnapshot();
  }

  async dom(...args) {
    const [payload = null] = this.normalizeScopedArgs(args);
    return await this.sendRequestWithRetry("dom", payload, 60000);
  }

  async content(...args) {
    const [payload = null] = this.normalizeScopedArgs(args);
    return await this.sendRequestWithRetry("content", payload, 60000);
  }

  async detail(...args) {
    const [referenceId] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 1
    });
    return await this.sendRequestWithRetry("detail", {
      referenceId
    }, 30000);
  }

  async click(...args) {
    const [referenceId] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 1
    });
    return await this.runNavigatingAction("click", {
      referenceId
    }, {
      actionTimeoutMs: 30000
    });
  }

  async type(...args) {
    const [referenceId, value] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 2
    });
    const beforeState = this.readStateSnapshot();
    const result = await this.sendRequest("type", {
      referenceId,
      value
    }, 30000);
    return this.buildActionResponse(result, beforeState, this.readStateSnapshot());
  }

  async typeSubmit(...args) {
    const [referenceId, value] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 2
    });
    return await this.runNavigatingAction("type_submit", {
      referenceId,
      value
    }, {
      actionTimeoutMs: 30000
    });
  }

  async submit(...args) {
    const [referenceId] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 1
    });
    return await this.runNavigatingAction("submit", {
      referenceId
    }, {
      actionTimeoutMs: 30000
    });
  }

  async scroll(...args) {
    const [referenceId] = this.normalizeScopedArgs(args, {
      minimumArgumentCount: 1
    });
    const beforeState = this.readStateSnapshot();
    const result = await this.sendRequest("scroll", {
      referenceId
    }, 30000);
    return this.buildActionResponse(result, beforeState, this.readStateSnapshot());
  }

  async reload() {
    const previousVersion = this.documentVersion;
    this.forceNextDocumentLifecycleReset = true;
    this.updateBrowserState({
      loading: true
    });
    this.webview.reload();
    await this.waitForDocumentVersionChange(previousVersion, 3000);
    return await this.waitForGuestUsableOrSettled(6500);
  }

  async back() {
    if (!this.browserState.canGoBack) {
      return this.readStateSnapshot();
    }

    const previousVersion = this.documentVersion;
    this.updateBrowserState({
      loading: true
    });
    this.webview.goBack();
    await this.waitForDocumentVersionChange(previousVersion, 3000);
    return await this.waitForGuestUsableOrSettled(6500);
  }

  async forward() {
    if (!this.browserState.canGoForward) {
      return this.readStateSnapshot();
    }

    const previousVersion = this.documentVersion;
    this.updateBrowserState({
      loading: true
    });
    this.webview.goForward();
    await this.waitForDocumentVersionChange(previousVersion, 3000);
    return await this.waitForGuestUsableOrSettled(6500);
  }
}

const host = globalThis.browserHarnessHost;
if (!host) {
  throw new Error("Standalone browser component harness host bridge is unavailable.");
}

const resultOutput = globalThis.document.getElementById("result-output");
const logOutput = globalThis.document.getElementById("log-output");
const webview = globalThis.document.getElementById("browser-webview");
const urlInput = globalThis.document.getElementById("url-input");
const referenceInput = globalThis.document.getElementById("reference-input");
const valueInput = globalThis.document.getElementById("value-input");
const selectorInput = globalThis.document.getElementById("selector-input");

function setResult(value) {
  resultOutput.textContent = formatValue(value);
}

function log(level, message, details = null) {
  const prefix = `[browser-component-harness/${level}]`;
  const line = details && typeof details === "object" && Object.keys(details).length
    ? `${prefix} ${message} ${formatValue(details)}`
    : `${prefix} ${message}`;
  logOutput.textContent = `${line}\n${logOutput.textContent}`.trim();

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  host.reportProgress({
    details,
    level,
    message
  });
}

const controller = new BrowserHarnessController({
  host,
  log,
  setResult,
  webview
});

function readReferenceId() {
  const rawValue = normalizeText(referenceInput.value);
  const referenceId = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(referenceId)) {
    throw createNamedError("BrowserHarnessReferenceError", "Browser harness actions require an integer reference id.");
  }

  return referenceId;
}

async function runUiAction(label, action) {
  try {
    log("info", `${label} started.`);
    const result = await action();
    setResult(result);
    log("info", `${label} completed.`);
    return result;
  } catch (error) {
    setResult({
      error: {
        details: error?.details || null,
        message: String(error?.message || error),
        name: String(error?.name || "Error"),
        stack: normalizeText(error?.stack)
      }
    });
    log("error", `${label} failed.`, {
      details: error?.details || null,
      message: String(error?.message || error),
      name: String(error?.name || "Error")
    });
    throw error;
  }
}

globalThis.document.getElementById("open-button").addEventListener("click", () => {
  void runUiAction("Open", () => controller.open(urlInput.value));
});
globalThis.document.getElementById("back-button").addEventListener("click", () => {
  void runUiAction("Back", () => controller.back());
});
globalThis.document.getElementById("forward-button").addEventListener("click", () => {
  void runUiAction("Forward", () => controller.forward());
});
globalThis.document.getElementById("reload-button").addEventListener("click", () => {
  void runUiAction("Reload", () => controller.reload());
});
globalThis.document.getElementById("state-button").addEventListener("click", () => {
  void runUiAction("State", () => controller.state());
});
globalThis.document.getElementById("content-button").addEventListener("click", () => {
  void runUiAction("Content", () => controller.content(parseSelectorInput(selectorInput.value)));
});
globalThis.document.getElementById("dom-button").addEventListener("click", () => {
  void runUiAction("DOM", () => controller.dom(parseSelectorInput(selectorInput.value)));
});
globalThis.document.getElementById("detail-button").addEventListener("click", () => {
  void runUiAction("Detail", () => controller.detail(readReferenceId()));
});
globalThis.document.getElementById("click-button").addEventListener("click", () => {
  void runUiAction("Click", () => controller.click(readReferenceId()));
});
globalThis.document.getElementById("type-button").addEventListener("click", () => {
  void runUiAction("Type", () => controller.type(readReferenceId(), valueInput.value));
});
globalThis.document.getElementById("type-submit-button").addEventListener("click", () => {
  void runUiAction("Type+Enter", () => controller.typeSubmit(readReferenceId(), valueInput.value));
});
globalThis.document.getElementById("submit-button").addEventListener("click", () => {
  void runUiAction("Submit", () => controller.submit(readReferenceId()));
});
globalThis.document.getElementById("scroll-button").addEventListener("click", () => {
  void runUiAction("Scroll", () => controller.scroll(readReferenceId()));
});

const requestMethodMap = new Map([
  ["open", (...args) => controller.open(...args)],
  ["state", (...args) => controller.state(...args)],
  ["dom", (...args) => controller.dom(...args)],
  ["content", (...args) => controller.content(...args)],
  ["detail", (...args) => controller.detail(...args)],
  ["click", (...args) => controller.click(...args)],
  ["type", (...args) => controller.type(...args)],
  ["typeSubmit", (...args) => controller.typeSubmit(...args)],
  ["submit", (...args) => controller.submit(...args)],
  ["scroll", (...args) => controller.scroll(...args)],
  ["reload", (...args) => controller.reload(...args)],
  ["back", (...args) => controller.back(...args)],
  ["forward", (...args) => controller.forward(...args)]
]);

host.onRequest(async (request = {}) => {
  const requestId = normalizeText(request.requestId);
  const type = normalizeText(request.type);

  try {
    let result = null;

    if (type === "probe") {
      result = {
        ready: true,
        state: controller.readStateSnapshot()
      };
    } else if (type === "browser_call") {
      const method = normalizeText(request.payload?.method);
      const args = Array.isArray(request.payload?.args) ? request.payload.args : [];
      const handler = requestMethodMap.get(method);
      if (!handler) {
        throw createNamedError("BrowserHarnessMethodError", `Standalone browser harness does not support "${method}".`, {
          method
        });
      }

      result = await handler(...args);
    } else {
      throw createNamedError("BrowserHarnessRequestError", `Standalone browser harness does not support request type "${type}".`, {
        type
      });
    }

    host.respond({
      ok: true,
      requestId,
      result
    });
  } catch (error) {
    host.respond({
      error: {
        details: error?.details || null,
        message: String(error?.message || error),
        name: String(error?.name || "Error"),
        stack: normalizeText(error?.stack)
      },
      ok: false,
      requestId
    });
  }
});

setResult({
  ready: true,
  state: controller.readStateSnapshot()
});
log("info", "Standalone browser component harness renderer is ready.", {
  scenario: host.config?.scenario || ""
});
