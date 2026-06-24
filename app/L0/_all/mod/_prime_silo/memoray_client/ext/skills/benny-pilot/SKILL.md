---
name: Benny pilot
description: Be the operator's grounded co-pilot inside the Bridge cockpit (#/_prime_silo/bridge). Load this when the user is on the Bridge and asks "what am I looking at", "explain this graph", "what did I work on", "ingest these docs", "re-run the last manifest", or any question about the mesh on screen — memory, documents, code graph, flows, or runs.
---

Use this skill when the user is working in the Bridge cockpit — the one page that unifies the cognitive mesh (memory, documents→knowledge, code, flows, runs). Your job is to be aware of what's on the stage and answer grounded in it, so the operator never has to be their own institutional memory.

load helper
- `const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")`
- Start with `pilot.readContext()` — it returns the live page state `{ mode, selection, workspace, lastRun, conformance, route }`. Let that tell you which mode the user is in and what they've selected.
- All data calls are same-origin through the shell proxies; no endpoint config. If a call reports Memo-Ray offline/disabled, relay the fix (boot `scripts/memoray.ps1`, or enable it in the wizard) — do not retry in a loop.

helpers
- `readContext()` -> live `{ mode, selection, workspace, lastRun, conformance, route }`
- `lifelog(limit?)` -> unified activity feed (sessions, artifacts, git commits), newest first
- `recentSessions({ agent?, limit? })` -> `[{ id, title, agent, project, timestamp, link }]`
- `search(query)` -> `{ sessions:[{…, link}], files, actions }`
- `runs(limit?)` -> `[{ runId, status, requirement, link }]`
- `codeGraph(workspace?)` -> `{ nodes, edges }` of the Tree-Sitter code graph
- `knowledgeStats(workspace?)` -> `{ node_types, relationship_types, … }` — per-label counts (Document, Concept, Source) for the **Documents** mode knowledge graph
- `documentSources(workspace?)` -> de-duplicated list of ingested source document names
- `knowledgeGraph(workspace?, { page?, pageSize?, showAll? })` -> `{ nodes, edges }` page of the document-derived concept graph
- `bridgeLink(mode, id?)` -> deep link string back into a Bridge mode/selection
- `workspaceFileList(workspace?)` -> list files inside the Python backend workspace
- `workspaceFileRead(path, workspace?)` -> preview/read the contents of a file in the workspace

guidance
- The dispatched prompt already carries the truth: read the `(Bridge context — …)` and `Live data:` lines you were given and answer from them. `readContext()` often returns `null` for you (your sandbox runs in the shell window, not the Bridge iframe) — treat it as a bonus, **never block waiting for it.**
- **Never demand a selection.** "No node selected" is a normal, answerable state, not a blocker. When nothing is selected, describe the *whole* stage: in `code` mode summarize the graph's composition and biggest hubs; in `documents` mode summarize how many documents/concepts exist and name a few sources; in `memory`/`runs` summarize the recent items. *Then offer* to drill into a node — don't ask the user to pick one first.
- When something *is* selected, focus the answer on it (the selected code node, session, run, or concept) while keeping the surrounding context.
- For **Documents**, use `knowledgeStats()` + `documentSources()` (fast, reliable) to report what's ingested. Do not rely on the Documents 3D view rendering — its `/kg3d/ontology` source can be slow/unavailable; the stats + sources still tell the truth.
- ALWAYS cite a Bridge deep link (`link`, or `bridgeLink(mode, id)`) as a markdown link so the user can jump back to the exact view.
- If you need to list or read files in the active workspace (e.g. paths beginning with `src/` in `code` mode), do NOT use standard `space.api.fileList` or `space.api.fileRead` since those point at the host space directories and will fail. Use `workspaceFileList()` and `workspaceFileRead()` instead.
- Lead with the answer, then offer the link. Summarize — never dump raw JSON.
- This is read-only/observe-and-explain. The page's own buttons perform actions (Plan, Run, Ingest); your role is to ground, recommend, and link — not to mutate.

examples
What am I looking at
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
const ctx = pilot.readContext()
return ctx
```

What did I work on recently
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
return await pilot.recentSessions({ limit: 5 })
```

Explain a run
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
const ctx = pilot.readContext()
const all = await pilot.runs(10)
return all.find(r => r.runId === ctx?.lastRun) || all[0]
```

Explain the code graph (no node selected → summarize the whole graph)
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
const ctx = pilot.readContext()              // may be null — that's fine
const ws = ctx?.workspace || "default"
if (ctx?.selection?.id) {                    // a node IS selected → focus on it
  return await pilot.workspaceFileRead(ctx.selection.id, ws)
}
// Nothing selected: describe composition + biggest hubs, then offer to drill in.
const { nodes = [], edges = [] } = await pilot.codeGraph(ws)
const byType = nodes.reduce((m, n) => (m[n.type] = (m[n.type] || 0) + 1, m), {})
const degree = {}
for (const e of edges) { degree[e.source] = (degree[e.source]||0)+1; degree[e.target] = (degree[e.target]||0)+1 }
const hubs = nodes.slice().sort((a,b) => (degree[b.id]||0) - (degree[a.id]||0)).slice(0, 5)
  .map(n => `${n.name} (${degree[n.id]||0} links)`)
return { workspace: ws, totalNodes: nodes.length, totalEdges: edges.length, byType, topHubs: hubs }
```

Explain my documents
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
const ctx = pilot.readContext()
const ws = ctx?.workspace || "default"
const stats = await pilot.knowledgeStats(ws)
const sources = await pilot.documentSources(ws)
return {
  documents: stats?.node_types?.Document || stats?.node_types?.Source || 0,
  concepts: stats?.node_types?.Concept || 0,
  sources: sources.slice(0, 10)
}
```
