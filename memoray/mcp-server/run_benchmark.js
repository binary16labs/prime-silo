import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = path.join(__dirname, '..', 'agent-os-dashboard', 'server', 'data');
const ENTITIES_DIR = path.join(DATA_DIR, 'entities');
const INDEX_PATH = path.join(DATA_DIR, 'index.json');

// Hardcoded to lowest model as requested (behavior is identical for context logic)
const modelName = "Gemini 3.5 Flash";

function estimateTokens(str) {
  return Math.ceil(str.length / 4);
}

function calculateCost(inTokens, outTokens) {
  const inputCost = (inTokens / 1_000_000) * 3.00;
  const outputCost = (outTokens / 1_000_000) * 15.00;
  return inputCost + outputCost;
}

function truncateString(str, length = 500) {
  if (str.length <= length) return str;
  return str.substring(0, length) + "...\n[TRUNCATED FOR UI DISPLAY]";
}

async function getTargetSessionId() {
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const index = JSON.parse(indexData);
  const sessionIds = index.sessions || [];
  
  let sessions = [];
  for (const id of sessionIds) {
    try {
      const data = await fs.readFile(path.join(ENTITIES_DIR, `${id}.json`), 'utf-8');
      const session = JSON.parse(data);
      sessions.push(session);
    } catch(e) {}
  }
  sessions.sort((a, b) => b.timestamp - a.timestamp);
  return sessions[0]?.id || sessions[0]?.sessionId;
}

async function runWithoutMCP_Test1(targetId) {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const entityPath = path.join(ENTITIES_DIR, `${targetId}.json`);
  const entityData = await fs.readFile(entityPath, 'utf-8');
  const duration = performance.now() - start;

  const payloadReceived = indexData + entityData;
  const tokensIn = estimateTokens(payloadReceived) + 500;
  const tokensOut = 150;

  return {
    name: "Get Latest Session",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index.json (${indexData.length} chars) and session entity (${entityData.length} chars) manually.`,
    rawData: truncateString(payloadReceived)
  };
}

async function runWithMCP_Test1(client) {
  const start = performance.now();
  const response = await client.callTool({
    name: "get_recent_sessions",
    arguments: { limit: 1 }
  });
  const duration = performance.now() - start;
  const responseText = response.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_recent_sessions", arguments: { limit: 1 } })) + 100;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 30;

  return {
    name: "Get Latest Session",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_recent_sessions tool. Received ${responseText.length} chars of structured output.`,
    rawData: truncateString(responseText)
  };
}

async function runWithoutMCP_Test2(targetId) {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const entityPath = path.join(ENTITIES_DIR, `${targetId}.json`);
  const entityData = await fs.readFile(entityPath, 'utf-8');
  const session = JSON.parse(entityData);
  
  let payloadReceived = indexData + entityData;
  const queue = [...(session.children_ids || [])];
  let loadedCount = 0;
  
  while (queue.length > 0) {
    const childId = queue.shift();
    try {
      const childPath = path.join(ENTITIES_DIR, `${childId}.json`);
      const childData = await fs.readFile(childPath, 'utf-8');
      payloadReceived += childData;
      loadedCount++;
      const child = JSON.parse(childData);
      if (child.children_ids) {
        queue.push(...child.children_ids);
      }
    } catch (e) {}
  }
  const duration = performance.now() - start;
  const tokensIn = estimateTokens(payloadReceived) + 1500;
  const tokensOut = 450;

  return {
    name: "Reconstruct Session Timeline",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index and recursively loaded all ${loadedCount} child JSON entities from disk.`,
    rawData: truncateString(payloadReceived)
  };
}

async function runWithMCP_Test2(client, targetId) {
  const start = performance.now();
  const responseTimeline = await client.callTool({
    name: "get_session_timeline",
    arguments: { sessionId: targetId }
  });
  const duration = performance.now() - start;
  const responseText = responseTimeline.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_session_timeline", arguments: { sessionId: targetId } })) + 100;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 50;

  const timeline = JSON.parse(responseText);
  const events = timeline.map(event => ({
    type: event.type || "Event",
    agent: event.agent || "System",
    timestamp: event.timestamp,
    sizeBytes: JSON.stringify(event).length,
    tokens: estimateTokens(JSON.stringify(event))
  })).sort((a, b) => a.timestamp - b.timestamp);

  return {
    name: "Reconstruct Session Timeline",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_session_timeline tool. Received full structured timeline directly.`,
    rawData: truncateString(responseText),
    timelineEvents: events
  };
}

