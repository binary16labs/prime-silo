import path from "node:path";
import readline from "node:readline";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { inspect } from "node:util";

const require = createRequire(import.meta.url);
const {
  PROJECT_ROOT,
  loadPackagingDependency
} = require("../packaging/scripts/tooling.js");

const HARNESS_ENTRY_PATH = path.join(PROJECT_ROOT, "tests", "browser_component_harness", "main.cjs");
const PARENT_IPC_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_PARENT_IPC";
const OPEN_DEVTOOLS_ENV = "SPACE_BROWSER_COMPONENT_HARNESS_OPEN_DEVTOOLS";
const IPC_TIMEOUT_MS = 10_000;

function createRequestId() {
  return typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `browser-component-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function printHelp() {
  process.stdout.write([
    "Browser Component Harness CLI",
    "",
    "Commands:",
    "  help",
    "  log",
    "  probe",
    "  open <url>",
    "  navigate <url>",
    "  state",
    "  dom [selectorsJson]",
    "  content [selectorsJson]",
    "  detail <ref>",
    "  click <ref>",
    "  type <ref> <text>",
    "  type-submit <ref> <text>",
    "  submit <ref>",
    "  scroll <ref>",
    "  back",
    "  forward",
    "  reload",
    "  raw <command> [jsonArrayArgs]",
    "  quit",
    ""
  ].join("\n"));
}

async function commandExists(command) {
  return await new Promise((resolve) => {
    execFile("bash", ["-lc", `command -v ${command} || true`], (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }

      resolve(String(stdout || "").trim());
    });
  });
}

async function startVirtualDisplay() {
  const existingDisplay = String(process.env.DISPLAY || "").trim();
  if (existingDisplay) {
    return {
      display: existingDisplay,
      process: null
    };
  }

  const displayBinary = await commandExists("Xvfb");
  if (!displayBinary) {
    throw new Error("No DISPLAY is set and Xvfb is not installed.");
  }

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const displayNumber = 90 + Math.floor(Math.random() * 400);
    const display = `:${displayNumber}`;
    const xvfb = spawn(displayBinary, [
      display,
      "-screen",
      "0",
      "1440x900x24",
      "-nolisten",
      "tcp"
    ], {
      stdio: "ignore"
    });

    await delay(1000);

    if (xvfb.exitCode == null) {
      return {
        display,
        process: xvfb
      };
    }
  }

  throw new Error("Xvfb exited before the browser component harness CLI could start.");
}

async function stopVirtualDisplay(display) {
  const xvfb = display?.process;
  if (!xvfb || xvfb.killed) {
    return;
  }

  xvfb.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => {
      xvfb.once("exit", resolve);
    }),
    delay(5000)
  ]);
}

function parseInteger(value, label) {
  const parsed = Number.parseInt(String(value || "").trim(), 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`${label} must be an integer.`);
  }

  return parsed;
}

function parseJsonIfPresent(text) {
  const normalizedText = String(text || "").trim();
  if (!normalizedText) {
    return null;
  }

  return JSON.parse(normalizedText);
}

function parseCommand(line) {
  const trimmedLine = String(line || "").trim();
  if (!trimmedLine) {
    return null;
  }

  const [command, ...restTokens] = trimmedLine.split(/\s+/u);
  const restText = trimmedLine.slice(command.length).trim();
  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand === "help") {
    return {
      kind: "help"
    };
  }

  if (normalizedCommand === "log") {
    return {
      kind: "log"
    };
  }

  if (normalizedCommand === "quit" || normalizedCommand === "exit") {
    return {
      kind: "quit"
    };
  }

  if (normalizedCommand === "probe") {
    return {
      args: [],
      command: "probe",
      kind: "request"
    };
  }

  if (normalizedCommand === "open" || normalizedCommand === "navigate") {
    if (!restText) {
      throw new Error(`${normalizedCommand} requires a URL.`);
    }

    return {
      args: [restText],
      command: normalizedCommand,
      kind: "request"
    };
  }

  if (normalizedCommand === "state" || normalizedCommand === "back" || normalizedCommand === "forward" || normalizedCommand === "reload") {
    return {
      args: [],
      command: normalizedCommand,
      kind: "request"
    };
  }

  if (normalizedCommand === "dom" || normalizedCommand === "content") {
    return {
      args: restText ? [parseJsonIfPresent(restText)] : [],
      command: normalizedCommand,
      kind: "request"
    };
  }

  if (normalizedCommand === "detail" || normalizedCommand === "click" || normalizedCommand === "submit" || normalizedCommand === "scroll") {
    return {
      args: [parseInteger(restTokens[0], normalizedCommand)],
      command: normalizedCommand,
      kind: "request"
    };
  }

  if (normalizedCommand === "type" || normalizedCommand === "type-submit") {
    const referenceId = parseInteger(restTokens[0], normalizedCommand);
    const value = trimmedLine
      .slice(command.length)
      .trim()
      .slice(String(restTokens[0] || "").length)
      .trim();
    if (!value) {
      throw new Error(`${normalizedCommand} requires text after the reference id.`);
    }

    return {
      args: [referenceId, value],
      command: normalizedCommand === "type-submit" ? "typeSubmit" : "type",
      kind: "request"
    };
  }

  if (normalizedCommand === "raw") {
    const [rawCommand = "", ...rawArgTokens] = restTokens;
    if (!rawCommand) {
      throw new Error("raw requires a command name.");
    }

    const rawArgsText = restText.slice(rawCommand.length).trim();
    const rawArgs = rawArgsText ? parseJsonIfPresent(rawArgsText) : [];
    if (!Array.isArray(rawArgs)) {
      throw new Error("raw arguments must be a JSON array.");
    }

    return {
      args: rawArgs,
      command: rawCommand,
      kind: "request"
    };
  }

  throw new Error(`Unknown command "${command}".`);
}

function spawnHarness(display, { openDevTools = false } = {}) {
  const electronBinary = loadPackagingDependency("electron");
  const child = spawn(electronBinary, [
    "--no-sandbox",
    "--disable-gpu",
    HARNESS_ENTRY_PATH
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DISPLAY: display.display,
      [OPEN_DEVTOOLS_ENV]: openDevTools ? "1" : "",
      [PARENT_IPC_ENV]: "1"
    },
    stdio: ["inherit", "pipe", "pipe", "ipc"]
  });

  return child;
}

function createHarnessLogStore() {
  return {
    progressEntries: [],
    rawEntries: []
  };
}

function appendRawLogEntries(logStore, source, chunk) {
  const text = String(chunk || "");
  if (!text) {
    return;
  }

  for (const line of text.split(/\r?\n/u)) {
    const normalizedLine = line.trimEnd();
    if (!normalizedLine) {
      continue;
    }

    logStore.rawEntries.push({
      line: normalizedLine,
      source
    });
  }
}

function attachHarnessLogCapture(child, logStore) {
  child.stdout?.on("data", (chunk) => {
    appendRawLogEntries(logStore, "stdout", chunk);
  });
  child.stderr?.on("data", (chunk) => {
    appendRawLogEntries(logStore, "stderr", chunk);
  });

  child.on("message", (payload = {}) => {
    if (String(payload?.type || "") !== "progress") {
      return;
    }

    logStore.progressEntries.push({
      details: payload?.details && typeof payload.details === "object" ? payload.details : null,
      message: String(payload?.message || "").trim()
    });
  });
}

function formatHarnessLogEntry(entry = {}) {
  const message = String(entry.message || "").trim();
  if (!message) {
    return "";
  }

  if (!entry.details || typeof entry.details !== "object" || Object.keys(entry.details).length === 0) {
    return message;
  }

  return `${message}\n${inspect(entry.details, {
    breakLength: 120,
    colors: false,
    compact: false,
    depth: 8
  })}`;
}

function printBufferedLogs(logStore) {
  const progressOutput = logStore.progressEntries
    .filter((entry) => !String(entry?.message || "").trim().startsWith("[renderer] "))
    .map(formatHarnessLogEntry)
    .filter(Boolean)
    .join("\n\n");

  if (progressOutput) {
    process.stdout.write(`${progressOutput}\n`);
    return;
  }

  const rawOutput = logStore.rawEntries
    .map((entry) => `[${entry.source}] ${entry.line}`)
    .join("\n");

  if (rawOutput) {
    process.stdout.write(`${rawOutput}\n`);
    return;
  }

  process.stdout.write("(no buffered logs)\n");
}

function printCommandResult(command, result) {
  if (
    command === "content"
    && result
    && typeof result === "object"
    && typeof result.document === "string"
    && Object.keys(result).length === 1
  ) {
    process.stdout.write(`${result.document}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function stopHarness(child, {
  forceAfterMs = 5000
} = {}) {
  if (!child || child.exitCode != null || child.killed) {
    return;
  }

  const exitPromise = new Promise((resolve) => {
    child.once("exit", resolve);
  });

  try {
    if (child.connected) {
      child.send({
        args: [],
        command: "quit",
        requestId: createRequestId(),
        type: "command"
      });
    }
  } catch {
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      delay(forceAfterMs)
    ]);
    if (child.exitCode == null && !child.killed) {
      child.kill("SIGKILL");
      await Promise.race([
        exitPromise,
        delay(5000)
      ]);
    }
    return;
  }

  await Promise.race([
    exitPromise,
    delay(forceAfterMs)
  ]);

  if (child.exitCode == null && !child.killed) {
    child.kill("SIGTERM");
    await Promise.race([
      exitPromise,
      delay(5000)
    ]);
  }

  if (child.exitCode == null && !child.killed) {
    child.kill("SIGKILL");
    await Promise.race([
      exitPromise,
      delay(5000)
    ]);
  }
}

