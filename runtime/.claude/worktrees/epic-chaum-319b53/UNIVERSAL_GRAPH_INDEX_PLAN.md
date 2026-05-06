# Epic: Universal Graph Index + OS-Native Navigation

> Author: Benny Studio team
> Status: DRAFT (proposed 2026-04-17)
> Successor to: `COGNITIVE_MESH_RESUME_PLAN.md`
> Target tab: Graph (Benny Studio v2)

---

## 1. Vision

Turn the Graph tab from a code-only mesh into a **universal, OS-native file explorer in 3D space**. Every file in the workspace — source code, docs, images, audio, video, archives, binaries — becomes a node. Click a node to expand its internals inline (children for folders, thumbnail for images, waveform for audio, keyframes for video, line preview for text). Click **Open** to launch the OS default app (File Explorer for folders, Notepad for text, default image viewer, etc.). Media nodes stream enrichment progress through the existing live-view SSE pipeline.

One-liner for PMs: *"Make the graph behave like File Explorer, but with a memory and a nervous system."*

---

## 2. Scope

### In scope
- Universal file-type indexing (code, docs, images, audio, video, archives, binaries).
- Per-type metadata extractors + thumbnail/preview generation.
- OS-native **Open** action (Windows / macOS / Linux).
- Click-to-expand inline: children bursts (folders), preview billboards (media), line preview (text).
- OS-style keyboard/mouse navigation (arrows, Enter, Space, Ctrl+O, right-click context menu).
- Live-view integration: SSE progress events as media files are being enriched.
- TDD + BDD test harness wired into CI.

### Out of scope (parked for v3)
- Content-based semantic search over media (CLIP embeddings for images, whisper transcripts for audio).
- Remote filesystem indexing (SMB/S3/GDrive) — only local workspace for this epic.
- Inline editing inside the graph (open-to-edit only launches OS app).
- Mobile/touch navigation.

---

## 3. Current State (grounded in code)

| Aspect | Location | Status |
|---|---|---|
| File walker + code AST | [benny/graph/code_analyzer.py:153](benny/graph/code_analyzer.py:153) | Handles `.py .js .jsx .ts .tsx`; docs `.md .pdf .txt`. Other files **silently skipped**. |
| Node types | [benny/graph/code_analyzer.py:79](benny/graph/code_analyzer.py:79) | `File / Folder / Class / Function / Interface / Documentation / Concept`. No media types. |
| Graph API | [benny/api/graph_routes.py](benny/api/graph_routes.py) | `GET /graph/code/lod`, `POST /graph/layout`. No file-open endpoint. |
| Live enrichment SSE | [benny/api/live_routes.py](benny/api/live_routes.py) | `POST /live/enrich` + `GET /live/enrich/events/{run_id}` work. Currently entity-oriented, not file-oriented. |
| 3D canvas | [frontend/src/components/Studio/CodeGraphCanvas.tsx:175](frontend/src/components/Studio/CodeGraphCanvas.tsx:175) | 7 geometries by type. No billboards, no thumbnails. |
| Node selection panel | [frontend/src/components/Studio/graph/AgenticPanel.tsx:31](frontend/src/components/Studio/graph/AgenticPanel.tsx:31) | Actions: `trace / prune / summon` stubs. No **Open**. |
| Keyboard nav | — | None. Only OrbitControls. |
| Test harness | — | None wired. Manual BDD checklist only (resume plan §5). |

---

## 4. Target Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (React 3F)                                             │
│                                                                  │
│  CodeGraphCanvas ─┬─ CodeSymbolNode (geometry by FileKind)       │
│                   ├─ NodePreviewBillboard  ◀── thumbnail URL     │
│                   ├─ NodeExpansionCluster  ◀── children nodes    │
│                   └─ KeyboardNavController (↑↓←→ Enter Space ^O) │
│                                                                  │
│  AgenticPanel ──── OpenButton + ContextMenu                      │
│                                                                  │
│  LiveIngestOverlay ◀── SSE: /live/ingest/events/{run_id}         │
└──────────────────────────────────────────────────────────────────┘
                            │  HTTP + SSE
                            ▼