async function runWithoutMCP_Test3() {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const index = JSON.parse(indexData);
  const sessionIds = index.sessions || [];
  
  let payloadReceived = indexData;
  let checkedCount = 0;
  for (const id of sessionIds) {
    try {
      const entityPath = path.join(ENTITIES_DIR, `${id}.json`);
      const data = await fs.readFile(entityPath, 'utf-8');
      payloadReceived += data;
      checkedCount++;
    } catch (e) {}
  }
  const duration = performance.now() - start;
  const tokensIn = estimateTokens(payloadReceived) + 2000;
  const tokensOut = 300;

  return {
    name: "Query Sessions by Project Name",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index and scanned all ${checkedCount} individual session entities to find matches on project name.`,
    rawData: truncateString(payloadReceived)
  };
}

async function runWithMCP_Test3(client) {
  const start = performance.now();
  const response = await client.callTool({
    name: "get_project_activity",
    arguments: { projectPath: "benny", limit: 5 }
  });
  const duration = performance.now() - start;
  const responseText = response.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_project_activity", arguments: { projectPath: "benny", limit: 5 } })) + 100;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 40;

  return {
    name: "Query Sessions by Project Name",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_project_activity tool. Received filtered matching sessions only.`,
    rawData: truncateString(responseText)
  };
}

async function runWithoutMCP_Test4() {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const index = JSON.parse(indexData);
  const sessionIds = index.sessions || [];
  
  let payloadReceived = indexData;
  let loadedSessions = 0;
  for (const id of sessionIds.slice(0, 3)) {
    try {
      const entityPath = path.join(ENTITIES_DIR, `${id}.json`);
      const data = await fs.readFile(entityPath, 'utf-8');
      payloadReceived += data;
      loadedSessions++;
    } catch (e) {}
  }
  const duration = performance.now() - start;
  const tokensIn = estimateTokens(payloadReceived) + 3000;
  const tokensOut = 500;

  return {
    name: "Cross-Session Knowledge Merge",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index and fully loaded ${loadedSessions} distinct session histories to merge their context.`,
    rawData: truncateString(payloadReceived)
  };
}

async function runWithMCP_Test4(client) {
  const start = performance.now();
  const response = await client.callTool({
    name: "get_recent_sessions",
    arguments: { limit: 3 }
  });
  const duration = performance.now() - start;
  const responseText = response.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_recent_sessions", arguments: { limit: 3 } })) + 200;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 150;

  return {
    name: "Cross-Session Knowledge Merge",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_recent_sessions tool. Received precise summaries of 3 sessions for cross-referencing.`,
    rawData: truncateString(responseText)
  };
}

async function runWithoutMCP_Test5() {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const index = JSON.parse(indexData);
  const sessionIds = index.sessions || [];
  
  let payloadReceived = indexData;
  let loadedSessions = 0;
  
  // Loading EVERYTHING again just to parse stats out of text!
  for (const id of sessionIds) {
    try {
      const entityPath = path.join(ENTITIES_DIR, `${id}.json`);
      const data = await fs.readFile(entityPath, 'utf-8');
      payloadReceived += data;
      loadedSessions++;
    } catch (e) {}
  }
  
  const duration = performance.now() - start;
  const tokensIn = estimateTokens(payloadReceived) + 4000; // Large prompt asking to extract skills from raw JSON
  const tokensOut = 600;

  // Simulate timeline events for the graph (1 node per session read)
  const events = sessionIds.map((id, index) => ({
    type: "Session",
    agent: "System",
    timestamp: Date.now() - (sessionIds.length - index) * 1000,
    sizeBytes: 1500, // rough avg
    tokens: 300 // rough avg
  }));

  return {
    name: "Project Skill & Stat Extraction",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index and fully loaded ${loadedSessions} sessions, forcing the LLM to parse raw JSON to summarize projects and extract skills.`,
    rawData: truncateString(payloadReceived),
    timelineEvents: events
  };
}

async function runWithMCP_Test5(client) {
  const start = performance.now();
  const response = await client.callTool({
    name: "get_project_summary_and_skills",
    arguments: { projectPath: "benny" }
  });
  const duration = performance.now() - start;
  const responseText = response.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_project_summary_and_skills", arguments: { projectPath: "benny" } })) + 100;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 100;

  // Simulate timeline events for the graph (Tool Call + Result)
  const events = [
    {
      type: "Tool Call",
      agent: "Claude",
      timestamp: Date.now() - 2000,
      sizeBytes: 150,
      tokens: 40
    },
    {
      type: "Tool Result",
      agent: "System",
      timestamp: Date.now() - 1000,
      sizeBytes: responseText.length,
      tokens: responseTokens
    }
  ];

  return {
    name: "Project Skill & Stat Extraction",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_project_summary_and_skills tool. Received clean, structured analytical summary directly.`,
    rawData: truncateString(responseText),
    timelineEvents: events
  };
}