async function waitForReady(child) {
  return await new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      cleanup();
      reject(new Error(`Harness did not become ready within ${IPC_TIMEOUT_MS}ms.`));
    }, IPC_TIMEOUT_MS);

    const handleMessage = (payload = {}) => {
      if (String(payload?.type || "") !== "ready") {
        return;
      }

      cleanup();
      if (payload?.error) {
        reject(new Error(String(payload.error.message || "Harness failed to become ready.")));
        return;
      }

      resolve(payload?.probe ?? null);
    };

    const handleExit = (code) => {
      cleanup();
      reject(new Error(`Harness exited before becoming ready (code ${code ?? 0}).`));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      child.off("message", handleMessage);
      child.off("exit", handleExit);
    };

    child.on("message", handleMessage);
    child.on("exit", handleExit);
  });
}

async function sendCommand(child, command, args = []) {
  const requestId = createRequestId();

  return await new Promise((resolve, reject) => {
    let settled = false;
    const timer = globalThis.setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(new Error(`Harness command "${command}" timed out after ${IPC_TIMEOUT_MS}ms.`));
    }, IPC_TIMEOUT_MS);

    const handleMessage = (payload = {}) => {
      if (String(payload?.type || "") !== "command_result" || String(payload?.requestId || "") !== requestId) {
        return;
      }

      settled = true;
      cleanup();
      if (payload?.ok === false) {
        reject(new Error(String(payload?.error?.message || `Harness command "${command}" failed.`)));
        return;
      }

      resolve(payload?.result ?? null);
    };

    const handleExit = (code) => {
      settled = true;
      cleanup();
      reject(new Error(`Harness exited while waiting for "${command}" (code ${code ?? 0}).`));
    };

    const handleError = (error) => {
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error || `Harness command "${command}" failed.`)));
    };

    const cleanup = () => {
      globalThis.clearTimeout(timer);
      child.off("message", handleMessage);
      child.off("exit", handleExit);
      child.off("error", handleError);
    };

    child.on("message", handleMessage);
    child.on("exit", handleExit);
    child.on("error", handleError);

    if (!child.connected) {
      cleanup();
      reject(new Error(`Harness IPC channel is closed before "${command}" could be sent.`));
      return;
    }

    child.send({
      args,
      command,
      requestId,
      type: "command"
    }, (error) => {
      if (!error || settled) {
        return;
      }

      settled = true;
      cleanup();
      reject(error);
    });
  });
}

