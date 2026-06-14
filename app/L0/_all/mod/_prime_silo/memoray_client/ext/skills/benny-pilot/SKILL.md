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
- `bridgeLink(mode, id?)` -> deep link string back into a Bridge mode/selection
- `workspaceFileList(workspace?)` -> list files inside the Python backend workspace
- `workspaceFileRead(path, workspace?)` -> preview/read the contents of a file in the workspace

guidance
- ALWAYS read `readContext()` first and tailor the answer to the current `mode` and `selection`. In `code` mode "explain this" means the selected code node; in `memory` mode it means the selected session; in `runs` mode it means the selected run.
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

Explain the code graph or selection
```javascript
const pilot = await import("/mod/_prime_silo/memoray_client/ext/skills/benny-pilot/benny-pilot.js")
const ctx = pilot.readContext()
if (ctx?.mode === "code" && ctx?.selection?.id) {
  // Read the selected workspace file/directory
  return await pilot.workspaceFileRead(ctx.selection.id, ctx.workspace)
}
return await pilot.codeGraph(ctx?.workspace)
```
