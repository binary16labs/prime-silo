#!/usr/bin/env node

// Build a LOCAL zero-install test of the desktop app: assemble the full runtime
// bundle (embeddable Python + deps + Neo4j + JRE) and produce an UNPACKED
// Windows app you can launch directly — no installer, no Docker, no manual
// `benny up`. This is the artifact to validate before tagging/deploying.
//
// Usage (from the project root, on Windows x64):
//   node packaging/scripts/build-local-test.js
// or the friendly wrapper that also installs deps:
//   ./scripts/build-local-test.ps1
//
// Output: dist/desktop/windows/win-unpacked/Prime-Silo.exe

const path = require("node:path");
const fs = require("node:fs");
const { runDesktopPackaging } = require("./desktop-builder");

const PROJECT_ROOT = path.resolve(__dirname, "../..");

function checklist(exePath) {
  return `
============================================================
  LOCAL ZERO-INSTALL TEST — what to verify
============================================================
1. Launch the app:
     "${exePath}"
   (No Python/Neo4j/Docker should be installed or running for a true test.)

2. Right-click the tray icon → the status line should reach:
     "Benny runtime: running (bundled)"
   (Neo4j takes a few seconds to warm up on first launch.)

3. In the app (browser window), open the Bridge and confirm — with NO manual setup:
   - Documents → drop a PDF/MD/TXT → "Ingest → triples" → graph populates.
   - Code 3D → the code graph renders (proves Neo4j is live).
   - Flows → Deep produce a goal → panels render + a run/trace appears in Runs.

4. Quit the app from the tray → confirm no leftover processes:
     PowerShell:  Get-Process java, python -ErrorAction SilentlyContinue
   (Should list nothing from this app.)

5. Relaunch → it should reuse %APPDATA%/<app>/benny-home (no re-init) and come
   up "running (bundled)" again.

If all pass, we pin the component checksums (printed above) and tag/deploy.
Report back: tray status, which surfaces worked, and any console errors
(View → Toggle Developer Tools).
============================================================
`;
}

async function main() {
  if (process.platform !== "win32") {
    console.warn(
      `This local test targets Windows x64 (Phase 1). Current platform: ${process.platform}. Continuing, but the bundle assembler only has Windows-x64 download URLs pinned.`
    );
  }
  // Force the full runtime-bundle assembly during this build.
  process.env.PRIME_SILO_BUNDLE_RUNTIME = "1";

  console.log("Building a local zero-install test (unpacked app with full runtime bundle)...");
  console.log(
    "This downloads ~hundreds of MB (Python + Neo4j + JRE) and runs pip — first run is slow.\n"
  );

  // --dir = unpacked app (fast, no installer); --x64 = the supported arch.
  await runDesktopPackaging("windows", ["--dir", "--x64"]);

  const exePath = path.join(
    PROJECT_ROOT,
    "dist",
    "desktop",
    "windows",
    "win-unpacked",
    "Prime-Silo.exe"
  );
  if (fs.existsSync(exePath)) {
    console.log(checklist(exePath));
  } else {
    console.warn(
      `\nBuild finished but the expected EXE was not found at:\n  ${exePath}\nCheck the build output above for the actual output directory.`
    );
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
