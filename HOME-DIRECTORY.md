# Prime-Silo Home — the single declared home

Prime-Silo keeps all of its workspace data under **one declared home
directory**, with everything else derived from it:

```
<home>/                       ← the declared Prime-Silo home
├── customware/               ← Space server data (L1/L2 modules)   → CUSTOMWARE_PATH
└── benny/                    ← portable Benny runtime              → $BENNY_HOME
    ├── bin/  config/  data/  workspaces/  models/  logs/  state/  …
```

One resolver decides where the home is, and every process — the desktop
shell, the tray, the Space server, `node space serve/supervise`, and the
Python runtime — asks the same resolver:

- Node: `packaging/desktop/home_resolver.js` (`resolveHome()`)
- Python: `benny.portable.home.resolve_home()` / `resolve_benny_home()`

## Resolution precedence (highest wins)

| #   | Source                                                                 | Provenance tag |
| --- | ---------------------------------------------------------------------- | -------------- |
| 1   | `PRIME_SILO_HOME` environment variable                                 | `env`          |
| 2   | `homeDir` in `prime-silo-config.json` (set via tray "Configure Home…") | `config`       |
| 3   | Per-user default: `<appData>/Prime-Silo/prime-silo-home`               | `default`      |

Derived paths can still be overridden individually — an explicit
`BENNY_HOME` or `CUSTOMWARE_PATH` env var always wins for its own path —
but the override is _reported_, not silent: it carries an `env-override`
source tag and a divergence warning when it points outside the declared
home.

**There is no repo-relative fallback.** Nothing writes into a git checkout
when the home is unconfigured; the per-user default is used instead.

## Checking where your home is (and why)

- **Tray** — right-click the Prime-Silo tray icon: one `Home: <name> (source)`
  entry whose submenu holds everything home-related — **Open workspaces
  (runs & outputs)** first (that's where generated deliverables land, e.g.
  `workspaces/<ws>/data_out/`), then home folder / Benny data / customware,
  Open Terminal Here, and Configure Home….
- **API** — `GET /api/home` on the Space server returns the resolved
  triple, each path's source, and any divergence warnings.
- **CLI** — `benny doctor` prints a `Home resolution` check with the same
  provenance; any legacy key or out-of-tree override shows as WARN.
- **Electron/IPC** — `ipcRenderer.invoke("space-desktop:get-home-directory")`
  returns `{ homeDir, home }` where `home` is the full resolved report.

## Configuring

1. Right-click the tray icon → **Home** submenu → **"Configure Home…"** →
   pick (or create) a folder. `benny/` and `customware/` will live under it.
2. Restart Prime-Silo for the runtime to adopt the new location (the tray
   shows a `Runtime using: … (restart to apply new home)` line until then).

The setting persists in:

- **Windows:** `%APPDATA%\Prime-Silo\prime-silo-config.json`
- **macOS:** `~/Library/Application Support/Prime-Silo/prime-silo-config.json`
- **Linux:** `~/.config/Prime-Silo/prime-silo-config.json`

Format: `{ "homeDir": "/path/to/home" }`.

## Legacy installs

Older versions used three independent locations. All of them keep working —
nothing is moved automatically — but each is flagged so you can adopt the
unified layout when ready:

| Legacy mechanism                                                            | Behavior now                                                                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bennyHome` key in `prime-silo-config.json` (old "Configure Benny Home…")   | Honored (`legacy-config`); tray offers **"Clear legacy Benny Home override"** as the explicit adoption step |
| `<userData>/benny-home` and `<userData>/customware` (old per-user defaults) | Auto-detected when they exist (`legacy-default`) so existing data stays visible                             |
| `BENNY_HOME` env var pointing elsewhere                                     | Honored (`env-override`) with a divergence warning in doctor//api/home                                      |

To adopt the unified home: configure a home via the tray (or set
`PRIME_SILO_HOME`), move the contents of your old benny-home into
`<home>/benny/` and old customware into `<home>/customware/`, then clear
the legacy override. `benny doctor` confirms when everything reports
`derived`.

## For agents & scripts

- Query `GET /api/home` instead of reading env vars.
- Python code must call `benny.portable.home.resolve_benny_home()` rather
  than `os.environ.get("BENNY_HOME", <fallback>)` — cwd-relative fallbacks
  are how run debris used to end up committed to the repo.
- Node code (desktop/CLI/server) requires
  `packaging/desktop/home_resolver.js`.

## Troubleshooting

- **"Runtime using: … (restart to apply new home)"** in the tray — you
  reconfigured the home while the bundled runtime was running. Quit and
  reopen Prime-Silo.
- **Doctor WARNs about a legacy key or env override** — expected until you
  adopt the unified layout (see "Legacy installs"); the WARN is the
  tripwire, not an error.
- **Home folder won't open** — the directory no longer exists; reconfigure
  via the tray.
