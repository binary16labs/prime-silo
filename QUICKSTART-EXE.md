# Prime-Silo Desktop — Quick Start Guide

> For users running the desktop EXE application (not developers)

## Overview

Prime-Silo is an AI-powered cognitive mesh platform. The desktop application runs on your machine and provides:

- A **browser interface** for interacting with AI agents
- A **system tray** for quick access and configuration
- A **workspace** (home directory) where data and configurations are stored

## Getting Started

### Step 1: Download and Install

1. Go to [Prime-Silo Releases](https://github.com/binary16labs/prime-silo/releases)
2. Download the `.exe` installer for your system:
   - **Windows 64-bit** (most common): `prime-silo-x64-setup.exe`
   - **Windows ARM64**: `prime-silo-arm64-setup.exe`
3. Run the installer and follow the prompts
4. The app will be installed and a shortcut added to your Start menu

### Step 2: First Launch and Setup

When you launch Prime-Silo for the first time:

1. **System Tray Icon** — Look for the Prime-Silo icon in your taskbar (bottom-right)
2. **Configure Home Directory** — Right-click the tray icon and select **"Configure Home Directory..."**
   - Choose (or create) a folder where Prime-Silo will store your workspace
   - This is where all your data, configs, and customware will live
3. **Browser Window** — The main browser interface should open at `http://localhost:3000`

### Step 3: Configure Your AI Model

Before you can use the agent, configure which AI model to use:

**Option A: Cloud Model (Easiest)**

1. Sign up for a free account at [OpenRouter.ai](https://openrouter.ai)
2. Get your API key from your account dashboard
3. In Prime-Silo, go to **Settings → AI Configuration**
4. Paste your OpenRouter API key
5. Select your preferred model (Claude, GPT, etc.)

**Option B: Local Model (No internet needed)**

1. Install [Ollama](https://ollama.ai) on your machine
2. Run a local model: `ollama run llama2` (or your preferred model)
3. In Prime-Silo, go to **Settings → AI Configuration**
4. Select **"Local Model"** and choose **"Ollama"**
5. Verify Ollama is running on `http://localhost:11434`

### Step 4: The Benny runtime starts itself (zero-install)

The Windows installer ships a **self-contained Benny runtime** — its own Python,
the Neo4j graph database, and a Java runtime, all bundled. On launch the app
**starts and supervises it for you**, so **Documents/ingestion, the knowledge &
code graphs, Flows, and Deep produce** just work on double-click. Nothing to
install, no Docker, no manual `benny up`.

- Right-click the tray → the status line shows **"Benny runtime: running
  (bundled)"** once it's up (Neo4j takes a few seconds to warm up on first
  launch; the UI fills in as it comes online).
- **Open Benny CLI** still opens a terminal wired to the runtime for `benny …`.
- Power users: untick **"Use bundled runtime"** (or set `RUNTIME_BASE_URL`) to
  point the app at your own Benny instead — e.g. one running on another machine.
  See [CLI.md](CLI.md). The bundled runtime is the default.

Chat works regardless; the document/graph/flow surfaces use the runtime above.

## Using the Desktop App

### System Tray Menu

Right-click the Prime-Silo icon in your taskbar for quick access:

- **Open Prime-Silo** — Bring the main window to foreground
- **Open in browser** — Open the app in your default browser
- **Home: `<your directory>`** — Click to open your home directory in File Explorer
- **Open Terminal Here** — Open a terminal already in your home directory
- **Configure Home Directory...** — Change where your workspace data is stored
- **Benny runtime: running / stopped** — Live status of the Benny services
- **Start Benny services** — Start the Benny runtime (Documents, graphs, deep-produce)
- **Stop Benny services** — Stop the Benny runtime
- **Set up environment (init + doctor)** — One-click `benny init` then `benny doctor`
- **Open Benny CLI** — Open a terminal with the environment wired so `benny …` just works
- **Benny Home: `<dir>` / Configure Benny Home...** — Point the tray at your Benny install
- **Memo-Ray: `<url>`** — Access the memory/session graph (if connected)
- **Quit Prime-Silo** — Close the application completely

> **No more manual server start.** The desktop app runs the shell server for
> you, and the tray drives the **Benny runtime** (the engine behind Documents,
> the knowledge/code graphs, Flows, and Deep produce). You never run
> `scripts/dev.ps1` or `node space serve` by hand.

### Main Interface (Browser)

When you open Prime-Silo in your browser:

1. **Left Sidebar** — Navigation menu for all features
2. **Chat Area** — Talk to the AI agent
3. **Manifest Explorer** — View and execute manifest workflows
4. **Runs Explorer** — See history of past executions
5. **Memory/Sessions** — Access previous conversation history

### Your Home Directory

All your data lives in the home directory you configured:

```
your-home-directory/
├── config/          # Settings and configurations
├── workspace/       # Your active working files
├── L1/              # Shared group data (if applicable)
├── L2/              # Your personal files
└── runs/            # History of manifest runs
```

You can safely explore and backup this directory. Back it up regularly if it contains important data.

## Common Tasks

### Save Your Work

All changes are automatically saved to your home directory. No manual save needed.

### Change Home Directory

1. Right-click the system tray icon
2. Click **"Configure Home Directory..."**
3. Select a new folder
4. Restart Prime-Silo for changes to take effect

### Update Prime-Silo

Restart the application to check for updates, or go to **Settings → Check for Updates**.

### Access Previous Sessions

1. Click **Memory** in the left sidebar (or **Memo-Ray** in the tray menu)
2. Browse your session history
3. Click a session to load previous conversations

## Troubleshooting

### "Home: (not configured)"

Your home directory hasn't been set up yet. Right-click the tray icon and select **"Configure Home Directory..."**.

### App won't start

- Make sure port 3000 is not in use by another application
- Try restarting your computer
- Check that your home directory still exists and is writable

### Documents / graphs / Flows say "load failed"

The bundled runtime is still warming up (Neo4j takes a few seconds on first
launch) or hasn't started. Right-click the tray and check the status line; if it
isn't **"Benny runtime: running"**, click **"Start Benny services"**, then reload
the page. (If you've unticked "Use bundled runtime" or set `RUNTIME_BASE_URL`,
make sure your external Benny is up.)

### AI agent not responding

- Check your internet connection (if using cloud model)
- Verify your API key is correct in Settings
- If using local model, check that Ollama is running

### Faster Deep produce across two machines

If you run a local model on more than one box, point Benny at all of them and the
**Deep produce** fan-out spreads its panel calls across them in parallel. Set,
before starting services:

```
BENNY_LEMONADE_ENDPOINTS=http://machine-a:13305/api/v1,http://machine-b:13305/api/v1
```

(or `BENNY_MODEL_ENDPOINTS` as a JSON map of provider → endpoints). With one
endpoint, fan-out stays sequential — still a quality win, just not parallel.

### Low performance

- Close other browser tabs or applications
- Check that your home directory is on a fast disk (not network drive)
- Monitor your system resources (Ctrl+Shift+Esc)

## Getting Help

- **Documentation** — See [GUIDE.md](GUIDE.md) for detailed walkthroughs
- **Home Directory** — See [HOME-DIRECTORY.md](HOME-DIRECTORY.md) for advanced configuration
- **CLI Commands** — See [CLI.md](CLI.md) for command-line usage
- **GitHub Issues** — Report bugs at https://github.com/binary16labs/prime-silo/issues

## What's Next?

Now that you're set up:

1. **Try the Agent** — Chat with the AI agent to ask questions
2. **Explore Manifests** — Look at sample workflows in Manifest Explorer
3. **Create a Workspace** — Save your work to organized folders
4. **Read the Full Guide** — See [GUIDE.md](GUIDE.md) for feature walkthroughs
