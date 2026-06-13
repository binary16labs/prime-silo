---
name: Memory recall
description: Answer "what was I working on", "which sessions touched file X", or "show me the lineage of Y" by querying the Memo-Ray memory graph (the operator's agent-session history across Claude + Antigravity). Load this when the user asks about past work, prior sessions, file history, or what an agent did.
---

Use this skill when the user asks about their own history — past sessions, what they were working on, which sessions touched a file, or the lineage of a piece of work. The answers come from the Memo-Ray memory graph, the third graph of the cognitive mesh (beside the knowledge graph and the code graph). You query it; the user should never have to be their own institutional memory.

load helper
- `await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js")`
- All calls go through the shell proxy (`/api/memoray`); no endpoint configuration needed.
- If a call throws "Memo-Ray is offline" or "disabled", relay that to the user with the fix (boot `scripts/memoray.ps1`, or enable it in the configuration wizard) — do not retry in a loop.

helpers
- `recentSessions({ agent?, limit? })` -> `[{ id, title, agent, project, timestamp, link }]`
- `search(query)` -> `{ sessions:[{…, link}], files, actions }` (omnibar across sessions/files/actions)
- `overview()` -> `{ claude, antigravity, totalNodes, lastSync }` ecosystem totals
- `sessionGraph(sessionId)` -> `{ nodes, links }` full lineage of one session
- `filesTouched(query)` -> `[{ fileName, filePath, agent }]`
- `sessionLink(sessionId)` -> deep link string into the visual memory page

guidance
- ALWAYS cite the session id and include the deep link (`link`, or `sessionLink(id)` → `#/_prime_silo/memory?session_id=<id>`) so the user can open the visual lineage at the memory page. Format as a markdown link to the hash route.
- Prefer `search(...)` for "which sessions touched X" or fuzzy questions; prefer `recentSessions(...)` for "what was I working on".
- Summarize — don't dump raw JSON. Lead with the answer (e.g. "You last worked on the lineage widget 2 hours ago"), then offer the link.
- This is read-only. You cannot modify the memory graph; you observe it.

examples
Recent work
```javascript
const memory = await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js")
const sessions = await memory.recentSessions({ limit: 5 })
return sessions
```

Which sessions touched a file
```javascript
const memory = await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js")
return await memory.search("memoray_proxy.js")
```

Lineage of a specific session
```javascript
const memory = await import("/mod/_prime_silo/memoray_client/ext/skills/memory-recall/memory-recall.js")
const graph = await memory.sessionGraph("<session-id>")
return { nodes: graph.nodes.length, links: graph.links.length, link: memory.sessionLink("<session-id>") }
```
