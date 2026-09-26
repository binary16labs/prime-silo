# Handover → new session on the ASUS (2026-08-16)

**You are a fresh session on the ASUS continuing work started on the T480 hub.** This
session's chat memory does NOT carry over (Claude memory is per-machine, local, not
OneDrive-synced), so this doc + `docs/ESTATE-SATELLITE-RUNBOOK.md` are your ground truth.
Everything referenced here is OneDrive-synced and present on this machine.

## Mission (one line)

Finish the **LONGVIEW v1.21.3 release pipeline** — produce the **TOGAF EPIC v7 SAD**
and the **AI Vampire V2 book** over the FULL session corpus — by running
`prime-silo` here on the ASUS (the T480 ran out of RAM).

## Why you're on the ASUS

The T480 (16 GB) is oversubscribed by LM Studio + Neo4j + benny → benny's event loop
wedges under memory pressure (both bundle and repo benny wedge — it's RAM, not code).
So compute moved here. **Division of labour:** LM Studio (gemma-4-e4b-agent + the nomic
embedder) stays on the **T480** at `192.168.68.125:1234`; **benny + Neo4j + the pipeline
run HERE**. The ASUS reaches the T480's LM over the LAN.

## What is already done (don't redo)

- **Pipeline is fully built & configured.** Phases: `inventory→extract→map→privacy→model→graph→code→enrich→sad→reduce→opus→pdf`. Includes: content-level **privacy gate** (auto-quarantines CV/PII), **`--auto-resume`** (self-heals LM/embedder/benny blips, waits at preflight), **live heartbeat + per-workflow telemetry** (`longview/pipeline/live.json`, `telemetry.jsonl`, per-phase logs), **estate host profiles** (`ESTATE_HOST=asus`).
- **The coverage fix is done and proven.** The original run built only 79/237 graph Sources (two bugs: the bundled benny lacks `/rag/graph-upsert`; deep-synthesis stalled). Fixed by serving the **repo benny** (has the route) + `LONGVIEW_DEEP_SYNTHESIS=false` (deterministic graph). A rebuild reached **231 Sources** — but that graph is in the T480's LOCAL Neo4j, so **you rebuild it here from the shared cards** (fast, deterministic).
- **The corpus is here via OneDrive:** `OneDrive/binary16/estate-workspace/benny/workspaces/longview_v5` — **237 cards + the chromadb VECTORS + data_out** (40 MB). Because the vectors came along, you start at **`--from graph`** (skip `model`).
- **`.env` is set:** proven agent `LONGVIEW_MODEL=lmstudio/gemma-4-e4b-agent` (env-pinned), `LONGVIEW_DEEP_SYNTHESIS=false`, `LONGVIEW_CARD_MAX_CHARS=16000`, LM endpoint = T480. Quarantine of 24 CV/personal/job sessions is baked into the workspace's `longview/quarantine.json`.

## Do this (the whole job)

Full steps + prereqs are in **`docs/ESTATE-SATELLITE-RUNBOOK.md`**. Short form:

1. **Prereqs:** OneDrive synced; runtime-bundle present (`%APPDATA%\space-agent\runtime-bundle` — launch the Space Agent desktop app once if missing, then quit it); confirm from here `curl http://192.168.68.125:1234/v1/models` lists `gemma-4-e4b-agent`, and the T480 has the nomic embedder loaded (`lms load nomic-ai/text-embedding-nomic-embed-text-v1.5` on the T480 if not). Ensure a `D:` drive for Neo4j data (else edit `neo4j_data_dir` in `config/estate-hosts.json`).
2. **Start benny + Neo4j** (leave running): `ESTATE_HOST=asus node scripts/estate/boot-satellite.cjs` — wait for `neo4jReady=true apiReady=true`. Eyeball its resolved `bennyHome`(OneDrive) / `neo4jData`(local) / `LM`(T480) lines.
3. **Run the pipeline:** `ESTATE_HOST=asus node scripts/longview/pipeline.mjs --yes --auto-resume --from graph`.

## Landmines (all already handled in code — here so you recognise them)

- **`src/prime-silo` junction:** any copy of the workspace MUST use robocopy `/XJ` — the junction is the whole repo and pulls 1 GB+ otherwise. (The synced copy already excluded it.)
- **Bundled benny 404s on `/rag/graph-upsert`** → `graph` phase produces nothing. `boot-satellite.cjs` serves the **repo** benny to fix this. Do NOT start benny via the plain desktop app for a run that includes `graph`.
- **Neo4j data must stay LOCAL** (a live DB on OneDrive corrupts). `boot-satellite.cjs` redirects it to `neo4j_data_dir`; BENNY_HOME being on OneDrive is fine for the cards.
- **benny wedges under RAM pressure.** Make sure this box has real headroom (the T480 failed at ~1 GB free). If benny goes unresponsive (listening but `/api/health` times out), it's memory — free some and it recovers; `--auto-resume` waits it out.
- **The T480 LM Studio must stay up** with gemma + the nomic embedder loaded, or `enrich`/`opus` (which embed) fail. `--auto-resume` will wait for the embedder at preflight.

## Success criteria

- `graph` phase reports ~230 Sources (not 79). Check: `curl "http://127.0.0.1:8005/api/graph/stats?workspace=longview_v5"`.
- Deliverables land in `…/workspaces/longview_v5/data_out/`: `TOGAF_EPIC_V7_SAD_binary16.pdf` and `opus/THE-AI-VAMPIRE.pdf` (+ `opus/COVERAGE.md`).
- Book citation coverage should beat the prior **25.3%** (it was built on 79 sources before; now on ~230).

## Report back to the human

The `boot-satellite` resolved-paths + `neo4jReady/apiReady` lines, the `graph` phase
Source count, and the final `data_out` deliverables + coverage number. If `sad`/`opus`
GATE-FAIL a few sections that's normal (keeps best draft); a whole-phase stop is not —
read the per-phase log under `longview/pipeline/<run>/logs/`.

## Key files

| File                                | What                                             |
| ----------------------------------- | ------------------------------------------------ |
| `docs/ESTATE-SATELLITE-RUNBOOK.md`  | full ASUS bring-up steps                         |
| `config/estate-hosts.json`          | host profiles (`asus` = this machine)            |
| `scripts/estate/boot-satellite.cjs` | repo-benny + local-Neo4j launcher                |
| `scripts/longview/pipeline.mjs`     | the release pipeline (`--help` for flags)        |
| `scripts/longview/lib/config.mjs`   | config + estate-profile resolver                 |
| `.env`                              | agent pin, deep-synth off, card cap, LM endpoint |
