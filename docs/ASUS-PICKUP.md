# ASUS pickup — outstanding items before the run (2026-08-16)

The T480 hub prepared the full handover (see **`docs/HANDOVER-ASUS.md`** — read that
first for the mission and the run steps). Two tiny durable fixes could NOT be applied
on the T480 because OneDrive held the repo files locked mid-sync. **Apply them here,
then proceed per the handover.** They make the local-Neo4j path robust so you don't
have to remember an env override every time.

Until you apply Fix 1 + Fix 2, the run is still safe **as long as** you set a local
Neo4j path each time you start benny:

```powershell
$env:ESTATE_HOST    = "asus"
$env:NEO4J_DATA_DIR = "C:\benny-neo4j"     # any LOCAL, non-OneDrive path
node scripts/estate/boot-satellite.cjs
```

Why it matters: Neo4j is a live DB — its data must stay on a LOCAL disk, never on
OneDrive (sync corrupts a live DB). The graph is derived and rebuilds from the shared
cards, so local is zero-loss. The old default pointed at `D:`, which this machine may
not have; if the Neo4j dir can't be created the launcher could otherwise fall back to
the OneDrive path. Both fixes below remove that risk.

---

## Fix 1 — `config/estate-hosts.json`: make the default Neo4j path universally-local

In the `asus` host, change the `neo4j_data_dir` line:

```diff
-      "neo4j_data_dir": "D:/benny-home/data/graph",
+      "neo4j_data_dir": "%LOCALAPPDATA%/prime-silo/neo4j-data",
```

(`%LOCALAPPDATA%` always exists and is local; the config resolver already expands `%VAR%`.)
Also, in that host's `note`, the sentence "Adjust neo4j_data_dir if the ASUS has no D:
drive." is now stale — optional to reword.

## Fix 2 — `scripts/estate/boot-satellite.cjs`: never fall back to OneDrive for Neo4j data

Replace the `neo4jDataDir` resolution (near the top, ~line 55) so the default is local
AND a bad configured path falls back to `%LOCALAPPDATA%`, never to `bennyHome` (OneDrive):

```js
// BEFORE
const neo4jDataDir = expand(
  process.env.NEO4J_DATA_DIR || profile.neo4j_data_dir || path.join(bennyHome, "data", "graph")
).replace(/\\/g, "/");

// AFTER
const LOCAL_NEO4J = path
  .join(process.env.LOCALAPPDATA || process.env.TEMP || ".", "prime-silo", "neo4j-data")
  .replace(/\\/g, "/");
let neo4jDataDir = expand(
  process.env.NEO4J_DATA_DIR || profile.neo4j_data_dir || LOCAL_NEO4J
).replace(/\\/g, "/");
try {
  fs.mkdirSync(neo4jDataDir, { recursive: true }); // configured path must be a real LOCAL disk
} catch {
  console.warn(
    `[satellite] neo4j_data_dir '${neo4jDataDir}' unusable — falling back to ${LOCAL_NEO4J}`
  );
  neo4jDataDir = LOCAL_NEO4J;
  fs.mkdirSync(neo4jDataDir, { recursive: true });
}
```

Then `node --check scripts/estate/boot-satellite.cjs` (should print nothing) and
`npx prettier --write scripts/estate/boot-satellite.cjs`.

---

## After the fixes

- Start benny: `ESTATE_HOST=asus node scripts/estate/boot-satellite.cjs` — confirm the
  printed `neo4jData` line is a LOCAL path and `neo4jReady=true apiReady=true`.
- Then run the pipeline per `docs/HANDOVER-ASUS.md` §"Do this":
  `ESTATE_HOST=asus node scripts/longview/pipeline.mjs --yes --auto-resume --from graph`.
- If OneDrive on the ASUS also locks these files while editing, just retry — the lock
  is transient (sync in progress).

## Report back to the human

That Fix 1 + Fix 2 are applied, the resolved `bennyHome`/`neo4jData`/`LM` lines, the
`graph` phase Source count (~230 expected, not 79), and the final `data_out`
deliverables (`TOGAF_EPIC_V7_SAD_binary16.pdf`, `opus/THE-AI-VAMPIRE.pdf`) + coverage.
