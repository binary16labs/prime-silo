# Local zero-install test (Windows x64)

Build and run the **self-contained** desktop app locally — embeddable Python +
runtime deps + Neo4j + Java, all bundled and auto-started — to confirm the
"double-click → everything's already there" experience before we tag and deploy.

## Prerequisites

- **Node 20+** on PATH
- **Internet access** (the build downloads Python, Neo4j, and a JRE — a few hundred MB the first time)
- **`tar`** (built into Windows 10/11; it's in `C:\Windows\System32`)
- That's it — you do **not** need Python, Neo4j, Java, or Docker installed. The point is that the app brings its own.

## Build it (one command)

From the project root on the Ryzen (Windows x64):

```powershell
.\scripts\build-local-test.ps1
```

This installs dependencies, assembles the full runtime bundle, and produces an
**unpacked** app (no installer) at:

```
dist\desktop\windows\win-unpacked\Space Agent.exe
```

The build prints the component **SHA-256s** at the end — keep that output; we
pin those checksums before deploying.

> Already have deps installed? You can skip the wrapper and run
> `npm run desktop:localtest` directly.

## Verify it (the actual test)

For a true zero-install test, make sure **no** Python/Neo4j/Docker is running, then:

1. **Launch** `dist\desktop\windows\win-unpacked\Space Agent.exe`.
2. Right-click the **tray icon** → wait for the status line to reach
   **"Benny runtime: running (bundled)"** (Neo4j warms up over a few seconds).
3. In the app, open the **Bridge** and confirm with **no manual setup**:
   - **Documents** → drag a PDF/MD/TXT onto the drop zone → **Ingest → triples** → the knowledge graph populates.
   - **Code 3D** → the code graph renders (this proves the bundled Neo4j is live).
   - **Flows → Deep produce** → enter a goal → panels render and a run appears in **Runs** with the fan-out trace.
4. **Quit** from the tray, then check nothing is orphaned:
   ```powershell
   Get-Process java, python -ErrorAction SilentlyContinue
   ```
   (Should show nothing belonging to the app.)
5. **Relaunch** → it reuses `%APPDATA%\<app>\benny-home` (no re-init) and comes back up "running (bundled)".

## What "pass" looks like

- Tray reaches **running (bundled)** without you starting anything.
- Documents, Code 3D, and Deep produce all work on a clean machine.
- Clean shutdown (no leftover `java`/`python`), clean relaunch.

## Modes still available (sanity checks, optional)

- **Use your own Benny**: untick tray → **"Use bundled runtime"** (or set
  `RUNTIME_BASE_URL`) and the app uses an external/remote Benny instead.
- **Server/dev mode** is unchanged: `node space serve` and `node space supervise`.

## Report back

Tell me: the tray status reached, which of the three surfaces worked, the
printed SHA-256s, and any errors from **View → Toggle Developer Tools** or the
console. Then I'll pin the checksums and we tag + deploy.
