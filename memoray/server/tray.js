const SysTray = require('systray2').default;
const path = require('path');
const fs = require('fs');
const os = require('os');
const { startServer, stopServer, openBrowser, PORT } = require('./index');
const { configPath } = require('./lib/config');

// Extract the systray binary manually if running inside pkg
const isPackagedEnv = typeof process.pkg !== 'undefined';
if (isPackagedEnv) {
    try {
        const systrayPkg = require('systray2/package.json');
        const binName = ({
            win32: "tray_windows_release.exe",
            darwin: "tray_darwin_release",
            linux: "tray_linux_release"
        })[process.platform];
        
        const sourcePath = path.join(__dirname, '..', '..', 'node_modules', 'systray2', 'traybin', binName);
        const destDir = path.join(os.homedir(), '.cache', 'node-systray', systrayPkg.version);
        const destPath = path.join(destDir, binName);
        
        let shouldExtract = false;
        if (!fs.existsSync(destPath)) {
            shouldExtract = true;
        } else {
            try {
                const sourceStat = fs.statSync(sourcePath);
                const destStat = fs.statSync(destPath);
                if (sourceStat.size !== destStat.size) {
                    console.log(`[Tray] Size mismatch detected for ${binName}. Re-extracting.`);
                    shouldExtract = true;
                }
            } catch (e) {
                shouldExtract = true;
            }
        }

        if (shouldExtract) {
            console.log(`[Tray] Extracting native tray binary to ${destPath}`);
            if (!fs.existsSync(destDir)) {
                fs.mkdirSync(destDir, { recursive: true });
            }
            const binData = fs.readFileSync(sourcePath);
            fs.writeFileSync(destPath, binData);
            if (process.platform !== 'win32') {
                fs.chmodSync(destPath, 0o755);
            }
        }
    } catch (e) {
        console.error('[Tray] Manual binary extraction failed:', e.message);
    }
}

let systray = null;
let currentPort = PORT;
let isRunning = true;

// Helper to update the PORT in mem0ray.config.js
function updateConfigPort(newPort) {
    if (!fs.existsSync(configPath)) return;
    let content = fs.readFileSync(configPath, 'utf8');
    
    if (content.includes('PORT:')) {
        // Update existing PORT entry
        content = content.replace(/(PORT\s*:\s*)\d+/, `$1${newPort}`);
    } else {
        // Append PORT before the closing brace
        content = content.replace(/};\s*$/, `    PORT: ${newPort},\n};\n`);
    }
    fs.writeFileSync(configPath, content, 'utf8');
}

function initTray() {
    let iconBase64 = '';
    try {
        const iconPath = path.join(__dirname, 'icon.ico');
        iconBase64 = fs.readFileSync(iconPath).toString('base64');
    } catch (e) {
        console.warn('[Tray] Failed to load icon.ico, tray may appear empty.');
    }
    
    systray = new SysTray({
        menu: {
            icon: iconBase64,
            title: "Mem0Ray",
            tooltip: "Mem0Ray Dashboard",
            items: [
                {
                    title: `Status: Running (Port ${currentPort})`,
                    tooltip: "Server Status",
                    enabled: false
                },
                {
                    title: "Open Dashboard",
                    tooltip: "Open in Browser",
                    enabled: true
                },
                {
                    title: "Stop Service",
                    tooltip: "Start or Stop Mem0Ray Server",
                    enabled: true
                },
                SysTray.separator,
                {
                    title: "Change Port",
                    tooltip: "Change server port",
                    enabled: true,
                    items: [
                        { title: "Port 3000", tooltip: "Use port 3000", enabled: true, checked: currentPort === 3000 },
                        { title: "Port 3030", tooltip: "Use port 3030", enabled: true, checked: currentPort === 3030 },
                        { title: "Port 3002", tooltip: "Use port 3002", enabled: true, checked: currentPort === 3002 },
                        { title: "Port 3003", tooltip: "Use port 3003", enabled: true, checked: currentPort === 3003 },
                        { title: "Port 8080", tooltip: "Use port 8080", enabled: true, checked: currentPort === 8080 }
                    ]
                },
                SysTray.separator,
                {
                    title: "Exit",
                    tooltip: "Exit Mem0Ray",
                    enabled: true
                }
            ]
        },
        debug: false,
        copyDir: true, // Extracts bin to ~/.cache/node-systray on packaged runs to avoid native module limits
    });

    // Helper to find item by title recursively
    function findItem(menu, titleFragment) {
        for (const item of menu.items || []) {
            if (item.title && item.title.includes(titleFragment)) return item;
            if (item.items) {
                const found = findItem(item, titleFragment);
                if (found) return found;
            }
        }
        return null;
    }

    systray.onClick(action => {
        const title = action.item.title;

        if (title === "Open Dashboard") {
            openBrowser(`http://localhost:${currentPort}`);
        } 
        else if (title === "Stop Service" || title === "Start Service") {
            const statusItem = action.menu.items[0];

            if (isRunning) {
                stopServer();
                isRunning = false;
                
                action.item.title = "Start Service";
                statusItem.title = "Status: Stopped";
                
                systray.sendAction({ type: 'update-item', item: action.item, seq_id: action.seq_id });
                systray.sendAction({ type: 'update-item', item: statusItem, seq_id: statusItem.seq_id || 0 });
            } else {
                startServer(currentPort);
                isRunning = true;
                
                action.item.title = "Stop Service";
                statusItem.title = `Status: Running (Port ${currentPort})`;
                
                systray.sendAction({ type: 'update-item', item: action.item, seq_id: action.seq_id });
                systray.sendAction({ type: 'update-item', item: statusItem, seq_id: statusItem.seq_id || 0 });
            }
        } 
        else if (title.startsWith("Port ")) {
            const newPort = parseInt(title.replace("Port ", ""), 10);
            if (newPort === currentPort) return; // No change

            // Stop server, update config, start server
            stopServer();
            currentPort = newPort;
            updateConfigPort(currentPort);
            
            // Allow time for socket cleanup
            setTimeout(() => {
                startServer(currentPort);
                isRunning = true;
                
                // Update checks in the port menu
                const changePortMenu = action.menu.items.find(i => i.title === "Change Port");
                if (changePortMenu && changePortMenu.items) {
                    for (const portItem of changePortMenu.items) {
                        portItem.checked = portItem.title === `Port ${currentPort}`;
                    }
                    systray.sendAction({ type: 'update-menu', menu: action.menu });
                }

                // Update status and toggle
                const statusItem = action.menu.items[0];
                statusItem.title = `Status: Running (Port ${currentPort})`;
                systray.sendAction({ type: 'update-item', item: statusItem, seq_id: statusItem.seq_id || 0 });

                const toggleItem = action.menu.items.find(i => i.title === "Start Service" || i.title === "Stop Service");
                if (toggleItem) {
                    toggleItem.title = "Stop Service";
                    systray.sendAction({ type: 'update-item', item: toggleItem, seq_id: toggleItem.seq_id || 0 });
                }

            }, 500);
        }
        else if (title === "Exit") {
            stopServer();
            systray.kill(true); // Kills systray and exits node process
        }
    });

    return systray;
}

module.exports = { initTray };
