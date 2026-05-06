const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { app, BrowserWindow, ipcMain } = require("electron");

const REQUEST_CHANNEL = "space-browser-component-harness:request";
const RESPONSE_CHANNEL = "space-browser-component-harness:response";
const PROGRESS_CHANNEL = "space-browser-component-harness:progress";
const RESULT_PREFIX = "[desktop-browser-harness-result] ";
const SCENARIO_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_SCENARIO";
const OPEN_DEVTOOLS_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_OPEN_DEVTOOLS";
const PARENT_IPC_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_PARENT_IPC";
const DEFAULT_BROWSER_ID = 1;
const DEFAULT_BROWSER_INTERNAL_ID = "browser-1";
const STEP_TIMEOUT_MS = 120000;
const CONSENT_TIMEOUT_MS = 180000;
const WEBVIEW_PRELOAD_PATH = path.resolve(__dirname, "../../packaging/desktop/browser-webview-preload.js");

let mainWindow = null;

function isParentIpcEnabled() {
  return String(process.env[PARENT_IPC_ENV] || "").trim() === "1"
    && typeof process.send === "function";
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createError(message, details = null) {
  const error = new Error(message);
  if (details && typeof details === "object") {
    error.details = details;
  }
  return error;
}

function createRequestId() {
  return typeof randomUUID === "function"
    ? randomUUID()
    : `browser-component-harness-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function serializeError(error, fallbackMessage = "Standalone browser component harness failed.") {
  return {
    details: error?.details && typeof error.details === "object" ? error.details : null,
    message: String(error?.message || fallbackMessage),
    name: String(error?.name || "Error"),
    stack: String(error?.stack || "")
  };
}

function logProgress(message, details = null) {
  sendParentMessage({
    details,
    message,
    type: "progress"
  });

  if (details && typeof details === "object" && Object.keys(details).length) {
    console.log(`[browser-component-harness] ${message}`, details);
    return;
  }

  console.log(`[browser-component-harness] ${message}`);
}

function sendParentMessage(payload = {}) {
  if (!isParentIpcEnabled()) {
    return;
  }

  try {
    process.send(payload);
  } catch {
    // Ignore parent IPC failures in the standalone harness.
  }
}

function findFirstReference(document, pattern) {
  const match = String(document || "").match(pattern);
  if (!match) {
    return null;
  }

  const referenceId = Number.parseInt(match[1], 10);
  return Number.isInteger(referenceId) ? referenceId : null;
}

function collectReferenceMatches(document, pattern, limit = 20) {
  const text = String(document || "");
  const matches = [];

  for (const match of text.matchAll(pattern)) {
    const referenceId = Number.parseInt(match[1], 10);
    if (!Number.isInteger(referenceId)) {
      continue;
    }

    matches.push({
      line: String(match[0] || ""),
      referenceId
    });

    if (matches.length >= limit) {
      break;
    }
  }

  return matches;
}

async function requestRenderer(type, payload = null, { timeoutMs = STEP_TIMEOUT_MS } = {}) {
  if (!mainWindow?.webContents || mainWindow.webContents.isDestroyed()) {
    throw createError("Standalone browser component harness window is unavailable.");
  }

  const requestId = createRequestId();

  return await new Promise((resolve, reject) => {
    const handleResponse = (_event, response = {}) => {
      if (String(response?.requestId || "") !== requestId) {
        return;
      }

      cleanup();

      if (response?.ok === false) {
        reject(createError(
          String(response?.error?.message || `Harness request "${type}" failed.`),
          response?.error && typeof response.error === "object" ? response.error : null
        ));
        return;
      }

      resolve(response?.result ?? null);
    };

    const cleanup = () => {
      clearTimeout(timer);
      ipcMain.removeListener(RESPONSE_CHANNEL, handleResponse);
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(createError(`Timed out waiting for harness response "${type}".`, {
        requestId,
        timeoutMs,
        type
      }));
    }, timeoutMs);

    ipcMain.on(RESPONSE_CHANNEL, handleResponse);
    mainWindow.webContents.send(REQUEST_CHANNEL, {
      payload,
      requestId,
      type
    });
  });
}

async function waitFor(fn, {
  label = "condition",
  timeoutMs = STEP_TIMEOUT_MS
} = {}) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }

    await delay(500);
  }

  throw createError(`Timed out waiting for ${label}.`, {
    cause: String(lastError?.message || lastError || "")
  });
}

async function probeHarness() {
  return await requestRenderer("probe");
}

async function waitForHarnessReady() {
  return await waitFor(async () => {
    const probe = await probeHarness();
    return probe?.ready ? probe : null;
  }, {
    label: "standalone browser controller"
  });
}

async function callBrowser(method, ...args) {
  return await requestRenderer("browser_call", {
    args,
    method
  });
}

async function waitForContentMatch(browserId, matcher, {
  contentPayload = null,
  label,
  timeoutMs = STEP_TIMEOUT_MS
} = {}) {
  return await waitFor(async () => {
    const content = await callBrowser("content", browserId, contentPayload);
    return matcher(content) ? content : null;
  }, {
    label,
    timeoutMs
  });
}

async function runNovinkyConsentScenario() {
  await waitForHarnessReady();

  logProgress("Opening Novinky in the standalone browser harness.");
  const opened = await callBrowser("open", "https://www.novinky.cz");
  const browserId = Number.isInteger(opened?.id) ? opened.id : DEFAULT_BROWSER_ID;

  const listing = await waitForContentMatch(browserId, (content) => {
    const document = String(content?.document || "");
    return findFirstReference(document, /\[link (\d+)\](?: [^\n]+)? -> [^\n]*\/clanek\//u) != null;
  }, {
    contentPayload: {
      includeLinkUrls: true
    },
    label: "Novinky listing content"
  });
  const articleReferenceId = findFirstReference(
    listing?.document,
    /\[link (\d+)\](?: [^\n]+)? -> [^\n]*\/clanek\//u
  );

  if (!articleReferenceId) {
    throw createError("Could not find an article reference on the Novinky listing page.", {
      listing
    });
  }

  const articleDetail = await callBrowser("detail", browserId, articleReferenceId);
  logProgress(`Clicking Novinky article reference ${articleReferenceId}.`, {
    articleDetail
  });
  await callBrowser("click", browserId, articleReferenceId);

  const consent = await waitForContentMatch(browserId, (content) => {
    const document = String(content?.document || "");
    return document.includes('title: "Nastavení souhlasu s personalizací"')
      && findFirstReference(document, /\[button (\d+)\] Souhlasím/u) != null;
  }, {
    label: "Novinky consent page",
    timeoutMs: CONSENT_TIMEOUT_MS
  });
  const consentReferenceId = findFirstReference(
    consent?.document,
    /\[button (\d+)\] Souhlasím/u
  );

  if (!consentReferenceId) {
    throw createError('Could not find the "Souhlasím" reference on the Novinky consent page.', {
      consent
    });
  }

  const consentDetail = await callBrowser("detail", browserId, consentReferenceId);
  logProgress(`Clicking Novinky consent reference ${consentReferenceId}.`, {
    consentDetail
  });
  await callBrowser("click", browserId, consentReferenceId);

  const finalContent = await waitForContentMatch(browserId, (content) => {
    const document = String(content?.document || "");
    return /url: "https:\/\/www\.novinky\.cz\/clanek\//u.test(document)
      && !document.includes('title: "Nastavení souhlasu s personalizací"');
  }, {
    label: "Novinky article after consent",
    timeoutMs: CONSENT_TIMEOUT_MS
  });
  const finalState = await callBrowser("state", browserId);

  return {
    articleReferenceId,
    articleDetail,
    browserId,
    consentReferenceId,
    consentDetail,
    finalContent,
    finalState,
    listing,
    success: true
  };
}

async function runNovinkyListingDebugScenario() {
  await waitForHarnessReady();

  logProgress("Opening Novinky in the standalone browser harness for listing debug.");
  const opened = await callBrowser("open", "https://www.novinky.cz");
  const browserId = Number.isInteger(opened?.id) ? opened.id : DEFAULT_BROWSER_ID;
  const content = await waitForContentMatch(browserId, (payload) => {
    return normalizeText(payload?.document).length > 0;
  }, {
    contentPayload: {
      includeLinkUrls: true
    },
    label: "Novinky listing debug content"
  });

  return {
    articleLinks: collectReferenceMatches(
      content?.document,
      /\[link (\d+)\](?: [^\n]+)? -> [^\n]*\/clanek\//gu,
      30
    ),
    browserId,
    content,
    success: true
  };
}

async function runNovinkyClickDebugScenario() {
  await waitForHarnessReady();

  logProgress("Opening Novinky in the standalone browser harness for click debug.");
  const opened = await callBrowser("open", "https://www.novinky.cz");
  const browserId = Number.isInteger(opened?.id) ? opened.id : DEFAULT_BROWSER_ID;
  const content = await waitForContentMatch(browserId, (payload) => {
    return findFirstReference(
      payload?.document,
      /\[link (\d+)\](?: [^\n]+)? -> [^\n]*\/clanek\//u
    ) != null;
  }, {
    contentPayload: {
      includeLinkUrls: true
    },
    label: "Novinky click debug listing"
  });
  const articleReferenceId = findFirstReference(
    content?.document,
    /\[link (\d+)\](?: [^\n]+)? -> [^\n]*\/clanek\//u
  );

  const articleDetail = await callBrowser("detail", browserId, articleReferenceId);
  await callBrowser("click", browserId, articleReferenceId);
  await delay(5000);

  return {
    afterClickContent: await callBrowser("content", browserId),
    afterClickState: await callBrowser("state", browserId),
    articleDetail,
    articleReferenceId,
    beforeClickContent: content,
    browserId,
    success: true
  };
}

async function runScenarioByName(name) {
  if (name === "novinkyConsent") {
    return await runNovinkyConsentScenario();
  }

  if (name === "novinkyListingDebug") {
    return await runNovinkyListingDebugScenario();
  }

  if (name === "novinkyClickDebug") {
    return await runNovinkyClickDebugScenario();
  }

  throw createError(`Unsupported standalone browser harness scenario "${name}".`, {
    scenario: name
  });
}

async function handleParentCommand(command = "", args = []) {
  const normalizedCommand = normalizeText(command);

  if (!normalizedCommand || normalizedCommand === "probe") {
    return await probeHarness();
  }

  if (normalizedCommand === "quit") {
    return {
      quitting: true
    };
  }

  if (normalizedCommand === "open" || normalizedCommand === "navigate") {
    return await callBrowser("open", ...args);
  }

  if ([
    "state",
    "dom",
    "content",
    "detail",
    "click",
    "type",
    "typeSubmit",
    "submit",
    "scroll",
    "reload",
    "back",
    "forward"
  ].includes(normalizedCommand)) {
    return await callBrowser(normalizedCommand, ...args);
  }

  throw createError(`Unsupported standalone browser harness command "${normalizedCommand}".`, {
    args,
    command: normalizedCommand
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    backgroundColor: "#05070a",
    height: 960,
    show: true,
    width: 1440,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false,
      webviewTag: true
    }
  });

  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.preload = WEBVIEW_PRELOAD_PATH;
    webPreferences.contextIsolation = true;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = true;
    webPreferences.sandbox = false;
    webPreferences.additionalArguments = [
      ...(Array.isArray(webPreferences.additionalArguments) ? webPreferences.additionalArguments : []),
      `--space-browser-id=${DEFAULT_BROWSER_INTERNAL_ID}`
    ];
  });

  mainWindow.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const normalizedMessage = normalizeText(message);
    if (!normalizedMessage) {
      return;
    }

    logProgress(`[renderer] ${normalizedMessage}`, {
      line: Number(line) || 0,
      sourceId: normalizeText(sourceId),
      type: "renderer_console"
    });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  if (String(process.env[OPEN_DEVTOOLS_ENV] || "").trim() === "1") {
    mainWindow.webContents.openDevTools({
      mode: "detach"
    });
  }

  return mainWindow;
}

ipcMain.on(PROGRESS_CHANNEL, (_event, payload = {}) => {
  const message = normalizeText(payload.message);
  const details = payload.details && typeof payload.details === "object"
    ? payload.details
    : null;

  if (!message) {
    return;
  }

  logProgress(message, details);
});

if (isParentIpcEnabled()) {
  process.on("message", async (payload = {}) => {
    if (String(payload?.type || "") !== "command") {
      return;
    }

    const requestId = normalizeText(payload?.requestId);
    const command = normalizeText(payload?.command);
    const args = Array.isArray(payload?.args) ? payload.args : [];

    try {
      const result = await handleParentCommand(command, args);
      sendParentMessage({
        ok: true,
        requestId,
        result,
        type: "command_result"
      });

      if (command === "quit") {
        setTimeout(() => {
          app.quit();
        }, 0);
      }
    } catch (error) {
      sendParentMessage({
        error: serializeError(error, `Standalone browser harness command "${command}" failed.`),
        ok: false,
        requestId,
        type: "command_result"
      });
    }
  });
}

async function start() {
  await app.whenReady();
  createWindow();

  app.on("activate", () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }

    mainWindow.show();
  });

  const scenario = normalizeText(process.env[SCENARIO_ENV]);
  if (!scenario) {
    if (isParentIpcEnabled()) {
      await new Promise((resolve) => {
        if (mainWindow.webContents.isLoadingMainFrame()) {
          mainWindow.webContents.once("did-finish-load", resolve);
          return;
        }

        resolve();
      });

      try {
        const probe = await waitForHarnessReady();
        sendParentMessage({
          probe,
          type: "ready"
        });
      } catch (error) {
        sendParentMessage({
          error: serializeError(error, "Standalone browser harness failed to become ready."),
          type: "ready"
        });
      }
    }
    return;
  }

  try {
    await new Promise((resolve) => {
      if (mainWindow.webContents.isLoadingMainFrame()) {
        mainWindow.webContents.once("did-finish-load", resolve);
        return;
      }

      resolve();
    });
    const result = await runScenarioByName(scenario);
    console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
    app.exit(0);
  } catch (error) {
    console.error(`${RESULT_PREFIX}${JSON.stringify({
      error: serializeError(error),
      success: false
    })}`);
    app.exit(1);
  }
}

app.on("window-all-closed", () => {
  app.quit();
});

start().catch((error) => {
  console.error(`${RESULT_PREFIX}${JSON.stringify({
    error: serializeError(error, "Standalone browser component harness startup failed."),
    success: false
  })}`);
  app.exit(1);
});
