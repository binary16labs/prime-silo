# PBR-001 — Continuation Plan (Phases 4–8)

**Audience:** a future agent (possibly a lesser model) picking up after
the Phase 3 commit. This document is **self-contained**: you do not need
to re-read the session transcript to execute it. Read, follow, commit.

**Status as of this handoff (last commit on `master`):**

| Phase | Title                                    | Status      |
|-------|------------------------------------------|-------------|
| 0     | Safety nets (SR-1 ratchet, baseline=408) | ✅ shipped  |
| 1a    | Portable layout (`D:/optimus`)           | ✅ shipped  |
| 1b    | Service lifecycle (up/down/status)       | ✅ shipped  |
| 2     | Manifest schema + SSE transport          | ✅ shipped  |
| 3     | LLM router (override/local_only/offline) | ✅ shipped  |
| 4     | MCP server + thin SDK                    | ✅ shipped  |
| 5     | Local-LLM executor capabilities          | ✅ shipped  |
| 6     | Observability + `benny doctor`           | ✅ shipped  |
| 7     | 6σ release gates                         | ✅ shipped  |
| 8     | `benny migrate` / legacy import          | ✅ shipped  |

**Ground rules — do not deviate without asking the user:**

1. **TDD.** For every new module, write failing tests first, then
   implement, then re-run the full suite (`tests/api tests/core
   tests/portability tests/safety`). Do not commit until green.
2. **Commit to `master` in the top-level checkout**, not the worktree:
   `C:\Users\nsdha\OneDrive\code\benny`. Do not rebase, do not amend.
3. **Python:** `C:/Users/nsdha/miniconda3/python.exe`.
4. **No absolute host paths in artifacts.** The SR-1 scanner
   (`tests/safety/test_sr1_no_absolute_paths.py`) ratchets — never
   raise the baseline without user approval.
5. **Stdlib first.** Phase 1b deliberately chose `ctypes` over `psutil`.
   Do not add dependencies unless the scope of the phase explicitly
   authorises it (Phase 4 needs `mcp`, Phase 5 may need `llama-cpp`
   via optional extras only).
6. **Offline-safe tests.** Mock `httpx.AsyncClient`, `litellm.completion`,
   and any subprocess/port access. CI has no network.
7. **Preserve the Phase 3 contracts.**
   * `executor_override` wins over roles and defaults.
   * `local_only=True` refuses cloud models at resolution time.
   * `BENNY_OFFLINE=1` refuses cloud models **before** network I/O, via
     `OfflineRefusal`.
   * `_run_completion` is the test seam; new backends plug in here.

---

## Phase 4 — MCP server + thin SDK

**Goal:** expose Benny's workflow surface to Claude via Model Context
Protocol, and ship a tiny Python SDK that wraps `/api/workflows/*` for
scripts and notebooks.

### 4.1 Deliverables

1. **`benny/mcp/server.py`** — an MCP server that surfaces tools:
   * `plan_workflow(requirement: str, workspace: str) -> Manifest`
     (proxies POST `/api/workflows/plan`)
   * `run_workflow(manifest_id: str) -> {run_id}` (proxies POST
     `/api/workflows/run`; accepts a full manifest JSON blob or an id
     resolvable from `workflows/` on disk)
   * `stream_events(run_id: str) -> AsyncIterator[Event]` (proxies
     GET `/api/runs/{id}/events` via `httpx` streaming)
   * `get_run(run_id: str) -> RunRecord` (proxies
     `/api/runs/{id}/record`)
2. **`benny/sdk/__init__.py`** — synchronous convenience wrappers:
   ```python
   from benny.sdk import BennyClient
   client = BennyClient(base_url="http://127.0.0.1:8005")
   manifest = client.plan("refactor the auth module", workspace="default")
   run = client.run(manifest)
   for event in client.stream(run.run_id):
       print(event)
   ```
3. **`bin/benny-mcp[.bat]`** launcher (matches Phase 1b style) that
   runs `python -m benny.mcp.server --stdio`.
4. **`benny_cli.py` — `mcp` subcommand** (`benny mcp --stdio`).

### 4.2 Dependencies

* `mcp>=1.0` — add to `pyproject.toml` under `[project.optional-dependencies].mcp`.
* Reuse existing `httpx` — already vendored.

### 4.3 Failing tests to write first

Path: `tests/mcp/test_mcp_server.py`
* `test_plan_tool_registered` — spin up the server in-process, list
  tools, assert the four tool names are present.
* `test_plan_tool_proxies_to_api` — monkeypatch the MCP client's HTTP
  layer; assert it POSTs to `/api/workflows/plan` with the manifest
  body.
