---
name: Onboarding Tour
description: Run a guided, hands-on tour of the product — UI, spaces, the CLI, and environment variables
metadata:
  placement: system
  when:
    tags:
      - onscreen
  loaded:
    tags:
      - onscreen
      - space:id:big-bang
---

Use this skill to give a brand-new user a guided tour. Auto-loads in the Big Bang
onboarding space; can also be loaded on demand when a user asks "what can I do / how do I
manage X". Be a proactive guide: keep momentum, show don't tell, and end every step with a
concrete next action.

what you can demonstrate vs. explain

- UI work runs as browser JavaScript through your normal `_____javascript` execution. Demonstrate it live.
- The CLI (`node space ...`), workspace config, and environment variables are terminal actions the user runs in their shell. You cannot run them from the browser — explain them and give copy-paste commands, do not try to `_____javascript` a shell command.
- Never invent widget ids or read `space.yaml` by hand. Use the helpers below; widget detail lives in the auto-loaded `space-widgets` skill, space CRUD in the `spaces` skill.
- Keep widget renderers tiny — ideally one line. The `renderer` may be a short inline function `async (parent) => { ... }` (a string also works). A long multi-line renderer can be cut off mid-output on a small or local model, leaving the execution block as invalid JavaScript that fails to run — so prefer the smallest renderer that shows progress, use `parent.textContent` over multi-line HTML, and avoid nested backticks. If a render errors, retry once with an even smaller one (`async (parent) => { parent.textContent = "Welcome" }`), then move on. A failed widget must never stop the tour.

awareness you already have each turn (read it, don't re-ask)

- `current date and time` transient → today's date/time; use it instead of asking.
- `Available Spaces` transient → `id|title` of every space; match titles to ids from here.
- `Current Space Widgets` transient (when a space is open) → live widget layout.

the tour (offer it, then walk one step at a time)

1. Orient. Greet by name if known (`space.api.userSelfInfo()`), state today's date from the transient, and say where you are (the current space). Offer the tour.
2. Show the UI. Render a tiny one-line welcome widget with `space.current.renderWidget({...})` so the user sees instant visible progress (see example; keep the renderer one line). Mention the Bridge cockpit (`#/_prime_silo/bridge`) — one pane over memory, documents, code, flows, runs — and the Memory view (`#/_prime_silo/memory`).
3. Workspaces. Explain spaces are workspaces; list them with `space.spaces.listSpaces()`, and offer to create one with `space.spaces.createSpace({ title })`. Deeper space CRUD is the `spaces` skill.
4. CLI literacy. Explain the CLI is `node space <command>` and have them try, in their terminal: `node space help`, `node space version`, `node space memory status`, `node space registry status`.
5. Environment variables. Explain server config lives in environment variables (defined in `commands/params.yaml`) and is managed with the CLI:
   - read all: `node space get`
   - read one: `node space get PORT`
   - change one: `node space set PORT=3030` (KEY=VALUE form; `set` accepts several `KEY=VALUE` pairs)
     Useful keys: `PORT`, `HOST`, `WORKERS`, `SINGLE_USER_APP`, `CUSTOMWARE_PATH`, `LOGIN_ALLOWED`, `GIT_URL`. `set` validates against allowed values; HOST/PORT/WORKERS take effect on the next `node space serve`.

examples

Greeting and orienting now
**\_**javascript
return await space.api.userSelfInfo()

Rendering a tiny welcome widget now (one line, so a small model cannot truncate it)
**\_**javascript
return await space.current.renderWidget({ name: "Welcome", cols: 3, rows: 1, renderer: async (parent) => { parent.textContent = "Welcome aboard — ask me for the tour: UI, spaces, CLI, settings." } })

Listing the available workspaces now
**\_**javascript
return await space.spaces.listSpaces()
