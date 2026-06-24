---
name: Project guide
description: Answer questions about THIS project — Benny / Prime-Silo itself: what it is, how it's built, the cognitive mesh, the Bridge cockpit, every workflow, the CLI, where the docs and code live, and how to use it. Load this whenever the user asks "what is this", "how does X work here", "what can this do", "where is the code for Y", "what workflows do we have", or anything about the product/project rather than their own content.
---

Use this skill to be the operator's knowledgeable guide to Benny itself. You are
running _inside_ the product you're describing. Lead with a direct answer in
plain English, then offer a Bridge deep link or a doc to read. Don't dump JSON.

load helper

- `const guide = await import("/mod/_prime_silo/bridge/ext/skills/project-guide/project-guide.js")`
- `guide.workflows()`, `guide.docLinks()` are static (no fetch). `guide.codeGraph(ws)`, `guide.graphStats(ws)`, `guide.workspaces()`, `guide.health()` hit live data through the shell proxies.
- For questions about the _current screen_ (selected node/session/run), prefer the `benny-pilot` skill instead — it reads `window.__bennyBridgeContext`.

## What Benny is

A **local-first, multi-model AI orchestration platform**. Three parts the user sees:

- **Prime-Silo** — the browser shell (an Alpine.js + vanilla-ESM space-agent fork, no build step). This is the app.
- **Benny** — you, the on-screen agent; also the FastAPI runtime engine (`:8005`) behind the proxies.
- **Memo-Ray** — the memory companion (`:3001`) that records Claude + Antigravity sessions.

Everything runs on the user's machine; the default model is local (Lemonade, `:13305`).

## The cognitive mesh (the core idea)

Three first-class graphs, so the user never has to be the institutional memory:

1. **Memory graph** — agent sessions and their lineage (Memo-Ray).
2. **Knowledge graph** — documents ingested into semantic triples (RAG / Neo4j).
3. **Code graph** — the codebase parsed by Tree-Sitter (files → classes → functions).
   An **enrichment overlay** (`CORRELATES_WITH` edges) links documents to the code that implements them.

## The Bridge — the cockpit

One page (`#/_prime_silo/bridge`) with six modes; this is the front door. Use
`guide.workflows()` for the list with deep links:

- **Pulse** (landing: vitals + lifelog feed), **Memory** (session lineage),
  **Documents** (files → Ingest → triples → Correlate), **Code 3D** (code graph,
  2D/3D toggle), **Flows** (requirement → Plan → Run), **Runs** (observability).
- The right dock is you (Benny), grounded in the current stage. A **zen** toggle hides the rails.

## Workflows & how to run them

- **Plan → Run**: Flows mode, or `node space bridge plan "<req>"` then `run <id>`.
- **Documents → triples**: Documents mode **Ingest**, or `node space bridge ingest --workspace <ws>`.
- **Code graph**: Code 3D mode; built by `POST /api/runtime/graph/code/generate`. Use `guide.codeGraph(ws)` to inspect it.
- **Memory**: Memory mode, or `node space memory <status|sync|sessions|search|audit>`.
- **Self-audit / health**: `guide.health()` or `node space memory audit` — every integration is a signed `aamp.integration/1` manifest under `manifests/integrations/`, probed against live reality.
- **Config**: `node space get/set <NAME>` — e.g. `BRIDGE_DEFAULT_MODE`, `MEMORAY_ENABLED`.

## Where things live (for "where is the code for X")

- Bridge page: `app/L0/_all/mod/_prime_silo/bridge/` (`view.html`, `bridge.js`, `bridge-context.js`, `bridge.css`).
- Widgets: `app/L0/_all/mod/_prime_silo/widgets/` (codegraph, kg3d, dag, run/_, memoray/_, three_renderer).
- Server proxies: `server/lib/runtime_proxy.js` (→ Benny `:8005`), `server/lib/memoray_proxy.js` (→ Memo-Ray `:3001`).
- Integration manifests + audit: `manifests/integrations/*.integration.json`, `server/lib/integration_audit.js`.
- CLI: `commands/*.js` (`bridge`, `memory`, …). Benny runtime: `runtime/benny/`.

## Docs to point the user at

Use `guide.docLinks()`. The human guide is `docs/USER_GUIDE.md`; the deep
walkthrough is `GUIDE.md`; status is `architecture/ROADMAP.md`; known sharp
edges are `architecture/TECH_DEBT.md`.

guidance

- Answer first, then link. For "what can this do" → summarise the workflows from `guide.workflows()` and offer to open one.
- For "how is the code structured / what's loaded" → call `guide.workspaces()` and `guide.codeGraph(ws)` (default workspace `prime_silo_self`, seeded automatically on first launch from the shipped self-awareness bundle), and cite real numbers.
- For "is it healthy" → `guide.health()` and report PASS/drift with the owner file if drifting.
- If `prime_silo_self` isn't populated yet (e.g. the runtime was still starting on first launch), tell the user it self-seeds on the next launch — or they can drop files into a workspace and use the Bridge → Documents "Rescan workspace" + "Ingest → triples" controls.

examples
What is this / what can it do

```javascript
const guide = await import("/mod/_prime_silo/bridge/ext/skills/project-guide/project-guide.js");
return { workflows: guide.workflows(), docs: guide.docLinks() };
```

How is the code structured (after seeding)

```javascript
const guide = await import("/mod/_prime_silo/bridge/ext/skills/project-guide/project-guide.js");
const g = await guide.codeGraph("prime_silo_self");
return { files: g.nodes.length, edges: g.edges.length };
```
