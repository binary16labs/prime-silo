# Benny — User Guide (for humans)

This is the plain-English guide to using Benny day to day. No jargon you don't
need. If you only read one doc, read this one.

> **What Benny is, in a sentence:** a local-first AI workbench that turns your
> documents, your code, and your past agent sessions into three explorable
> graphs — and gives you one cockpit (the **Bridge**) plus an on-screen agent
> (**Benny**) that already knows what you're looking at, so *you* never have to
> be the glue holding it all together.

- **Prime-Silo** is the app you open in the browser (the shell).
- **Benny** is the on-screen agent in the bottom corner, and also the name of
  the local runtime engine behind the scenes.
- **Memo-Ray** is the memory companion that records your agent sessions.

---

## 1. Start it (one command)

```powershell
# 1. free port 3000 if a leftover legacy container is on it (see Troubleshooting)
docker stop dangpy-frontend            # only if needed

# 2. boot the whole stack
cd C:\Users\nsdha\OneDrive\project\2026\prime-silo
.\scripts\dev.ps1
```

`dev.ps1` checks the ports first and tells you plainly if something's in the
way. When it's up, open:

```
http://localhost:3000/#/_prime_silo/bridge
```

That's the **Bridge** — your home base. It's also in the dashboard launcher as
**Bridge**.

---

## 2. The Bridge — everything in one place

One page, a **mode rail** on the left, a **stage** in the middle, and **Benny**
in the dock on the right. A **zen** toggle (top-right) hides the rails so you
can focus on just the stage.

| Mode | What it's for |
|------|---------------|
| **Pulse** | Your landing. System vitals, a green "mesh healthy" dot, and the **Lifelog** — a live feed of your sessions, files, and git commits across every project. |
| **Memory** | Pick one of your past agent sessions and see its full lineage as a graph. |
| **Documents** | Pick a workspace, see its files, click **Ingest → triples** to turn documents into the knowledge graph, then **Correlate** to link them to your code. |
| **Code 3D** | Your codebase as a graph (files → classes → functions). Flip the **2D/3D** toggle for a WebGL view. |
| **Flows** | Type what you want in plain English → **Plan** draws the pipeline → **Run** executes it and shows you what happened. No copy-paste, no terminal. |
| **Runs** | Pick any past run and watch its timeline and the agent's reasoning trace. |

The three graphs (Memory, Documents→Knowledge, Code) are the **cognitive mesh**.
Flows is how you *act*; Runs is how you *watch*; Pulse is your *glance*.

---

## 3. Talking to Benny

Benny sits in the dock and **knows what's on your stage** — the current mode,
what you've selected, and which workspace you're in. So you can be lazy with
your wording:

- On **Code 3D** with a node selected → click **"Explain this graph"** and Benny
  explains *that node*.
- Anywhere → ask **"What did I work on recently?"** and Benny answers from your
  memory graph with clickable links.
- Ask **"What is this project / how does X work?"** and Benny loads its
  **project-guide** knowledge and answers about Benny itself — architecture,
  workflows, where things live.

The chips in the dock are shortcuts; they change with the mode. You can also
just type in Benny's chat box. Benny runs on your **local** model (Lemonade) by
default — nothing leaves your machine.

---

## 4. The workflows you have (catalog)

Everything below is reachable from the Bridge, the CLI, or both.

### Plan → Run (Flows)
Turn a requirement into a running pipeline.
- **UI:** Bridge → Flows → type requirement → **Plan** → **Run**.
- **CLI:** `node space bridge plan "<requirement>"` then `node space bridge run <id>`.

### Documents → knowledge triples (RAG)
Turn PDFs/markdown into a queryable knowledge graph.
- **UI:** Bridge → Documents → pick workspace → **Ingest → triples** → **Correlate w/ code**.
- **CLI:** `node space bridge ingest --workspace <ws>`.

### Code graph
See and query your codebase structure (Tree-Sitter).
- **UI:** Bridge → Code 3D (workspace selector + 2D/3D toggle).
- Ask Benny "what depends on this?" with a node selected.

