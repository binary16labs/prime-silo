#!/usr/bin/env node

const { runDesktopPackaging } = require("./desktop-builder");

runDesktopPackaging("macos").catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
