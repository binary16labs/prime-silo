#!/usr/bin/env node

const { runDesktopPackaging } = require("./desktop-builder");

runDesktopPackaging("windows").catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
