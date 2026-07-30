# T1 — Benny-home clone provenance (desktop → T480 trainer)

**Status:** 🟢 GATE GREEN — author-complete, **ready-for-verify** (author = claude on
the T480; independent verifier re-runs `node scripts/gates/t1.mjs`). Snapshot date:
**2026-07-23**.

Makes the trainer self-contained: data-building, training, and RAG-grounded serving
read a local clone of the Benny home — no LAN dependency during a run.

---

## Source snapshot (2026-07-23)

| Store                                 | Source (desktop-assembled)                    | Files   | Size                         |
| ------------------------------------- | --------------------------------------------- | ------- | ---------------------------- |
| Benny home (`benny/` + `customware/`) | external SSD `D:\benny-home`                  | 725,659 | 32,516,129,464 B (~30.28 GB) |
| memo-ray                              | `D:\mem0ray-data` (desktop `~/.mem0ray/data`) | 80,555  | ~84.8 MB                     |

Transfer medium: external 1 TB SSD (labelled `1TB-SSD`), plugged into the T480 as
drive **`D:`** (the desktop had it as `F:`; drive letters are per-machine).

## Placement on the trainer

Internal disk (`C:`) had **~28 GB free** — cannot hold the ~30 GB benny-home — so the
documented fallback is used:

- **benny-home RUNS OFF `D:`** (external): `PRIME_SILO_HOME = D:\benny-home`.
  `benny/` and `customware/` derive from it (resolver precedence, no overrides).
- **memo-ray COPIED internally** for fast, frequent training reads:
  `D:\mem0ray-data` → **`C:\Users\nsdha\.mem0ray\data`** (canonical `.mem0ray` — the
  stale `.memoray` sibling was left untouched, not recreated).

Pointing the home (both mechanisms set, for robustness):

1. `PRIME_SILO_HOME` + `MEMORAY_DATA_DIR` user env vars (`setx`) — visible to a fresh
   terminal and to both resolvers.
2. `%APPDATA%\Prime-Silo\prime-silo-config.json` `{ "homeDir": "D:\\benny-home" }`
   (resolver precedence #2) — session-independent.

Both are applied idempotently by **`scripts/train/clone_home/place-home.ps1`**.

## Verification (gate green)

`node scripts/gates/t1.mjs` → **GATE GREEN (exit 0)**, all reads local, no desktop
network call:

- **Home resolver** — Node **and** Python (`benny.portable.home.resolve_home`) both
  resolve `D:\benny-home`, `benny/` + `customware/` exist, no "outside the declared
  home" divergence warnings.
- **LONGVIEW cards** — 61 cards in `benny/workspaces/longview/data_in`; a known
  `longview_card_*.md` reads back.
- **memo-ray** — 278 sessions + 80,554 entities under `.mem0ray/data`; `index.json`
  and one entity read back.
- **S16 doc+vector** (the Chroma store) — 572 vectors in
  `benny/workspaces/longview/chromadb`; a `chroma:document` chunk reads back from
  `chroma.sqlite3` and its on-disk HNSW vector segment (`data_level0.bin`, ~2.4 MB) is
  present locally.

("S16" is the plan's name for the doc+vector RAG store; in the home that is Chroma.)

## Portability gotchas found (carry into T2/T3)

- **Microsoft-Store Python virtualizes `%APPDATA%`** — the Store `python` on PATH
  cannot see `prime-silo-config.json` in the real AppData (Node/PowerShell can). The
  `PRIME_SILO_HOME` env var is NOT virtualized, so the gate injects the Node-resolved
  root into the Python subprocess env; both resolvers then agree via env. Lesson: rely
  on `PRIME_SILO_HOME`, not the config file, for the Python side.
- **No system Node.js** on the T480 (the Node MSI needs admin; UAC was declined). The
  isolated Node bundled by the Unsloth install (`~/.unsloth/node`, v24.18.0) was added
  to the **User PATH** so `node scripts/gates/t1.mjs` resolves (no admin). A fresh
  terminal picks it up.
- **`.mem0ray` vs `.memoray`** — canonical is `.mem0ray`; a stale `.memoray` sibling
  exists on this box and was deliberately left alone.

## Refresh procedure (no silent drift)

1. Re-assemble the source on the desktop (its normal export) onto the external SSD.
2. On the T480, re-run **`scripts\train\clone_home\place-home.ps1`** — robocopy re-mirrors
   the small memo-ray store (skips unchanged), re-asserts the env vars + config. The
   large benny-home is read in place off `D:`, so it refreshes when the SSD is re-imaged.
3. Re-run `node scripts/gates/t1.mjs` → expect green.

To revert: remove the `PRIME_SILO_HOME` / `MEMORAY_DATA_DIR` user env vars and the
`homeDir` key from `prime-silo-config.json`.

## Residuals (out of T1 scope, flagged for owner)

- The gate validates the **file-based** stores directly (cards, memo-ray, Chroma) — it
  does **not** boot the Neo4j KG server. A full Benny-server boot would also need the
  repo `.env` (which hardcodes old `C:\…` `PRIME_SILO_HOME` / `BENNY_HOME` /
  `MEMORAY_DATA_DIR`) repointed at the clone — `.env` is outside the T1 allowlist, so
  that repoint + full-stack boot is a separate step (the exact stale-absolute-path risk
  the contract flagged).
- benny-home runs off the external `D:` (space fallback); moving it internal would need
  ≥31 GB free or a larger internal disk.