┌──────────────────────────────────────────────────────────────────┐
│  Backend (FastAPI)                                               │
│                                                                  │
│  POST /fs/ingest           ◀── kicks off universal scan (SSE)    │
│  GET  /fs/thumbnail/{id}   ◀── serves generated preview          │
│  POST /fs/open             ◀── launches OS default app (safe)    │
│  GET  /fs/preview/{id}     ◀── text head / EXIF / ID3 / ffprobe  │
│                                                                  │
│  UniversalFileIndexer                                            │
│   ├─ FileKindDetector  (ext + magic-number fallback)             │
│   ├─ HandlerRegistry                                             │
│   │    ├─ CodeHandler    (existing tree-sitter)                  │
│   │    ├─ DocHandler     (existing md/pdf/txt)                   │
│   │    ├─ ImageHandler   (Pillow: EXIF, dims, thumb)             │
│   │    ├─ AudioHandler   (mutagen: ID3, duration, waveform png)  │
│   │    ├─ VideoHandler   (ffprobe: keyframe poster, duration)    │
│   │    ├─ ArchiveHandler (zipfile/tarfile: listing)              │
│   │    └─ BinaryHandler  (size, hash, mime)                      │
│   └─ OSLauncher          (os.startfile / open / xdg-open)        │
└──────────────────────────────────────────────────────────────────┘
```

**Key design decisions (all resolved 2026-04-17)**
- Handlers are registered via a `HandlerRegistry` protocol so new file types plug in without touching the core walker.
- **Thumbnail cache is per-workspace**, not per-user. Path: `workspace/{ws_id}/.graph_cache/previews/{sha1}.{ext}`. Rationale: media metadata belongs to the workspace, so when the workspace is shared/exported/backed-up the previews travel with it; no duplicate generation across users on the same machine. Multi-tenant isolation is already enforced at the workspace boundary.
- `POST /fs/open` is **path-guarded**: resolves to absolute, asserts it is inside the workspace root, denies symlink escapes, logs every invocation.
- **ffmpeg ships as a portable binary via `imageio-ffmpeg`** (~35 MB per platform, lazy-resolved). No system install required.
- **Video streams via HTTP Range requests** (fastest path); non-browser-playable containers are remuxed on the fly (`ffmpeg -c copy`, no re-encode).
- SSE events reuse the existing live-view pattern so the `LiveExecutionOverlay` wiring is a near-copy.

---

## 5. Workstream Breakdown

Six workstreams, each with concrete deliverables, acceptance criteria, and tests. Workstreams can ship independently behind a feature flag `VITE_GRAPH_UNIVERSAL=true`.

---

### WS1 — Universal File Indexer (backend)

**Goal:** Any file in the workspace produces a node. Metadata extracted per type.

#### Deliverables
- `benny/graph/file_kind.py` — `FileKind` enum + `detect_kind(path) -> FileKind` using extension map with `python-magic` fallback for unknown extensions.
- `benny/graph/handlers/__init__.py` — `FileHandler` protocol (`extract(path) -> dict`, `kind: FileKind`).
- `benny/graph/handlers/image.py` — Pillow-based; returns `{width, height, format, exif, thumb_path}`.
- `benny/graph/handlers/audio.py` — mutagen-based; returns `{duration_s, bitrate, sample_rate, title, artist, album, waveform_png_path}`.
- `benny/graph/handlers/video.py` — shells out to `ffprobe` via the bundled `imageio-ffmpeg` binary path; returns `{duration_s, width, height, codec, fps, poster_path, browser_playable: bool}` (flag set when codec/container is `h264+aac in mp4/webm` so the frontend can skip remux).
- `benny/graph/handlers/archive.py` — `zipfile`/`tarfile` listing (top 50 entries).
- `benny/graph/handlers/binary.py` — `{size_bytes, sha1, mime}`.
- `benny/graph/universal_indexer.py` — orchestrator: walks workspace, dispatches to handlers, writes nodes with new `type` values (`Image`, `Audio`, `Video`, `Archive`, `Binary`), links `CONTAINS` edges from folders.
- New node types added to `CodeNode.type` contract. `GRAPH_SCHEMA.md` updated.
- Dependencies added to `requirements.txt`: `Pillow`, `mutagen`, `python-magic-bin` (Windows) / `python-magic` (macOS/Linux), `ffmpeg-python`, and **`imageio-ffmpeg`** — the latter bundles a per-platform ffmpeg static binary (~35 MB extracted, resolved via `imageio_ffmpeg.get_ffmpeg_exe()`). No system ffmpeg install required.
- `benny/graph/handlers/_ffmpeg.py` — thin wrapper exposing `FFMPEG_EXE` and `FFPROBE_EXE` (derived from `get_ffmpeg_exe()`; ffprobe located alongside) so handlers never `shell=True`.
- **Decision (resolved 2026-04-17):** portable bundled binary via `imageio-ffmpeg`. Rejected: vendoring a raw `ffmpeg.exe` (~90 MB, harder to update per platform). Rejected: hard-requiring a system install (Windows DX hostile).

#### Acceptance criteria
1. Running `UniversalIndexer(ws).scan()` on a workspace containing `foo.png`, `bar.mp3`, `baz.mp4`, `pack.zip`, `thing.bin` returns 5 nodes with correct `type` fields.
2. Image node has `metadata.width`, `metadata.height`, `metadata.thumb_path` pointing to a file that exists on disk.
3. Audio node has `metadata.duration_s` as a positive float and `metadata.waveform_png_path` that exists.
4. Video node has `metadata.poster_path` (JPEG) of the first keyframe and `metadata.duration_s`.
5. A file missing its toolchain (e.g. no ffmpeg) degrades: node still created with `metadata.extractor_error` set; scan does not abort.
6. Ignore patterns from `.gitignore` and workspace manifest continue to work (regression: existing [code_analyzer.py:140](benny/graph/code_analyzer.py:140) behavior preserved).
7. Scan is **idempotent**: re-running on unchanged files produces identical node IDs and doesn't regenerate thumbnails (mtime+size check).

#### TDD tests (`tests/graph/test_universal_indexer.py`, pytest)
```python
def test_detect_kind_by_extension()
def test_detect_kind_falls_back_to_magic_for_unknown_ext()
def test_image_handler_extracts_dims_and_generates_thumbnail(tmp_path)
def test_audio_handler_extracts_id3_and_waveform(tmp_path)
def test_video_handler_probes_and_writes_poster(monkeypatch_ffprobe, tmp_path)
def test_archive_handler_lists_entries(tmp_path)
def test_binary_handler_hashes_and_mimes(tmp_path)
def test_universal_indexer_emits_all_node_types(sample_workspace)
def test_indexer_is_idempotent_on_unchanged_files(sample_workspace)
def test_indexer_degrades_when_ffmpeg_missing(monkeypatch_no_ffmpeg, sample_workspace)
def test_indexer_respects_gitignore(sample_workspace_with_gitignore)
```

---

### WS2 — FS API + OS-Native Open

**Goal:** Frontend can request ingestion, preview, and OS-default open.

#### Deliverables
- `benny/api/fs_routes.py`:
  - `POST /fs/ingest` — body `{workspace, sub_dir?}`; spawns background scan; returns `{run_id}`. SSE on `GET /fs/ingest/events/{run_id}`.
  - `GET /fs/thumbnail/{workspace}/{node_id}` — serves cached thumbnail image.
  - `GET /fs/preview/{workspace}/{node_id}` — returns JSON `{kind, metadata, head?}` (first 200 lines for text).
  - `POST /fs/open` — body `{workspace, node_id}`; resolves path, validates inside workspace, launches OS default.
  - `POST /fs/reveal` — same shape, calls `reveal_in_explorer` (selects the file in the OS file manager).
  - **`GET /fs/stream/{workspace}/{node_id}`** — streams media file bytes with full **HTTP `Range` request support** (`Accept-Ranges: bytes`, `Content-Range`, `206 Partial Content`). When the indexed node has `metadata.browser_playable=true`, serves raw bytes via `FileResponse` + Range. When false (e.g. HEVC, MKV), transparently pipes through `ffmpeg -c copy -f fmp4 -movflags frag_keyframe+empty_moov -` (container remux only, **no re-encode**) so playback starts instantly and CPU cost stays near zero. This is the most performant path: zero transcoding when possible, cheap remuxing when not. (Decision resolved 2026-04-17.)
- `benny/fs/os_launcher.py`:
  - `open_with_default(path: Path)` — `os.startfile(path)` on Windows, `subprocess.run(["open", path])` on macOS, `subprocess.run(["xdg-open", path])` on Linux.
  - `reveal_in_explorer(path: Path)` — `explorer /select,"path"` on Windows, `open -R path` on macOS, falls back to opening parent dir on Linux.
- `benny/fs/path_guard.py`:
  - `validate_inside_workspace(ws_root: Path, target: Path) -> Path` — resolves symlinks, asserts `target.resolve()` starts with `ws_root.resolve()`. Raises `PathOutsideWorkspaceError` otherwise.
- Audit log line written to `workspace/{ws}/logs/fs_open.jsonl` per open.

#### Acceptance criteria
1. `POST /fs/open` with a path inside the workspace returns `200` and the OS opens the default app for that extension (verified by CI matrix per platform — see §11).
2. `POST /fs/open` with `../../etc/passwd` (or equivalent escape attempt) returns `403` and writes no audit entry.
3. A symlink pointing outside the workspace is rejected.
4. Thumbnail endpoint returns 404 for non-existent nodes, 200 + correct MIME for existing ones, and sets `Cache-Control: public, max-age=86400`.
5. Ingest SSE emits events with types `scan_started`, `file_indexed`, `thumbnail_generated`, `scan_completed`, `scan_error`.
6. Scan can be cancelled: `DELETE /fs/ingest/{run_id}` stops the background task within 2 seconds.
7. `GET /fs/stream` honors `Range: bytes=N-M` headers — responds with `206 Partial Content`, correct `Content-Range`, and the exact byte slice requested. Seeking in the HTML5 `<video>` element produces Range requests handled within <50ms TTFB for a browser-playable file.
8. For a non-browser-playable file (e.g. `.mkv` with HEVC), `GET /fs/stream` still starts delivering playable fMP4 bytes within 500ms (remux only — ffmpeg CPU stays <15% of one core during playback).

#### TDD tests (`tests/api/test_fs_routes.py`)
```python
def test_post_fs_open_inside_workspace_launches_app(monkeypatch_launcher)
def test_post_fs_open_rejects_parent_traversal()
def test_post_fs_open_rejects_symlink_escape(tmp_path)
def test_post_fs_open_writes_audit_log()
def test_get_thumbnail_returns_image(seeded_cache)
def test_get_thumbnail_404_for_missing()
def test_ingest_sse_emits_expected_event_sequence(sample_workspace)
def test_ingest_cancel_stops_within_2s()
def test_path_guard_resolves_and_validates()
```

---

### WS3 — Node Expand-in-Place

**Goal:** Clicking a node **expands** its content in the graph without navigating away. Clicking again collapses.

#### Deliverables
- `frontend/src/components/Studio/graph/NodeExpansion.tsx`:
  - `<FolderExpansion>` — when expanded, renders the folder's children as a small satellite cluster around the parent, connected by short edges. Uses existing `CodeGraphEdge` style but thinner.
  - `<ImagePreviewBillboard>` — `<Html>` overlay showing thumbnail (from `/fs/thumbnail/...`) at fixed pixel size with EXIF caption.
  - `<AudioPreviewBillboard>` — waveform PNG + ID3 metadata, Play button (uses browser `<audio>`).
  - `<VideoPreviewBillboard>` — poster (from `/fs/thumbnail/...`) + duration badge. Click → swaps to an HTML5 `<video src="/fs/stream/{ws}/{node_id}" preload="metadata">` element. Browser handles Range requests automatically, so seek is instant for browser-playable files and near-instant for remuxed files (see WS2 AC7–8).
  - `<TextPreviewBillboard>` — first 20 lines monospaced.
  - `<ArchivePreviewBillboard>` — listing of entries.
- `frontend/src/hooks/slices/uiSlice.ts` gains `expandedNodeIds: Set<string>`, `selectedNodeId: string | null`, `toggleExpand(nodeId)`, `selectNode(nodeId)`.
- **Click model (resolved 2026-04-17 — supports both mental models):**
  - Click an **unselected** node → selects it (no expansion change).
  - Click the **already-selected** node → toggles expand/collapse (cycling behavior).
  - **Double-click** any node → always toggles expand/collapse immediately, regardless of selection state (power-user shortcut).
  - Click on empty space → clears selection; expansions remain.
  - A 250ms click-gate differentiates single vs double using `useRef` timer; the single-click handler is cancelled if a second click lands inside the window.
- Expansion uses GPU-friendly `InstancedMesh` for >20 children (prevents frame drops on large folders).

#### Acceptance criteria
1. Double-clicking a folder node renders its children as satellites within 200ms on a folder of ≤500 files.
2. Double-clicking again collapses them.
3. Single-clicking an unselected folder **selects** it and does **not** expand it.
4. Single-clicking an already-selected folder **toggles** expand/collapse (cycling).
5. Selection and expansion are independent: a node can be expanded without being selected (via double-click) and selected without being expanded (via first single-click).
6. Image node double-click shows thumbnail billboard within 150ms (cache hit) or streams it.
7. Audio node preview plays in-browser; pauses when node is collapsed.
8. Video node preview plays inline; stops when node is collapsed or another video opened.
9. Text node preview shows first 20 lines with syntax highlight for code.
10. Multiple nodes can be expanded simultaneously; expanded state persists across tier changes in the nexus controller.
11. Rapid triple-click does not produce an un-toggled state (click-gate invariant).

#### TDD tests (`frontend/src/components/Studio/graph/__tests__/NodeExpansion.test.tsx`, Vitest + React Testing Library)
```ts
describe('ClickModel', () => {
  it('first click on unselected node selects without expanding')
  it('second click on selected node toggles expand')
  it('third click on selected node toggles back to collapsed (cycling)')
  it('double-click on any node toggles expand regardless of selection')
  it('double-click does NOT fire the single-click select handler (250ms gate)')
  it('triple-click lands in a consistent final state (not indeterminate)')
  it('click on empty space clears selection but preserves expansions')
})
describe('FolderExpansion', () => {
  it('renders no satellites when collapsed')
  it('renders N satellites for folder with N children when expanded')
  it('unmounts satellites when collapsed again')
})
describe('ImagePreviewBillboard', () => {
  it('renders img with src=/fs/thumbnail/... when kind=Image')
  it('shows caption with dims and EXIF')
})
describe('AudioPreviewBillboard', () => {
  it('plays on Play click, pauses on unmount')
})
describe('VideoPreviewBillboard', () => {
  it('loads <video src=/fs/stream/...> on Play click')
  it('sends a Range request when user seeks')
  it('tears down <video> on unmount so ffmpeg remux process exits')
})
// ...etc.
```

---

### WS4 — Live Enrichment for Media

**Goal:** Media ingestion progress is visible on the graph in real time.

#### Deliverables
- `benny/fs/live_ingest.py` — wraps `UniversalIndexer.scan()` in a generator that yields SSE-compatible events.
- Event schema on `/fs/ingest/events/{run_id}`:
  - `{type: 'file_queued', node_id, path, kind}`
  - `{type: 'file_indexed', node_id, duration_ms, metadata}`
  - `{type: 'thumbnail_generated', node_id, thumbnail_url}`
  - `{type: 'scan_progress', indexed: N, total: M}`
  - `{type: 'scan_completed', run_id, total_nodes, total_edges}`
  - `{type: 'scan_error', node_id, error}`
- Frontend: `LiveIngestOverlay` (new, copy of `LiveExecutionOverlay`) subscribes on ingest and **pulses the corresponding node** as each `file_indexed` event lands. Reuses `SonificationEngine` to emit soft clicks on file indexed and a chime on scan completed.

#### Acceptance criteria
1. Firing ingest on a 1000-file workspace streams events at a rate ≥50 events/sec without dropping.
2. Each `file_indexed` event causes the corresponding node to pulse (opacity bump) within 100ms of receipt.
3. `scan_completed` emits exactly once even under connection drop+reconnect (idempotent on frontend).
4. Sonification volume respects existing `uiSlice.cognitiveMesh.sonificationEnabled` flag.

#### TDD tests
- Backend (`tests/fs/test_live_ingest.py`): event schema contract test; ordering test; error-path test.
- Frontend (`frontend/src/components/Studio/__tests__/LiveIngestOverlay.test.tsx`): mocks EventSource, asserts `pulse` is called with correct node ID.

---

### WS5 — OS-Style Navigation

**Goal:** The graph feels like File Explorer when driven from keyboard or right-click.

#### Deliverables
- `frontend/src/components/Studio/graph/KeyboardNavController.tsx`:
  - `↑/↓` — move selection to sibling (sorted by name).
  - `←` — collapse current or move to parent.
  - `→` — expand current or move to first child.
  - `Enter` — primary action (Open if file, expand if folder).
  - `Space` — quick preview (same as double-click expand).
  - `Ctrl+O` — OS-native Open.
  - `Ctrl+Shift+E` — Reveal in Explorer.
  - `Esc` — collapse all / clear selection.
  - `Tab` / `Shift+Tab` — cycle through expanded node previews.
- `frontend/src/components/Studio/graph/ContextMenu.tsx` — right-click produces menu with items: Open, Open With…, Reveal in Explorer, Copy Path, Expand/Collapse, Properties.
- `frontend/src/components/Studio/graph/Breadcrumb.tsx` — top-of-canvas breadcrumb showing `workspace > folder > subfolder > file.png`, each segment clickable to focus.
- `AgenticPanel` updated with **Open** button (calls `POST /fs/open`) and **Reveal** button (calls `POST /fs/reveal`).

#### Acceptance criteria
1. With no modal open, all keybindings above produce the expected effect.
2. Right-click on a node produces the context menu anchored at cursor; dismisses on outside click or Esc.
3. Breadcrumb updates within one frame of selection change.
4. Tabbing through previews follows document order (depth-first from the currently selected node).
5. When the AgenticPanel is hidden (toggle off), keyboard shortcuts still work.
6. Screen reader announces the selected node name + type (basic ARIA live region).

#### BDD scenarios (`tests/bdd/features/os_navigation.feature`, pytest-bdd + Playwright driver)
```gherkin
Feature: OS-style navigation in the Graph tab

  Background:
    Given a workspace with a folder "docs" containing "intro.md" and "images/logo.png"
    And the Graph tab is open with the cognitive mesh loaded

  Scenario: Arrow keys traverse the tree
    Given the "docs" folder is selected
    When I press the Right arrow key
    Then the "docs" folder is expanded
    And the first child "images" is selected
    When I press the Right arrow key
    Then "images" is expanded
    And "logo.png" is selected

  Scenario: Enter opens a file with the OS default app
    Given "intro.md" is selected
    When I press Enter
    Then the backend receives POST /fs/open with that path
    And an audit log line is written

  Scenario: Ctrl+Shift+E reveals the file in Explorer
    Given "logo.png" is selected
    When I press Ctrl+Shift+E
    Then the backend receives POST /fs/reveal with that path

  Scenario: Right-click opens context menu
    When I right-click on "intro.md"
    Then a context menu appears with items "Open", "Open With…", "Reveal in Explorer", "Copy Path"
    When I click "Copy Path"
    Then the clipboard contains the absolute path to "intro.md"

  Scenario: Escape collapses everything
    Given the "docs" folder is expanded
    When I press Escape
    Then the "docs" folder is collapsed
    And no node is selected