* `test_run_tool_rejects_missing_signature_when_strict_env_set` —
  `BENNY_REQUIRE_SIGNATURES=1` should make the MCP client refuse
  unsigned manifests **before** hitting the API.
* `test_stream_events_yields_then_terminates` — patch the streaming
  response to emit two SSE lines then EOF; assert iterator yields two
  parsed events and exits cleanly.

Path: `tests/sdk/test_sdk_client.py`
* `test_client_plan_signs_on_request` — assert `client.plan(...)`
  returns a manifest with a populated `content_hash` and `signature`.
* `test_client_stream_closes_socket_on_workflow_completed` — verify no
  lingering httpx clients after a completed event.

### 4.4 Implementation notes

* **Do not** reimplement signature logic in the MCP layer — import
  `benny.core.manifest_hash.sign_manifest` and `verify_signature`.
* The MCP server must be **side-effect-free on import**. All I/O
  happens inside tool handlers. This keeps `pytest` fast.
* Respect `BENNY_OFFLINE`: in the `plan_workflow` tool, if the planner
  would use a cloud model and offline is set, surface the
  `OfflineRefusal` as an MCP error with a clear hint.

### 4.5 Commit message

```
phase 4: mcp server + python sdk for /api/workflows surface

- benny/mcp/server.py exposes plan/run/stream/get tools
- benny/sdk/BennyClient wraps the same transport for scripts
- bin/benny-mcp launcher + `benny mcp` subcommand
- signature verification enforced client-side when BENNY_REQUIRE_SIGNATURES=1
- tests: 6 new (tests/mcp, tests/sdk)
```

---

## Phase 5 — Local LLM Executor capabilities (LC-1..4)

**Goal:** when a manifest task names a local model, short-circuit
LiteLLM and run inference through a typed, in-process executor so we
can enforce quotas, stream tokens, and work fully offline.

### 5.1 LC-1..4 capability contracts

| Code  | Capability         | Notes |
|-------|--------------------|-------|
| LC-1  | `generate(prompt, *, max_tokens, temperature) -> str`        | baseline text |
| LC-2  | `stream(prompt, *, ...) -> AsyncIterator[str]`               | token streaming |
| LC-3  | `count_tokens(prompt) -> int`                                | cost pre-flight |
| LC-4  | `embed(text) -> list[float]`                                 | optional; provider-dependent |

### 5.2 Deliverables

1. **`benny/core/local_executor.py`** — `LocalExecutor` protocol plus:
   * `LemonadeExecutor` (HTTP to `http://127.0.0.1:13305`).
   * `OllamaExecutor` (HTTP to `http://127.0.0.1:11434`).
   * `LiteRTExecutor` (wraps the existing `LiteRTEngine`).
   * `LMStudioExecutor` and `FastFlowLMExecutor` share the OpenAI-
     compatible HTTP impl (subclass `OpenAICompatibleExecutor`).
2. **`resolve_executor(model_str) -> LocalExecutor | None`** — returns
   `None` for cloud models; `call_model` keeps its current LiteLLM path
   for that case.
3. **Wire into `benny/core/models.py`** — in `call_model`, after the
   offline check, `if is_local_model(model): executor =
   resolve_executor(model); if executor: return await
   executor.generate(...)`. **Keep `_run_completion` as the cloud seam.**

### 5.3 Failing tests to write first

Path: `tests/core/test_local_executor.py`
* `test_resolve_executor_returns_none_for_cloud` — `anthropic/claude-*`
  → `None`.
* `test_resolve_executor_maps_each_local_prefix` — parametrised over
  `lemonade/`, `ollama/`, `lmstudio/`, `fastflowlm/`, `litert/`.
* `test_lemonade_executor_generate_happy_path` — patch `httpx` to
  return a fake OpenAI-compatible JSON, assert parsed content.
* `test_stream_yields_incremental_chunks` — patch SSE-like body;
  assert the async iterator yields in order.
* `test_offline_still_blocks_before_executor` — `BENNY_OFFLINE=1` with
  a **cloud** model must still raise `OfflineRefusal`; with a local
  model, executor is used (no LiteLLM). Mock out the executor.
* `test_call_model_uses_executor_for_local_model` — end-to-end
  through `call_model`, assert `_run_completion` is **never** called
  when the model is local.

### 5.4 Implementation notes

* The executor layer is HTTP-only for now. No llama-cpp bindings.
* All executors share a `BaseOpenAICompatibleExecutor` that takes the
  base URL and api_key from `LOCAL_PROVIDERS[provider]`.
* Timeouts come from `PortableConfig.llm_timeout_seconds` (add the
  field if missing, default 120).
