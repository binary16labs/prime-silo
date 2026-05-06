#!/usr/bin/env node

const { spawn } = require("node:child_process");
const { PROJECT_ROOT, loadPackagingDependency } = require("./tooling");

async function main() {
  const electronBinary = loadPackagingDependency("electron");
  const child = spawn(electronBinary, [PROJECT_ROOT, ...process.argv.slice(2)], {
    cwd: PROJECT_ROOT,
    stdio: "inherit"
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }

    process.exitCode = code || 0;
  });

  child.on("error", (error) => {
    throw error;
  });
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