```

---

### WS6 — Test Harness Bootstrap

**Goal:** Install TDD + BDD scaffolding so the above tests can actually run. This must ship **first** to unblock the other workstreams.

#### Deliverables
- **Backend**:
  - Add `pytest`, `pytest-asyncio`, `pytest-bdd`, `httpx` (for FastAPI test client) to `requirements.txt` under a `[test]` extra in `pyproject.toml`.
  - `tests/conftest.py` — fixtures: `sample_workspace`, `seeded_cache`, `monkeypatch_launcher`, `monkeypatch_no_ffmpeg`.
  - `pytest.ini` — test paths, async mode, markers (`unit`, `integration`, `bdd`).
- **Frontend**:
  - Add `vitest`, `@testing-library/react`, `@testing-library/user-event`, `@playwright/test`, `jsdom` to `frontend/package.json` devDependencies.
  - `frontend/vitest.config.ts`, `frontend/playwright.config.ts`.
  - `frontend/src/setupTests.ts` — jest-dom setup.
  - Sample smoke test: `frontend/src/components/Studio/__tests__/CodeGraphCanvas.smoke.test.tsx`.
- **CI** (`.github/workflows/test.yml`):
  - **Job `backend`** — runs `pytest -m "unit or integration"` on `ubuntu-latest`. Coverage uploaded as artifact.
  - **Job `frontend`** — runs `vitest run` + `playwright test` on `ubuntu-latest`.
  - **Job `launcher-matrix`** — matrix `os: [ubuntu-latest, windows-latest, macos-latest]`, runs `pytest -m os_launcher` and `playwright test --grep @os-launcher`. Triggered on changes to `benny/fs/**`, `frontend/src/**/ContextMenu.tsx`, or `frontend/src/**/KeyboardNavController.tsx` (plus a nightly run). Owner: the WS2 engineer.
  - **Job `bdd`** — boots dev server + temp workspace, executes `pytest-bdd` feature files.
- Make target / npm script:
  - `npm run test` (frontend) / `pytest` (backend) / `npm run test:e2e` (Playwright) / `pytest -m os_launcher` (platform-specific).

#### Acceptance criteria
1. `pytest` discovers and passes at least one trivial test in `tests/graph/test_universal_indexer.py::test_detect_kind_by_extension`.
2. `npm --prefix frontend run test` passes a smoke test that renders `CodeGraphCanvas` with mocked data.
3. `npm --prefix frontend run test:e2e` launches Playwright, visits `/graph`, and asserts the canvas `<canvas>` element is present.
4. `launcher-matrix` job is green on all three OS runners on a clean branch.
5. CI wall time for the default PR path (backend + frontend + bdd) stays under 8 minutes; the launcher matrix adds ≤4 more minutes in parallel.
6. Coverage artifact is downloadable from the run page.

#### TDD tests (meta)
- Each fixture has its own test: fixture produces a workspace, cleans it up, and isolates state across tests.

---

## 6. Milestones

| # | Milestone | Workstreams | Exit criterion |
|---|---|---|---|
| M0 | **Harness bootstrap** | WS6 | CI green with sample tests. |
| M1 | **Universal indexer alpha** | WS1 (image+text+binary), WS2 (`/fs/open` + path guard) | Can index a workspace with images and binaries; Open button works for text on Windows. |
| M2 | **Media complete** | WS1 (audio+video+archive), WS4 (live SSE) | Audio/video nodes appear with live pulsing. |
| M3 | **Expand + preview** | WS3 | Double-click expands any node type in-place. |
| M4 | **OS navigation** | WS5 | All keybindings, context menu, breadcrumb live. BDD suite green. |
| M5 | **Hardening** | — | Performance: 10k-file workspace indexes in <60s, renders at ≥30fps. Security: pentest path-escape matrix. |

Each milestone shipped behind `VITE_GRAPH_UNIVERSAL=true` until M5 flips the default.

---

## 7. Acceptance Matrix (rollup)

| Capability | How we verify |
|---|---|
| All file types become nodes | WS1 AC1; pytest on sample workspace |
| Thumbnails render | WS2 AC4; Playwright visual check |
| OS default app launches | WS2 AC1; manual per-platform checklist |
| Path traversal blocked | WS2 AC2, AC3; dedicated security test file |
| Click-to-expand works | WS3 AC1–7; Vitest component tests |
| Live SSE pulses nodes | WS4 AC2; Playwright + fake-SSE driver |
| Keyboard nav matches spec | WS5 AC1; BDD feature file `os_navigation.feature` |
| Tests run in CI | WS6 AC4 |

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| ffmpeg binary adds ~35MB per platform to install | Accepted — `imageio-ffmpeg` is a widely-used pattern, lazy-downloaded on first use by the pip package, cached under site-packages. Worth it for zero-friction Windows DX. Fallback: graceful degrade if binary fails to resolve (node still created with `metadata.extractor_error`). |
| OS open-launching is platform-specific and brittle | Isolate behind `OSLauncher` with explicit per-platform code paths. CI matrix runs the suite on `ubuntu-latest`, `windows-latest`, `macos-latest` (see §11). |
| Path escape vulnerabilities | Dedicated `path_guard.py` module, fuzz-style tests for `..`, symlinks, UNC paths, case-insensitive Windows comparisons. |
| Thumbnail generation balloons disk | Cache size cap (default 500MB per workspace) + LRU eviction in `.graph_cache/previews/`. Per-workspace scope means a 10-workspace dev machine caps at 5GB — acceptable. |
| Large workspace kills frame rate | InstancedMesh for expansions (WS3). Tier 3 LoD continues to hide leaves. Virtualize children clusters >500. |
| SSE stream drops mid-ingest | Frontend reconnects and resumes from `run_id`; backend persists events to `live/runs/{run_id}.jsonl` for replay. |
| Video remux ffmpeg process leaks on client disconnect | `StreamingResponse` task cancellation kills the subprocess; add a 60s watchdog timer that SIGKILLs orphaned ffmpegs. Integration-tested by aborting `fetch` mid-stream and asserting process count returns to baseline. |
| Triple-click produces wrong expansion state | Click-gate invariant test (WS3 AC11) + debounce in `CodeSymbolNode`. |

---

## 9. Security Notes (for review)

- `POST /fs/open` must never execute arbitrary commands — only `os.startfile` / platform default, which defers to the OS registry. Node ID → path lookup goes through the already-indexed graph, not raw user input.
- Audit log: every open/reveal appends a JSONL line with `{timestamp, workspace, node_id, resolved_path, user_agent, ip?}`.
- Rate-limit `POST /fs/open` at 10/sec per workspace to prevent fork-bomb style abuse.
- Consider a workspace-level feature flag `allow_os_open: bool` in the manifest for shared / multi-user setups.

---

## 10. Definition of Done

The epic is **Done** when:

1. All six workstreams' acceptance criteria are ticked.
2. CI is green on `master` with the backend `pytest` suite and frontend `vitest` + `playwright` suites.
3. The BDD `os_navigation.feature` scenarios all pass against a real Playwright-driven browser.
4. `VITE_GRAPH_UNIVERSAL` defaults to `true` and the old code-only path is removed.
5. A manual cross-platform smoke on Windows / macOS / Linux confirms `Open` launches the expected default app.
6. `GRAPH_SCHEMA.md` and `README.md` reflect the new node types + OS-open endpoint.
7. Telemetry: first week in prod shows ≥95% ingest success rate and <1% `POST /fs/open` 4xx rate.

---

## 11. Decisions Log (resolved 2026-04-17)

| # | Decision | Chosen approach | Implication |
|---|---|---|---|
| 1 | **Click model** | **Both behaviors coexist.** First click on an unselected node = select. Click on already-selected node = toggle expand/collapse (cycling). Double-click anywhere = toggle expand/collapse immediately. | WS3 AC3–5 and AC11 pin this behavior. 250ms click-gate with `useRef` timer disambiguates single vs double. Gives both the OS-File-Explorer model and a power-user cycling model. |
| 2 | **Thumbnail cache scope** | **Per-workspace** at `workspace/{ws_id}/.graph_cache/previews/`. | Cache travels with workspace exports/backups. Multi-user machines hit workspace-boundary isolation automatically. 500MB/workspace LRU cap. |
| 3 | **ffmpeg distribution** | **Portable binary via `imageio-ffmpeg`** (~35 MB per platform, lazy-downloaded by pip package on first resolve). | Zero DX friction on Windows. No system install step in README. Binary lives under site-packages, cached across workspaces. |
| 4 | **Video inline playback** | **Most performant two-path strategy.** Default: `FileResponse` with full HTTP Range support (zero CPU). Fallback: on-the-fly container remux via `ffmpeg -c copy -f fmp4` for HEVC/MKV (no re-encode, <15% of one core). Transcoding a proxy is rejected as slower and heavier. | WS2 deliverable `/fs/stream` + AC7–8. Seeks hit the browser's native Range mechanism. |
| 5 | **OSLauncher test matrix ownership** | **Automated via GitHub Actions matrix** across `ubuntu-latest`, `windows-latest`, `macos-latest`. No dedicated QA owner required. Primary engineering owner: the WS2 engineer (the author of `benny/fs/os_launcher.py`). Tests run in CI on every PR that touches `benny/fs/**` or `frontend/src/**/ContextMenu.tsx`. Manual smoke per platform is a **Definition of Done** gate (§10 #5), not a per-PR blocker. | Adds ~4min to CI wall time (three parallel runners). WS6 CI job gains a `launcher-matrix` lane. No staffing request needed. |

---

## 12. Follow-up Decisions (defer to M3+)

- Whether to expose the click-model toggle as a user preference (could default to the hybrid described above and add `uiSlice.cognitiveMesh.clickMode: 'hybrid' | 'double-only' | 'cycle-only'` if users push back).
- Whether to upgrade `/fs/stream` to HLS segment delivery if real-world logs show seek latency problems on very large videos (>10GB).
- Whether per-workspace thumbnail caches should be shareable via a `sync_cache: true` manifest flag for team workspaces.

---

*End of plan. Edit in place as decisions are made; track workstream progress in `MEMORY.md` or an issue tracker.*