async function runWithoutMCP_Test6(targetId) {
  const start = performance.now();
  const indexData = await fs.readFile(INDEX_PATH, 'utf-8');
  const entityPath = path.join(ENTITIES_DIR, `${targetId}.json`);
  const entityData = await fs.readFile(entityPath, 'utf-8');
  const session = JSON.parse(entityData);
  
  let payloadReceived = indexData + entityData;
  const queue = [...(session.children_ids || [])];
  let loadedCount = 0;
  
  while (queue.length > 0) {
    const childId = queue.shift();
    try {
      const childPath = path.join(ENTITIES_DIR, `${childId}.json`);
      const childData = await fs.readFile(childPath, 'utf-8');
      payloadReceived += childData;
      loadedCount++;
      const child = JSON.parse(childData);
      if (child.children_ids) {
        queue.push(...child.children_ids);
      }
    } catch (e) {}
  }
  const duration = performance.now() - start;
  // We simulate that the agent must read the whole timeline to slice it
  const tokensIn = estimateTokens(payloadReceived) + 1500;
  const tokensOut = 100;

  return {
    name: "Sliding Window Timeline",
    method: "Without MCP (Direct File Access)",
    timeMs: duration,
    tokensIn,
    tokensOut,
    costUsd: calculateCost(tokensIn, tokensOut),
    details: `Read index and fully loaded ${loadedCount} JSON entities to manually find the last 50 events.`,
    rawData: truncateString(payloadReceived)
  };
}

async function runWithMCP_Test6(client, targetId) {
  const start = performance.now();
  const response = await client.callTool({
    name: "get_session_timeline_window",
    arguments: { sessionId: targetId, limit: 50, offset: 0 }
  });
  const duration = performance.now() - start;
  const responseText = response.content[0].text;
  
  const tokensIn = estimateTokens(JSON.stringify({ name: "get_session_timeline_window", arguments: { sessionId: targetId, limit: 50, offset: 0 } })) + 100;
  const responseTokens = estimateTokens(responseText);
  const totalTokensIn = tokensIn + responseTokens;
  const tokensOut = 50;

  const windowData = JSON.parse(responseText);
  const events = windowData.events.map(event => ({
    type: event.type || "Event",
    agent: event.agent || "System",
    timestamp: event.timestamp,
    sizeBytes: JSON.stringify(event).length,
    tokens: estimateTokens(JSON.stringify(event))
  }));

  return {
    name: "Sliding Window Timeline",
    method: "With MCP Server",
    timeMs: duration,
    tokensIn: totalTokensIn,
    tokensOut,
    costUsd: calculateCost(totalTokensIn, tokensOut),
    details: `Invoked get_session_timeline_window tool. Received exactly ${windowData.windowSize} events directly.`,
    rawData: truncateString(responseText),
    timelineEvents: events
  };
}

