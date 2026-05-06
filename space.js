#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const COMMANDS_DIR = path.join(__dirname, "commands");
const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const COMMAND_ALIASES = new Map([
  ["--help", "help"],
  ["--version", "version"]
]);

function normalizeCommandName(rawValue) {
  const normalizedValue = String(rawValue || "help").trim().toLowerCase();
  return COMMAND_ALIASES.get(normalizedValue) || normalizedValue;
}

function createCommandError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function listCommandNames() {
  const entries = await fs.readdir(COMMANDS_DIR, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name.replace(/\.js$/, ""))
    .sort((left, right) => left.localeCompare(right));
}

async function loadCommandModule(commandName) {
  const normalizedName = normalizeCommandName(commandName);
  if (!COMMAND_NAME_PATTERN.test(normalizedName)) {
    throw createCommandError(`Invalid command name: ${commandName}`, "ERR_INVALID_COMMAND_NAME");
  }

  const filePath = path.join(COMMANDS_DIR, `${normalizedName}.js`);

  try {
    await fs.access(filePath);
  } catch (error) {
    throw createCommandError(`Unknown command: ${normalizedName}`, "ERR_COMMAND_NOT_FOUND");
  }

  return import(pathToFileURL(filePath).href);
}

async function run() {
  const originalEnv = { ...process.env };
  const { loadProjectEnvFiles } = await import(
    pathToFileURL(path.join(__dirname, "server", "lib", "utils", "env_files.js")).href
  );

  loadProjectEnvFiles(__dirname);

  const argv = process.argv.slice(2);
  const commandName = normalizeCommandName(argv[0]);
  const args = argv.slice(1);

  try {
    const commandModule = await loadCommandModule(commandName);

    if (typeof commandModule.execute !== "function") {
      throw createCommandError(
        `Command module "${commandName}" does not export execute().`,
        "ERR_INVALID_COMMAND_MODULE"
      );
    }

    const result = await commandModule.execute({
      args,
      commandName,
      commandsDir: COMMANDS_DIR,
      listCommandNames,
      loadCommandModule,
      originalEnv,
      projectRoot: __dirname
    });

    if (typeof result === "number") {
      process.exitCode = result;
    }
  } catch (error) {
    if (error.code === "ERR_COMMAND_NOT_FOUND") {
      console.error(error.message);
      console.error('Run "node space help" for available commands.');
      process.exitCode = 1;
      return;
    }

    console.error(error.message || error);
    process.exitCode = 1;
  }
}

run();
