#!/usr/bin/env node

const { runDesktopPackaging } = require("./desktop-builder");

const HOST_PLATFORM_MAP = {
  darwin: "macos",
  linux: "linux",
  win32: "windows"
};

async function main() {
  const platformKey = HOST_PLATFORM_MAP[process.platform];
  if (!platformKey) {
    throw new Error(`No desktop packaging host script is configured for platform ${process.platform}.`);
  }

  await runDesktopPackaging(platformKey);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