async function main() {
  const transport = new StdioClientTransport({
    command: "node",
    args: ["index.js"]
  });

  const client = new Client({
    name: "benchmark-client",
    version: "1.0.0"
  }, {
    capabilities: {}
  });

  await client.connect(transport);
  console.log(`Running benchmarks with model: ${modelName}`);

  const targetId = await getTargetSessionId();
  const results = [];

  console.log("Running Test 1 (Get Latest Session)...");
  const t1_no_mcp = await runWithoutMCP_Test1(targetId);
  const t1_mcp = await runWithMCP_Test1(client);
  results.push({ testId: 1, noMcp: t1_no_mcp, mcp: t1_mcp });

  console.log("Running Test 2 (Reconstruct Timeline)...");
  const t2_no_mcp = await runWithoutMCP_Test2(targetId);
  const t2_mcp = await runWithMCP_Test2(client, targetId);
  results.push({ testId: 2, noMcp: t2_no_mcp, mcp: t2_mcp });

  console.log("Running Test 3 (Query by Project)...");
  const t3_no_mcp = await runWithoutMCP_Test3();
  const t3_mcp = await runWithMCP_Test3(client);
  results.push({ testId: 3, noMcp: t3_no_mcp, mcp: t3_mcp });

  console.log("Running Test 4 (Cross-Session Merge)...");
  const t4_no_mcp = await runWithoutMCP_Test4();
  const t4_mcp = await runWithMCP_Test4(client);
  results.push({ testId: 4, noMcp: t4_no_mcp, mcp: t4_mcp });
  
  console.log("Running Test 5 (Skill Extraction)...");
  const t5_no_mcp = await runWithoutMCP_Test5();
  const t5_mcp = await runWithMCP_Test5(client);
  results.push({ testId: 5, noMcp: t5_no_mcp, mcp: t5_mcp });

  console.log("Running Test 6 (Sliding Window)...");
  const t6_no_mcp = await runWithoutMCP_Test6(targetId);
  const t6_mcp = await runWithMCP_Test6(client, targetId);
  results.push({ testId: 6, noMcp: t6_no_mcp, mcp: t6_mcp });

  // Totals
  const totalNoMcpTokensIn = results.reduce((acc, curr) => acc + curr.noMcp.tokensIn, 0);
  const totalNoMcpTokensOut = results.reduce((acc, curr) => acc + curr.noMcp.tokensOut, 0);
  const totalNoMcpCost = results.reduce((acc, curr) => acc + curr.noMcp.costUsd, 0);
  const totalNoMcpTime = results.reduce((acc, curr) => acc + curr.noMcp.timeMs, 0);

  const totalMcpTokensIn = results.reduce((acc, curr) => acc + curr.mcp.tokensIn, 0);
  const totalMcpTokensOut = results.reduce((acc, curr) => acc + curr.mcp.tokensOut, 0);
  const totalMcpCost = results.reduce((acc, curr) => acc + curr.mcp.costUsd, 0);
  const totalMcpTime = results.reduce((acc, curr) => acc + curr.mcp.timeMs, 0);

  const currentRunData = {
    timestamp: new Date().toISOString(),
    modelUsed: modelName,
    totals: {
      noMcp: {
        tokensIn: totalNoMcpTokensIn,
        tokensOut: totalNoMcpTokensOut,
        costUsd: totalNoMcpCost,
        timeMs: totalNoMcpTime
      },
      mcp: {
        tokensIn: totalMcpTokensIn,
        tokensOut: totalMcpTokensOut,
        costUsd: totalMcpCost,
        timeMs: totalMcpTime
      },
      contextExhaustion: {
        maxWindowSize: 128000,
        noMcpPercent: (totalNoMcpTokensIn / 128000) * 100,
        mcpPercent: (totalMcpTokensIn / 128000) * 100
      },
      savings: {
        tokensIn: totalNoMcpTokensIn - totalMcpTokensIn,
        tokensOut: totalNoMcpTokensOut - totalMcpTokensOut,
        costUsd: totalNoMcpCost - totalMcpCost
      }
    },
    tests: results
  };

  const JS_OUTPUT_PATH = path.join(__dirname, '..', 'scratch', 'mcp_benchmark_results.js');

  await fs.mkdir(path.join(__dirname, '..', 'scratch'), { recursive: true });

  // Replace completely to clear out old multi-model data history, since we only want the new single model run
  const jsContent = `window.mcpBenchmarkData = ${JSON.stringify({ runs: [currentRunData] }, null, 2)};`;
  await fs.writeFile(JS_OUTPUT_PATH, jsContent);

  console.log(`\nBenchmarks completed! Outputs written to ${path.join(__dirname, '..', 'scratch')}`);
  process.exit(0);
}

main().catch(console.error);
