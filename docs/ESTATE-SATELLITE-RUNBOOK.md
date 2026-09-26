# Estate satellite bring-up — run prime-silo on the ASUS (LM Studio stays on the T480)

Distributed topology (decided 2026-08-16):

```
T480 (hub)     : LM Studio — gemma-4-e4b-agent + nomic embedder @ 192.168.68.125:1234
ASUS (satellite): prime-silo — pipeline + benny + Neo4j (this runbook)
OneDrive (SoR) : shared workspace (cards + vectors) — synced to both
Per-machine    : Neo4j graph DATA stays LOCAL (never on OneDrive — sync corrupts a live DB)
```

The workspace (237 cards + the 20 MB `chromadb` vectors + `data_out`) is already
copied to OneDrive at `…/OneDrive/binary16/estate-workspace/benny/workspaces/longview_v5`
and syncs to the ASUS. Because the vectors are shared, the ASUS only rebuilds the
Neo4j **graph** from the cards (fast, deterministic) — start the pipeline at `--from graph`.

## Prerequisites on the ASUS

- OneDrive synced (this repo **and** `estate-workspace/`).
- The **runtime-bundle** present (`%APPDATA%\space-agent\runtime-bundle` — python + Neo4j + JRE + deps). If missing, launch the Space Agent desktop app once to fetch it, then quit it.
- **No LM Studio needed here** — the ASUS reaches the T480's at `http://192.168.68.125:1234`. Confirm from the ASUS: `curl http://192.168.68.125:1234/v1/models` lists `gemma-4-e4b-agent` **and** the nomic embedder is loaded (`lms load nomic-ai/text-embedding-nomic-embed-text-v1.5` on the T480 if not).
- A LOCAL path with a few GB free for Neo4j data (the profile assumes `D:/benny-home`; change `neo4j_data_dir` in `config/estate-hosts.json` if the ASUS has no D:).

Everything below is driven by the `asus` profile in `config/estate-hosts.json`
(`ESTATE_HOST=asus`): workspace ← OneDrive, Neo4j data ← **local** (`neo4j_data_dir`),
LM/embedder ← T480, `bind_host: 0.0.0.0` for remote control. Adjust `neo4j_data_dir`
in that file if the ASUS has no `D:` drive, then let OneDrive sync the change.

## 1 — Start benny + Neo4j on the ASUS (REPO benny — it has the graph-upsert route)

The bundled benny is **missing** `/rag/graph-upsert` (the v1.15 route) — the `graph`
phase 404s on it. `scripts/estate/boot-satellite.cjs` serves the **repo** benny
(repo `runtime/benny` first on PYTHONPATH), redirects Neo4j's DATA to the profile's
LOCAL `neo4j_data_dir` (BENNY_HOME is on OneDrive; the live DB must not be), and
binds to `0.0.0.0` for remote control:

```powershell
cd <onedrive>\binary16\prime-silo
$env:ESTATE_HOST = "asus"
node scripts/estate/boot-satellite.cjs
```

Wait for `neo4jReady=true apiReady=true — benny :8005 (LAN — remote control on)`.
It prints the resolved `bennyHome` (OneDrive), `neo4jData` (local), and `LM` (T480) —
sanity-check those lines.

## 2 — Run the pipeline on the ASUS

```powershell
cd <onedrive>\binary16\prime-silo
$env:ESTATE_HOST = "asus"      # LM/embedder → T480; benny/Neo4j → local; workspace → OneDrive
node scripts/longview/pipeline.mjs --yes --auto-resume --from graph
```

`--from graph` rebuilds the Neo4j graph from the shared cards, then `enrich → sad
→ opus → pdf`. Auto-resume waits for the T480 LM/embedder if they blink; the live
heartbeat + per-phase telemetry land under `…/longview/pipeline/` (visible on the
dashboard). Deliverables: `data_out/TOGAF_EPIC_V7_SAD_binary16.pdf` + `data_out/opus/`.

## Remote monitoring from the T480 (optional)

With `BENNY_BIND=0.0.0.0` on the ASUS, point the dashboard at the satellite:
`LONGVIEW_WORKSPACE=longview_v5 BENNY_API_HOST=192.168.68.131 bash scratch/longview_run/dashboard/dash.sh`
(the workspace is shared via OneDrive, so the T480 reads the same live.json + ledger).