* Emit `resource_usage` on the `event_bus` with `provider=local/<name>`
  — the UI already listens.

### 5.5 Commit message

```
phase 5: local-llm executor (LC-1..4) short-circuits litellm

- benny/core/local_executor.py with per-provider HTTP executors
- call_model routes local models through executor, bypassing litellm
- streaming + token counting baked into the protocol
- tests: 6 new (tests/core/test_local_executor.py)
```

---

## Phase 6 — Observability + `benny doctor`

**Goal:** a single command reports on everything that must be healthy
for PBR-001 operation; structured logs for every LLM call and run.

### 6.1 Deliverables

1. **`benny/ops/doctor.py`** with checks returning a
   `DoctorReport(checks: list[CheckResult])`:
   * `BENNY_HOME` exists, writable, on removable media (advisory).
   * Required dirs (`workflows/`, `runs/`, `logs/`, `bin/`) present.
   * Each `ServiceSpec` from Phase 1b: port status + health probe.
   * Manifest schema version matches `SwarmManifest.SCHEMA_VERSION`.
   * `BENNY_OFFLINE` state + warnings if cloud defaults are set.
   * Clock drift vs. a local file mtime (no NTP; offline safe).
2. **`benny doctor` CLI subcommand** — prints a colored table; exit
   code 0 if all green, 1 if any error, 2 if only warnings.
3. **Structured logs at `${BENNY_HOME}/logs/llm_calls.jsonl`** —
   append on every `call_model` return (success or failure), one line
   of `{ts, run_id, model, provider, tokens_in, tokens_out,
   duration_ms, ok, error?}`. Rotate at 50MB; keep 5.
4. **`/api/ops/doctor`** endpoint that returns the same report as JSON
   (for the UI).

### 6.2 Failing tests to write first

Path: `tests/ops/test_doctor.py`
* `test_doctor_reports_all_green_when_services_up` — stub every
  probe; assert exit status 0.
* `test_doctor_flags_missing_home_dir` — point `BENNY_HOME` at a
  non-existent path; assert an error check.
* `test_doctor_warns_when_offline_and_cloud_default` — warning check
  present.
* `test_doctor_endpoint_serves_json` — via `TestClient`.

Path: `tests/ops/test_llm_call_log.py`
* `test_log_line_written_on_success` — patch `_run_completion`;
  assert the JSONL line contains the expected fields.
* `test_log_rotation_at_50mb` — point at a tiny size limit; write
  until rotation; assert `.1.jsonl` exists.

### 6.3 Commit message

```
phase 6: benny doctor + structured llm call log

- benny/ops/doctor.py with 6 health checks
- /api/ops/doctor JSON endpoint for the UI
- logs/llm_calls.jsonl rotating log (50MB × 5)
- tests: 6 new (tests/ops)
```

---

## Phase 7 — 6σ release gates

**Goal:** a release cannot be tagged unless the metrics below hold.
This is the quality floor.

### 7.1 Gates (all enforced by `tests/release/`)

| Gate       | Metric                                      | Threshold |
|------------|---------------------------------------------|-----------|
| G-COV      | Line coverage on `benny/` core modules      | ≥ 85 %    |
| G-SR1      | Absolute-path violations                    | ≤ baseline (currently 408) |
| G-LAT      | Median `/api/workflows/plan` latency (mocked LLM) | < 300 ms |
| G-ERR      | Flaky-test rerun success on 10× loop         | 100 %     |
| G-SIG      | 100% of signed manifests verify round-trip  | exact      |
| G-OFF      | `BENNY_OFFLINE=1` test matrix all pass       | exact      |

### 7.2 Deliverables

1. **`tests/release/test_release_gates.py`** — each gate a separate
   test; each reads thresholds from `docs/requirements/release_gates.yaml`.
2. **`bin/benny-release`** — a script that runs the gates and emits a
   green/red report to `release_report.json`.
3. **GitHub Actions workflow** `.github/workflows/release_gates.yml`
   gating every PR to `master` (fails the PR if any gate fails).

### 7.3 Commit message

```
phase 7: release gates enforce 6σ quality floor

- tests/release/test_release_gates.py (G-COV/SR1/LAT/ERR/SIG/OFF)
- docs/requirements/release_gates.yaml with thresholds
- bin/benny-release + CI workflow
```

---

## Phase 8 — `benny migrate` / import legacy

**Goal:** one command converts a pre-PBR Benny install (arbitrary
host paths, legacy manifest schema) into a portable `BENNY_HOME`.

### 8.1 Deliverables

