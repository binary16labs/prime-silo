#!/usr/bin/env node
/**
 * generate-graph-html.js
 *
 * Connects to the Mem0Ray MCP server, fetches graph data for a session,
 * and generates a self-contained HTML file with an embedded canvas renderer.
 *
 * Usage (from any agent — Antigravity or Claude):
 *   node mcp-server/generate-graph-html.js --session <sessionId> --output media_pack/session_graph.html
 *
 * If --session is omitted, it uses the most recent session automatically.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Parse args
const args = process.argv.slice(2);
let sessionId = null;
let outputPath = path.join(__dirname, "..", "media_pack", "session_graph.html");

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session" && args[i + 1]) sessionId = args[++i];
  if (args[i] === "--output" && args[i + 1]) outputPath = args[++i];
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [path.join(__dirname, "index.js")]
  });

  const client = new Client({ name: "graph-generator", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  console.log("Connected to Mem0Ray MCP server.");

  // If no session ID, get the most recent one
  if (!sessionId) {
    console.log("No --session provided, fetching most recent...");
    const recentRes = await client.callTool({
      name: "get_recent_sessions",
      arguments: { limit: 1 }
    });
    const recent = JSON.parse(recentRes.content[0].text);
    if (!recent || recent.length === 0) {
      console.error("No sessions found.");
      process.exit(1);
    }
    sessionId = recent[0].id;
    console.log(`Using session: ${sessionId}`);
  }

  // Get graph data
  console.log("Fetching graph data...");
  const graphRes = await client.callTool({ name: "get_graph_data", arguments: { sessionId } });
  const graphData = JSON.parse(graphRes.content[0].text);
  console.log(`Graph: ${graphData.nodeCount} nodes, ${graphData.linkCount} links`);

  // Read the renderer script
  const rendererPath = path.join(__dirname, "..", "media_pack", "graph-renderer.js");
  const rendererCode = await fs.readFile(rendererPath, "utf-8");

  // Generate self-contained HTML
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mem0Ray Session Graph — ${sessionId.substring(0, 8)}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=JetBrains+Mono:wght@400&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: #0a0b0a;
      color: #e8ece9;
      font-family: 'Inter', sans-serif;
      overflow: hidden;
      height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .toolbar {
      display: flex;
      align-items: center;
      gap: 1rem;
      padding: 0.8rem 1.5rem;
      background: rgba(18, 22, 20, 0.95);
      border-bottom: 1px solid rgba(149, 165, 149, 0.15);
      flex-shrink: 0;
    }
    .toolbar h1 {
      font-size: 1rem;
      font-weight: 500;
      color: #95a595;
    }
    .breadcrumbs {
      display: flex;
      gap: 0.3rem;
      align-items: center;
      font-size: 0.8rem;
      color: #6b6a66;
      flex: 1;
      overflow-x: auto;
    }
    .breadcrumb-item {
      background: rgba(149, 165, 149, 0.1);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.2s;
    }
    .breadcrumb-item:hover { background: rgba(149, 165, 149, 0.25); }
    .breadcrumb-item.active { background: rgba(219, 83, 63, 0.3); color: #db533f; }
    .breadcrumb-sep { color: #4a4a46; }
    .btn {
      background: rgba(149, 165, 149, 0.15);
      border: 1px solid rgba(149, 165, 149, 0.25);
      color: #95a595;
      padding: 0.4rem 0.8rem;
      border-radius: 6px;
      font-size: 0.8rem;
      cursor: pointer;
      font-family: 'Inter', sans-serif;
      transition: all 0.2s;
    }
    .btn:hover { background: rgba(149, 165, 149, 0.3); }
    .btn.playing { background: rgba(219, 83, 63, 0.2); border-color: #db533f; color: #db533f; }
    canvas { flex: 1; display: block; }
    .node-detail {
      position: fixed;
      bottom: 0;
      left: 0;
      right: 0;
      background: rgba(18, 22, 20, 0.97);
      border-top: 1px solid rgba(149, 165, 149, 0.2);
      padding: 1rem 1.5rem;
      font-size: 0.85rem;
      max-height: 30vh;
      overflow-y: auto;
      display: none;
    }
    .node-detail.visible { display: block; }
    .node-detail h3 { color: #95a595; font-size: 0.9rem; margin-bottom: 0.5rem; }
    .node-detail p { color: #8a968f; line-height: 1.5; }
    .node-detail .meta { font-family: 'JetBrains Mono', monospace; font-size: 0.75rem; color: #6b6a66; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <div class="toolbar">
    <h1>Mem0Ray</h1>
    <div class="breadcrumbs" id="breadcrumbs">
      <span class="breadcrumb-item">Session</span>
    </div>
    <button class="btn" id="play-btn" onclick="togglePlay()">▶ Play</button>
    <button class="btn" onclick="graph.zoomToFit()">⊞ Fit</button>
  </div>
  <canvas id="graph-canvas"></canvas>
  <div class="node-detail" id="node-detail">
    <h3 id="detail-type"></h3>
    <p id="detail-content"></p>
    <div class="meta" id="detail-meta"></div>
  </div>

  <script>
${rendererCode}
  </script>
  <script>
    const graphData = ${JSON.stringify(graphData)};

    const canvas = document.getElementById('graph-canvas');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight - 50;

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight - 50;
    });

    const graph = new Mem0RayGraph(canvas, graphData, {
      animateOnLoad: true,
      onBreadcrumbChange: (crumbs) => {
        const el = document.getElementById('breadcrumbs');
        el.innerHTML = crumbs.map((c, i) =>
          (i > 0 ? '<span class="breadcrumb-sep">→</span>' : '') +
          '<span class="breadcrumb-item' + (i === crumbs.length - 1 ? ' active' : '') +
          '" onclick="graph.selectNode(\\'' + c.id + '\\')">' + c.type + '</span>'
        ).join('');
      },
      onNodeSelect: (node) => {
        const detail = document.getElementById('node-detail');
        detail.classList.add('visible');
        document.getElementById('detail-type').textContent = node.type + ' — ' + node.agent;
        document.getElementById('detail-content').textContent = node.label || '';
        document.getElementById('detail-meta').textContent =
          'Tokens: ' + node.tokens + ' | Size: ' + node.sizeBytes + ' bytes | ' +
          new Date(node.timestamp).toLocaleString();
      }
    });

    // Initial fit after simulation settles
    setTimeout(() => graph.zoomToFit(), 2500);

    function togglePlay() {
      const btn = document.getElementById('play-btn');
      if (graph.playing) {
        graph.stop();
        btn.textContent = '▶ Play';
        btn.classList.remove('playing');
      } else {
        graph.play(300);
        btn.textContent = '⏸ Stop';
        btn.classList.add('playing');
      }
    }
  </script>
</body>
</html>`;

  await fs.writeFile(outputPath, html);
  console.log(`\\nGenerated: ${outputPath}`);
  console.log(`Open this file in a browser to explore the session graph.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
