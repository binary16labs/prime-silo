---
name: devops-pipeline
description: Build, test-package, and release the Prime-Silo desktop app (Space Agent). Use when asked to build the app, make a local/test build, package for Windows/macOS/Linux, cut a release, bump the version, or debug the release CI. Covers the Open-Studio companion services (opencode + open-notebook) bundling.
---

# Prime-Silo DevOps pipeline

Prime-Silo packages as an Electron desktop app ("Space Agent") via **electron-builder**.
Two product layers ship together: the Space-Agent shell (Node server + browser UI, run
in-process) and the **Benny runtime** (Python + Neo4j + JRE) which is either bundled
(zero-install) or driven from an external `$BENNY_HOME`.

All commands run from the repo root: `C:\Users\nsdha\OneDrive\binary16\prime-silo`.

## 0. One-time: install packaging deps

electron + electron-builder live under `packaging/`. If `packaging/node_modules` is
missing, run first:

```
npm run install:packaging
```

## 1. Build types (pick the lightest that proves what you need)

| Goal                                                      | Command                                       | Output                                              | Notes                                                                                                                                          |
| --------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast shell-only test (validates main/tray/pet/UI changes) | `npm run desktop:pack`                        | `dist/desktop/windows/win-unpacked/Space Agent.exe` | **No** runtime bundle. Quick. Best for verifying desktop/main-process changes.                                                                 |
| Zero-install local test (full runtime)                    | `npm run desktop:localtest`                   | same path, with bundled Python+Neo4j+JRE            | Sets `PRIME_SILO_BUNDLE_RUNTIME=1`; **downloads hundreds of MB + runs pip** — slow first run. This is the artifact to validate before tagging. |
| Windows installer                                         | `npm run package:desktop:windows`             | NSIS installer in `dist/`                           | Full build.                                                                                                                                    |
| All Windows arches                                        | `npm run package:desktop:windows:all`         | x64 + arm64                                         |                                                                                                                                                |
| macOS / Linux                                             | `npm run package:desktop:{macos,linux}[:all]` | dmg+zip / AppImage                                  | Run on the target OS.                                                                                                                          |

Build internals: scripts under `packaging/scripts/` (`host-package.js`,
`build-local-test.js` → `desktop-builder.js`). `build.files` in `package.json` controls
what ships — `packaging/desktop/**/*` is globbed, so new files there (e.g. `pet.js`,
`openstudio_services.js`) bundle automatically. `app/L1` and `app/L2` are excluded.

### Verify a build

```
ls "dist/desktop/windows/win-unpacked/Space Agent.exe"
# asar is disabled, so app files are browsable for spot-checks:
ls "dist/desktop/windows/win-unpacked/resources/app/packaging/desktop/"
```

For a zero-install build, follow the on-screen checklist `build-local-test.js` prints:
launch the exe → tray reaches **"Benny runtime: running (bundled)"** → in the Bridge,
Documents ingest + Code 3D graph + Flows deep-produce all work with no manual setup →
quit from tray → confirm no leftover `java`/`python` processes → relaunch reuses
`%APPDATA%/<app>/benny-home`.

## 2. Release (tagged, all platforms via CI)

```
# 1. make sure everything is committed to main
git status
# 2. bump version (writes package.json, creates the vX.Y.Z tag/commit)
node scripts/manage-release.js [patch|minor|major]
# 3. push main FIRST, then the tag
git push origin main
git push origin vX.Y.Z
# 4. CI builds all 6 platforms and publishes the GitHub release (~30 min)
```

**CRITICAL ordering lesson:** always push `main` **before** the tag. If the tag arrives
first, the build jobs are skipped and the release ships empty. (This has bitten releases
before.)

CI workflows in `.github/workflows/`:

- `release-desktop.yml` — builds Windows/macOS/Linux × x64/arm64 on tag push, publishes.
- `snapshot-build.yml` — auto-build on every commit (smoke).

### Release gates (run before tagging)

```
pytest tests/release -q            # 6σ acceptance gates
pytest tests/portability -q        # SR-1: no absolute paths in manifests/config
```

Past failure mode: a release that shipped a broken NSIS build (no x64 installer / bad
arm64). Prefer a **slim bundle + build guard**; do a `desktop:localtest` and actually
launch the exe before tagging.

## 3. Open-Studio companion services (Phase 5)

The desktop tray can drive the two OSS tools folded in by Open-Studio (see
`OPEN-STUDIO.md`). Logic in `packaging/desktop/openstudio_services.js`, wired into
`tray.js`:

- **opencode** — "Start/Stop opencode server" (`opencode serve`), shown only when the
  `opencode` CLI is on PATH.
- **open-notebook** — "Start/Stop open-notebook (docker)" + "Open Notebook UI"
  (`http://localhost:8502`), shown only when `docker` is on PATH. Drives
  `docker compose -f <file> up -d/down`.
- **Per-install secret:** `ensureEncryptionKey()` generates a random
  `OPEN_NOTEBOOK_ENCRYPTION_KEY` once and persists it in the desktop config, exporting it
  into the compose child env — replacing the hardcoded `=benny` from the sample compose.
- `stopAllOpenStudioServices()` is called from `prepareDesktopForQuit()` (stops opencode
  serve; leaves the docker stack, which may be shared).

To bundle these tools into the installer itself (future), extend
`packaging/runtime-bundle/` + `packaging/desktop/runtime_supervisor.js` the same way the
Benny runtime is bundled.

## Quick reference

```
npm run install:packaging          # one-time: electron/electron-builder
npm run desktop:pack               # fast unpacked test build (shell only)
npm run desktop:localtest          # zero-install full-runtime test build
npm run package:desktop:windows    # Windows installer
node scripts/manage-release.js patch && git push origin main && git push origin vX.Y.Z
pytest tests/release -q            # release gates
```

Related docs: `DEVOPS.md` (release narrative), `QUICKSTART-EXE.md` (operator setup),
`OPEN-STUDIO.md` (the integration this pipeline ships).