1. **`benny/migrate/importer.py`** — given a source directory:
   * Detect legacy layout heuristically (presence of `benny.db`,
     `workspaces/`, etc.).
   * Convert legacy swarm manifests → `SwarmManifest` (Phase 2 schema)
     with `content_hash` + `signature` populated.
   * Rewrite absolute host paths to `${BENNY_HOME}`-relative.
   * Copy artifacts into `${BENNY_HOME}/runs/<run_id>/`.
   * Emit a `migration_report.json` (what moved, what was dropped,
     checksums).
2. **`benny migrate --from <path> --to <BENNY_HOME>` CLI** — dry-run
   by default; `--apply` to actually move.
3. **Roundtrip test:** migrate → serve → plan → run → verify.

### 8.2 Failing tests to write first

Path: `tests/migrate/test_importer.py`
* `test_dry_run_lists_actions_without_writing` — assert the target
  dir is empty after dry-run.
* `test_apply_rewrites_absolute_paths` — seed a legacy manifest with
  `C:\Users\...` paths; assert the migrated manifest contains
  `${BENNY_HOME}` only.
* `test_migrated_manifest_verifies` — after migration, the signature
  round-trips through `verify_signature`.
* `test_report_checksums_match_source` — every copied artifact has a
  recorded SHA-256 matching the source file.

### 8.3 Commit message

```
phase 8: benny migrate imports legacy installs into BENNY_HOME

- benny/migrate/importer.py with dry-run + --apply
- legacy manifests upgraded to Phase 2 schema and re-signed
- absolute paths rewritten to ${BENNY_HOME}
- migration_report.json for auditability
- tests: 4 new (tests/migrate)
```

---

## How to actually execute a phase

1. `cd C:\Users\nsdha\OneDrive\code\benny` (top-level, not worktree).
2. `git checkout master && git pull --ff-only origin master`.
3. Read the Phase section above top-to-bottom.
4. Write the failing tests from §X.3 first. Commit them WIP if you
   want a trail; otherwise keep them staged.
5. Implement the deliverables.
6. Run: `C:/Users/nsdha/miniconda3/python.exe -m pytest tests/api
   tests/core tests/portability tests/safety -q` — must be green.
7. Run the phase-specific tests (`tests/mcp/`, `tests/ops/`, …) —
   must be green.
8. `git add <paths> && git commit -m "<phase commit message>"`.
9. `git push origin master`.
10. Update the status table at the top of this file to mark the phase
    shipped, and commit that doc change.

## Known traps (learned in Phases 0–3)

* **Pytest from the worktree reports "0 tests ran"** — the worktree is
  at an older commit. Always `cd` to the top-level checkout before
  running tests.
* **BackgroundTask + TestClient hangs** — the FastAPI `TestClient`
  awaits background tasks before returning. Any endpoint whose
  background task touches an LLM must be monkey-patched in the test
  (see `tests/api/test_workflows_endpoints.py::test_run_accepts_unsigned_manifest`).
* **Monkeypatched async seams** — `_run_completion` is called via
  `_await_if_needed` so a test may patch it with either sync or
  async callables. If you add a new seam, use the same idiom.
* **Windows process group flags** — Phase 1b uses
  `CREATE_NEW_PROCESS_GROUP` on Windows and `start_new_session=True`
  on POSIX. Keep this pattern in Phase 5 if you ever spawn
  subprocess-based local executors (llama.cpp, etc.).
* **SR-1 scanner false positives** — strings like `"/Users/"` in
  assertion messages count. They live under the baseline; if a new
  one appears, either rewrite the assertion (`os.sep`,
  `PosixPath.parts`) or get user approval before raising the baseline.

## Glossary (for the next model)

* **PBR-001** — Portable Benny Requirements, the overall initiative.
* **`BENNY_HOME`** — the single root for all portable state
  (typically `D:/optimus`).
* **Manifest** — `SwarmManifest` Pydantic model in
  `benny/core/manifest.py`. Has `content_hash` (integrity) and
  `signature` (`sha256:` for unkeyed, `hmac-sha256:` for keyed).
* **Event bus** — `benny/core/event_bus.py`, a singleton pub/sub keyed
  by `run_id`. SSE stream at `/api/runs/{id}/events` reads from it.
* **Local provider** — one of `{lemonade, ollama, lmstudio,
  fastflowlm, litert}` (see `LOCAL_PROVIDERS` in `benny/core/models.py`).
* **`is_local_model(s)`** — prefix check; returns `True` for any of
  the five local-provider prefixes.
* **`OfflineRefusal`** — raised when `BENNY_OFFLINE=1` and the caller
  asks for a cloud model. Caught separately from ordinary transport
  errors.
