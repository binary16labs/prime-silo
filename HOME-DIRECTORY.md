# Prime-Silo Home Directory Configuration

## Overview

The **Home Directory** is where Prime-Silo stores its workspace data, including configuration, logs, and customware modules (L1, L2). On the desktop EXE, this location is now discoverable and configurable via the system tray.

## Finding Your Home Directory

### On Windows/Linux

1. **Right-click the Prime-Silo system tray icon** (bottom right of taskbar)
2. Look for the line: **`Home: <directory name>`**
3. Click it to open the folder in your file explorer

### On macOS

1. **Right-click the Prime-Silo menu bar icon** (top right)
2. Look for the line: **`Home: <directory name>`**
3. Click it to open the folder in Finder

If the home directory is not configured, it will show: **`Home: (not configured)`**

## Configuring the Home Directory

### First-Time Setup

1. Right-click the Prime-Silo system tray icon
2. Click **"Configure Home Directory..."**
3. Select (or create) a folder where you want to store Prime-Silo workspace data
4. Click **"Select Folder"** to confirm

The path will be saved and persists across restarts.

### Changing the Home Directory

To change the home directory later:

1. Right-click the system tray icon
2. Click **"Configure Home Directory..."**
3. Select a different folder
4. **Note:** You may need to restart Prime-Silo for some changes to take effect

## For Agents & Scripts

Agents and scripts running inside Prime-Silo can now query the configured home directory:

```javascript
// In Electron preload or IPC context
const { homeDir } = await ipcRenderer.invoke("space-desktop:get-home-directory");
console.log("Configured home:", homeDir);
// Returns: { homeDir: "/path/to/home" } or { homeDir: null }
```

This makes it possible for agents to:

- Know where the workspace is located
- Access workspace-relative paths
- Configure their own workspace initialization

## Troubleshooting

### "Home: (not configured)"

If you see this message, no home directory has been set yet. Click **"Configure Home Directory..."** to set one up.

### Home directory won't open

Make sure the directory still exists. If you've moved or deleted the folder, use **"Configure Home Directory..."** to point to the correct location.

### Changes not taking effect

Some changes require a restart of Prime-Silo. Close the app completely (use tray "Quit") and reopen it.

## Default Behavior

If no home directory is configured:

- The app uses its default internal workspace (if one exists)
- To make this explicit, configure one using the tray menu

## File Location

The home directory configuration is stored in:

- **Windows:** `%APPDATA%\Prime-Silo\prime-silo-config.json`
- **macOS:** `~/Library/Application Support/Prime-Silo/prime-silo-config.json`
- **Linux:** `~/.config/Prime-Silo/prime-silo-config.json`

You can manually edit this JSON file if needed (format: `{ "homeDir": "/path/to/home" }`).