async function runCli() {
  const openDevTools = process.argv.includes("--devtools");
  const positionalArgs = process.argv.slice(2).filter((value) => value !== "--devtools");
  const display = await startVirtualDisplay();
  const child = spawnHarness(display, {
    openDevTools
  });
  const logStore = createHarnessLogStore();
  attachHarnessLogCapture(child, logStore);

  try {
    const probe = await waitForReady(child);

    if (positionalArgs.length > 0) {
      const parsedCommand = parseCommand(positionalArgs.join(" "));
      if (parsedCommand?.kind === "help") {
        printHelp();
      } else if (parsedCommand?.kind === "log") {
        printBufferedLogs(logStore);
      } else if (parsedCommand?.kind === "quit") {
        return;
      } else if (parsedCommand?.kind === "request") {
        const result = await sendCommand(child, parsedCommand.command, parsedCommand.args);
        printCommandResult(parsedCommand.command, result);
      }
      return;
    }

    process.stdout.write(`Harness ready at ${String(probe?.state?.currentUrl || "about:blank")}.\n`);
    printHelp();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "browser> "
    });
    let commandQueue = Promise.resolve();
    let closed = false;
    const interactiveClosed = new Promise((resolve) => {
      rl.once("close", resolve);
      child.once("exit", resolve);
    });

    rl.prompt();

    rl.on("line", (line) => {
      commandQueue = commandQueue.then(async () => {
        try {
          const parsedCommand = parseCommand(line);
          if (!parsedCommand) {
            return;
          }

          if (parsedCommand.kind === "help") {
            printHelp();
            return;
          }

          if (parsedCommand.kind === "log") {
            printBufferedLogs(logStore);
            return;
          }

          if (parsedCommand.kind === "quit") {
            closed = true;
            rl.close();
            return;
          }

          const result = await sendCommand(child, parsedCommand.command, parsedCommand.args);
          printCommandResult(parsedCommand.command, result);
        } catch (error) {
          process.stderr.write(`${String(error?.message || error)}\n`);
        } finally {
          if (!closed) {
            rl.prompt();
          }
        }
      });
    });

    rl.on("close", () => {
      closed = true;
    });

    await interactiveClosed;
    await commandQueue;
    await stopHarness(child);
  } finally {
    await stopHarness(child);
    await stopVirtualDisplay(display);
  }
}

runCli().catch((error) => {
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exitCode = 1;
});