### Memory graph
Your agent sessions (Claude + Antigravity), X-rayed.
- **UI:** Bridge → Memory, or the standalone page `#/_prime_silo/memory`.
- **CLI:** `node space memory <status|sync|sessions|search|audit>`.

### Enrichment (the overlay that links graphs)
`CORRELATES_WITH` edges tie documents to the code that implements them — built
by **Correlate** in Documents mode.

### Self-audit (is everything healthy?)
Every integration is a signed manifest; the audit checks live reality against
it.
- **UI:** the conformance dot on the Bridge / Memory pages.
- **CLI:** `node space memory audit` (reports `bridge` and `memoray`, both should be PASS).

### Config from the terminal
- `node space get <NAME>` / `node space set <NAME>=<value>`.
- Useful: `BRIDGE_DEFAULT_MODE` (which mode the Bridge opens on),
  `MEMORAY_ENABLED`, `MEMORAY_BASE_URL`.

---

## 5. The framework is the demo (Benny's own code, seeded automatically)

There's no separate demo to run — the app ships self-aware. On first launch the
desktop shell seeds a **`prime_silo_self`** workspace from the bundled
self-awareness pack: a snapshot of **prime-silo's own source code**, a static
code graph, the application manifests, and the navigable skills. It then builds
the code graph and ingests the docs in the background, so you can talk to Benny
about the very thing you're running. Then:

1. **Bridge → Code 3D**, pick the `prime_silo_self` workspace → explore the code graph.
2. Select a node → Benny chip **"Explain this graph"**.
3. Ask Benny: *"How does the Bridge cockpit work?"* / *"What are all the workflows?"*
4. **Bridge → Documents** (`prime_silo_self`) → see the ingested guides as triples.
5. **Flows** → type *"summarise the architecture decisions"* → **Plan** → **Run** → watch it in **Runs**.

To explore your own data, open **Bridge → Documents**, drag files onto the drop
zone (PDF · TXT · MD · JSON), watch each file's ingestion status, then
**Ingest → triples**. **Rescan workspace** reconciles what's on disk with what's
ingested. (If `prime_silo_self` looks empty right after a first launch, the
runtime was still starting — it self-seeds on the next launch.)

---

## 6. Configuring it

- **Setup site:** `\.scripts\site.ps1` serves the setup site (`site/`),
  where the *Services* step toggles Memo-Ray and records endpoints. It also
  links out to these guides and the Bridge.
- **Ports (defaults):** shell `3000`, Benny runtime `8005`, Memo-Ray server
  `3001`, Memo-Ray client `5175`, Lemonade `13305`.
- **Agent model:** the on-screen agent uses Lemonade locally by default; change
  it in Benny's settings (gear icon) or the *Agent* page.

---

## 7. Troubleshooting

- **`localhost:3000` shows a strange login / 404s everything** → a leftover
  Docker container is on port 3000. `dev.ps1` now detects this and prints the
  fix. See [architecture/TECH_DEBT.md](../architecture/TECH_DEBT.md) (TD-1):
  `docker stop dangpy-frontend`.
- **A graph mode says "load failed"** → the Benny runtime (`:8005`) or Memo-Ray
  (`:3001`) isn't up. `dev.ps1` starts both; check its output for warnings.
- **Conformance shows "drift"** → run `node space memory audit` for the exact
  finding and the owner file to fix. (Editing a manifest needs a re-sign:
  `node scripts/audit-integrations.mjs --sign` with your `BENNY_HMAC_KEY` set.)

---

## 8. Where the rest of the docs live

- [README.md](../README.md) — project overview + phase status
- [GUIDE.md](../GUIDE.md) — page-by-page walkthrough (more detail than this)
- [architecture/ROADMAP.md](../architecture/ROADMAP.md) — what's shipped / next
- [architecture/TECH_DEBT.md](../architecture/TECH_DEBT.md) — known sharp edges
- `CLAUDE.md` — the map for AI agents working in this repo

Or just ask Benny — it can read these and answer in plain English.
