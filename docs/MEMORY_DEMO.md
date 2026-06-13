# Memory Graph — Feature Test & Demo Plan

A copy‑paste walkthrough of the **Memo‑Ray memory graph** built into the prime‑silo shell (Phase M1). One capability on **four surfaces** — page, CLI, agent skill, self‑audit — over a single configurable proxy.

Everything below is read‑only and safe to run live in front of an audience. Times are rough; the whole tour takes ~10 minutes.

> Shell runs on `:3000`, Benny runtime on `:8005`, Memo‑Ray on `:3001`, Lemonade on `:13305`.
> All commands are PowerShell from the prime‑silo repo root unless noted.

---

## 0. Boot the stack (one command)

```powershell
cd C:\Users\nsdha\OneDrive\binary16\prime-silo   # your working clone
.\scripts\dev.ps1
```

**Expect:** runtime + shell start, and because Memo‑Ray is enabled you'll see a line like
`memoray PID = #### (server :3001 — page at /#/_prime_silo/memory)`.
If Memo‑Ray isn't cloned beside prime‑silo you'll instead get a one‑line hint — that's fine, the offline screen in step 4 covers it.

Leave this window running. Open a **second** PowerShell window for the CLI steps.

---

## 1. Self‑audit — prove the integration is healthy (1 min)

The integration is declared in a signed manifest; the audit probes the live server against it.

```powershell
node scripts/audit-integrations.mjs
```

**Expect:** `memoray: PASS (pass 21 / drift 0 / skipped 4)` … `overall: PASS`.
This means every endpoint's live payload matches the declared contract. Exit code is `0`.

Same check over HTTP (needs the shell auth key):

```powershell
curl.exe -s -H "X-Benny-API-Key: benny-mesh-2026-auth" http://localhost:3000/api/integration_audit | python -m json.tool
```

**Expect:** JSON with `"status": "pass"` and a `findings` array (each finding carries the owner file to fix if it ever drifts).

---

## 2. CLI surface — `node space memory` (2 min)

```powershell
node space memory status
```
**Expect:** `status: online`, a node count, `sessions: N (claude X, antigravity Y)`, and the last sync time.

```powershell
node space memory sessions --agent claude --limit 5
```
**Expect:** 5 most recent Claude sessions, each with a title, project, and `id:`.

```powershell
node space memory search "memory"
```
**Expect:** grouped hits under `sessions / files / actions`.

```powershell
node space memory sync
```
**Expect:** `Delta sync completed.` (pulls in any new agent activity.)

```powershell
node space memory audit
```
**Expect:** the same PASS report as step 1 — this is the headless entry point (exit 1 on drift) a CI job or local LLM would call.

Config is managed through the standard param system:
```powershell
node space get MEMORAY_BASE_URL
```
**Expect:** `MEMORAY_BASE_URL=http://127.0.0.1:3001`.

---

## 3. The page — `#/_prime_silo/memory` (3 min)

Open in a browser:
```
http://localhost:3000/#/_prime_silo/memory
```

Walk through, top to bottom:

1. **Conformance strip** (under the title) — a green dot + "Integration conformance: healthy". This is the audit from step 1, surfaced for humans.
2. **Command Center cards** — system resources (CPU/RAM/network), top processes, workspace ecosystem totals, agent capabilities (Claude MCP servers + Antigravity plugins), git worktrees, the **File Memory Heatmap** (most‑touched files), and recent sessions.
3. **Pick a session** in the left list (or click one in "Recent agent activity"). The center pane draws its **lineage graph** — Session → input → thought → tool call → artifact, with touched files as rounded nodes.
4. **Click any node** → the right **inspector** shows its content, tool name, and file path. For a file node, click **Open** to open it in your OS.
5. **Search box** (top) — type a few letters; matching sessions drop down, click to jump.
6. **Agent filter** — switch between All / Claude / Antigravity.
7. **Sync now** — re‑pulls logs without leaving the page.
8. **Zen mode ↗** — links out to Memo‑Ray's full step‑through client on `:5173`.

**Demo highlight:** the heatmap file names are real (`fileName`/`filePath`) — point out that the conformance check in step 1 is exactly what guarantees those rows never silently break.

---

## 4. First‑class offline / disabled screens (1 min)

These prove the UI never dumps a stack trace at the operator.

**Offline:** in the dev.ps1 window press `Ctrl+C` once to stop, or just kill the Memo‑Ray server, then reload the page.
**Expect:** a friendly card — "Memo‑Ray is offline" with the exact boot command and a **Retry** button. (Reboot with `.\scripts\dev.ps1` or `.\scripts\memoray.ps1` and hit Retry.)

**Disabled:** turn the integration off and restart the shell:
```powershell
node space set MEMORAY_ENABLED=false
# restart dev.ps1
```
**Expect:** the page shows "Memo‑Ray is disabled" with a pointer to the wizard. Turn it back on:
```powershell
node space set MEMORAY_ENABLED=true
```

---

## 5. The agent knows your history (1 min)

Open the onscreen agent (chat panel, bottom of any shell page). Ask, in plain English:

```
What was I working on most recently?
```
**Expect:** the agent loads the `memory-recall` skill, queries the graph, and answers with session titles **plus clickable deep links** into the memory page — instead of asking *you* to remember.

Try also:
```
Which sessions touched memoray_proxy.js?
```
**Expect:** a short list with links. (The point of the whole project: you are not the institutional memory — the graph is.)

---

## 6. The self‑healing story — break it, watch the audit catch it (2 min, optional)

This is the most compelling demo of the "agent‑maintainable integration" idea.

Temporarily corrupt a declared contract:
```powershell
node space memory audit          # PASS
```
Open `manifests/integrations/memoray.integration.json`, find the `beta_overview` endpoint's `hotFiles` items, and rename `"fileName": "string"` to `"fileNameX": "string"`. Save, then:
```powershell
node space memory audit
```
**Expect:** `DRIFT` — a `payload_contracts` finding that names the exact field mismatch **and the owner files** that consume it (the heatmap widget, the page). This is what a maintaining agent (or local LLM via Lemonade) would act on.

Undo the edit, re‑sign, confirm green again:
```powershell
git checkout manifests/integrations/memoray.integration.json
node scripts/audit-integrations.mjs --sign
node space memory audit          # PASS
```

> Note: editing the manifest invalidates its signature until you re‑sign — the audit reports that as a `signature` drift, which is intentional (agents draft, humans re‑sign).

---

## One‑glance checklist

| # | Surface | Command / action | Healthy result |
|---|---------|------------------|----------------|
| 1 | Self‑audit (CLI) | `node scripts/audit-integrations.mjs` | `overall: PASS` |
| 1 | Self‑audit (HTTP) | `GET /api/integration_audit` | `"status":"pass"` |
| 2 | CLI | `node space memory status` | `status: online` |
| 3 | Page | open `#/_prime_silo/memory` | green strip + live cards + graph |
| 4 | Resilience | stop Memo‑Ray, reload | friendly offline card + Retry |
| 5 | Agent skill | ask "what was I working on?" | answer + deep links |
| 6 | Drift detection | corrupt a contract → `memory audit` | `DRIFT` with owner path |
