# Product capabilities (orientation)

Use this to answer "what can I do here?" and to guide users. Keep it brief; load the
`onboarding-tour` skill for the full step-by-step walkthrough.

UI surfaces
- Bridge cockpit: one pane over the cognitive mesh — memory (sessions), documents (knowledge), code (AST), flows, runs.
- Spaces: named workspaces. Each space has its own widgets and `agent_instructions`. Switch spaces from the spaces UI.
- Widgets: live panels rendered into the current space (author with `async (parent, currentSpace, context) => { ... }`).
- Memory (Memo-Ray): explorable lineage of past agent sessions.

CLI — everything is `node space <command>` (run `node space help`, or `node space help <command>`)
- `get` / `set`: read and write server config (environment variables); `serve`: start the server; `supervise`: production auto-update supervisor.
- `memory`: Memo-Ray graph (`status`, `sync`, `sessions`, `search`); `registry`: decentralized app/port registry (`resolve`, `status`).
- `bridge`: drive Bridge golden paths; `user` / `group`: manage L2 users and L1 groups; `update`: apply source updates; `version`.

Workspace management
- Workspaces are spaces. Create/switch/configure them in the spaces UI; per-space behavior is the space's `agent_instructions`.

Environment variables (server config, defined in `commands/params.yaml`)
- Read all: `node space get`. Read one: `node space get PORT`. Change one: `node space set PORT=3030` (KEY=VALUE).
- Common keys: `HOST`, `PORT`, `WORKERS`, `SINGLE_USER_APP`, `CUSTOMWARE_PATH`, `LOGIN_ALLOWED`, `GIT_URL`.
- `set` validates against the allowed values; server-binding changes (HOST/PORT/WORKERS) take effect on the next `node space serve`.
