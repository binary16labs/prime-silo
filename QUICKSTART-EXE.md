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

## Using the Desktop App

### System Tray Menu

Right-click the Prime-Silo icon in your taskbar for quick access:

- **Open Prime-Silo** — Bring the main window to foreground
- **Open in browser** — Open the app in your default browser
- **Home: `<your directory>`** — Click to open your home directory in File Explorer
- **Configure Home Directory...** — Change where your workspace data is stored
- **Memo-Ray: `<url>`** — Access the memory/session graph (if connected)
- **Quit Prime-Silo** — Close the application completely

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

### AI agent not responding
- Check your internet connection (if using cloud model)
- Verify your API key is correct in Settings
- If using local model, check that Ollama is running

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
