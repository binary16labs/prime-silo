import fs from "node:fs";
import path from "node:path";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import neo4j from "neo4j-driver";

// Q0: single resolution path — env BENNY_API_KEY -> per-install keystore
// ($BENNY_HOME/state/hmac-key) -> fail fast at startup. No shipped default remains.
const BENNY_API_KEY = (() => {
  if (process.env.BENNY_API_KEY) return process.env.BENNY_API_KEY;
  const bennyHome = process.env.BENNY_HOME;
  if (bennyHome) {
    try {
      const value = fs.readFileSync(path.join(bennyHome, "state", "hmac-key"), "utf8").trim();
      if (value) return value;
    } catch {
      // fall through to fail-fast
    }
  }
  console.error(
    "BENNY_API_KEY is not set and no per-install key was found at " +
      "<BENNY_HOME>/state/hmac-key. Set the BENNY_API_KEY environment variable, " +
      "or run `benny init` to generate a per-install keystore."
  );
  process.exit(1);
})();

const server = new Server(
  {
    name: "prime-silo-nexus",
    version: "1.0.0"
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "execute_cypher",
        description:
          "Execute an arbitrary Cypher query on the Neo4j dual graph (contains both Tree-sitter code structures and Docling RAG concepts connected via CORRELATES_WITH).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The Cypher query to execute on Neo4j."
            }
          },
          required: ["query"]
        }
      },
      {
        name: "semantic_search",
        description:
          "Search the knowledge base semantically using vector embeddings stored in ChromaDB (via Benny API).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The semantic search query."
            },
            workspace: {
              type: "string",
              description: "The workspace to search (default: 'default')."
            },
            top_k: {
              type: "number",
              description: "Maximum number of results to return (default: 5)."
            }
          },
          required: ["query"]
        }
      },
      {
        name: "get_graph_stats",
        description:
          "Get summary statistics of the dual graph (node counts by label, relationship counts by type) for a workspace.",
        inputSchema: {
          type: "object",
          properties: {
            workspace: {
              type: "string",
              description: "The workspace to summarize (default: 'default')."
            }
          }
        }
      },
      {
        name: "find_correlated_concepts",
        description:
          "Find concept/documentation nodes that correlate with code symbols (or vice versa) via the CORRELATES_WITH edges in the Neo4j dual graph.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Substring filter to search in symbol names or concept names."
            },
            workspace: {
              type: "string",
              description: "The workspace context (default: 'default')."
            }
          },
          required: ["name"]
        }
      },
      {
        name: "offload_exec",
        description:
          "Offload an execution task to the local model (Benny) instead of doing it yourself. " +
          "Submit an aamp.offload_task/1 manifest; the orchestrator routes it by risk, runs it " +
          "locally, evaluates it against the acceptance criteria (deterministic gate + LLM judge), " +
          "and returns ONLY a compact digest — never the raw output. RED tasks (architecture, " +
          "ambiguous, security, signing/deterministic-zone) are refused and returned for you to " +
          "handle directly. Use this for the offloadable bulk (scaffolds, codemods, doc-gen, " +
          "spec'd features, repro'd bug fixes) so your tokens go to planning. The rule: if you can " +
          "write crisp testable acceptance_criteria up front, offload it.",
        inputSchema: {
          type: "object",
          properties: {
            task: {
              type: "object",
              description:
                "A complete aamp.offload_task/1 manifest (see manifests/offload/task.manifest.schema.json). " +
                "Required: format, id, intent, acceptance_criteria, risk_tier."
            },
            wait: {
              type: "boolean",
              description:
                "true (default) = run now and return the digest (sync lane). " +
                "false = enqueue for the async runner and return immediately."
            }
          },
          required: ["task"]
        }
      },
      // --- B2: coordination surface. Same ledger the `benny coord` CLI speaks to; thin client of
      // the B1 API when the server is up, direct-file via the B0 validator when it is not.
      {
        name: "coord_list",
        description:
          "List coordination tasks and their folded state (todo/claimed/done/blocked) plus the " +
          "holding agent. Use before claiming so you do not collide with another agent.",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "coord_claim",
        description:
          "Take a coordination task. Mutual exclusion is an atomic lease, so if another agent " +
          "already holds it you get ok:false reason:already-claimed — identical whether or not " +
          "the coordination server is running. Never work a task you did not successfully claim.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task id to claim" },
            agent: { type: "string", description: "Your registered agent id (default: claude)" }
          },
          required: ["task_id"]
        }
      },
      {
        name: "coord_report",
        description:
          "Report progress on, or completion of, a task you hold. state='done' also releases the " +
          "lease so another agent may take the task next.",
        inputSchema: {
          type: "object",
          properties: {
            task_id: { type: "string", description: "Task id you hold" },
            state: { type: "string", enum: ["progress", "done"], description: "What happened" },
            text: { type: "string", description: "Free-text detail for the event payload" },
            agent: { type: "string", description: "Your registered agent id (default: claude)" }
          },
          required: ["task_id", "state"]
        }
      },
      {
        name: "coord_note",
        description:
          "Share a knowledge note with the other agents on the ledger, optionally under a topic.",
        inputSchema: {
          type: "object",
          properties: {
            topic: { type: "string", description: "Topic key, for filtered retrieval" },
            text: { type: "string", description: "The note body" },
            agent: { type: "string", description: "Your registered agent id (default: claude)" }
          },
          required: ["text"]
        }
      }
    ]
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "execute_cypher": {
        const query = String(args?.query);
        const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
        const user = process.env.NEO4J_USER || "neo4j";
        const password = process.env.NEO4J_PASSWORD || "primesilo_dev_password";

        const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
        const session = driver.session();
        try {
          const result = await session.run(query);
          const records = result.records.map((r) => r.toObject());
          return {
            content: [{ type: "text", text: JSON.stringify(records, null, 2) }]
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Neo4j Error: ${e.message}` }],
            isError: true
          };
        } finally {
          await session.close();
          await driver.close();
        }
      }

      case "semantic_search": {
        const queryStr = String(args?.query);
        const ws = args?.workspace || "default";
        const topK = args?.top_k || 5;
        const apiPort = process.env.BENNY_API_PORT || 8005;
        const apiHost = process.env.BENNY_API_HOST || "127.0.0.1";

        try {
          const res = await fetch(`http://${apiHost}:${apiPort}/api/rag/query`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Benny-API-Key": BENNY_API_KEY
            },
            body: JSON.stringify({
              query: queryStr,
              workspace: ws,
              top_k: topK
            })
          });
          if (!res.ok) {
            throw new Error(`Benny API returned ${res.status}: ${await res.text()}`);
          }
          const data = await res.json();
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Semantic Search Error: ${e.message}` }],
            isError: true
          };
        }
      }

      case "get_graph_stats": {
        const ws = args?.workspace || "default";
        const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
        const user = process.env.NEO4J_USER || "neo4j";
        const password = process.env.NEO4J_PASSWORD || "primesilo_dev_password";

        const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
        const session = driver.session();
        try {
          const nodeResult = await session.run(
            `MATCH (n {workspace: $ws}) 
             RETURN labels(n)[0] as type, count(n) as count`,
            { ws: ws }
          );
          const relResult = await session.run(
            `MATCH (n {workspace: $ws})-[r]->(m) 
             RETURN type(r) as type, count(r) as count`,
            { ws: ws }
          );

          const nodeCounts = nodeResult.records.map((r) => r.toObject());
          const relCounts = relResult.records.map((r) => r.toObject());

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({ workspace: ws, nodeCounts, relCounts }, null, 2)
              }
            ]
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Neo4j Error: ${e.message}` }],
            isError: true
          };
        } finally {
          await session.close();
          await driver.close();
        }
      }

      case "find_correlated_concepts": {
        const nameFilter = String(args?.name);
        const ws = args?.workspace || "default";
        const uri = process.env.NEO4J_URI || "bolt://localhost:7687";
        const user = process.env.NEO4J_USER || "neo4j";
        const password = process.env.NEO4J_PASSWORD || "primesilo_dev_password";

        const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
        const session = driver.session();
        try {
          const query = `
            MATCH (c:Concept {workspace: $ws})-[r:CORRELATES_WITH]->(s {workspace: $ws})
            WHERE toLower(c.name) CONTAINS toLower($nameFilter) OR toLower(s.name) CONTAINS toLower($nameFilter)
            RETURN c.name as concept, s.name as symbol, s.type as symbol_type, r.confidence as confidence
            ORDER BY r.confidence DESC
            LIMIT 50
          `;
          const result = await session.run(query, { ws, nameFilter });
          const records = result.records.map((r) => r.toObject());
          return {
            content: [{ type: "text", text: JSON.stringify(records, null, 2) }]
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Neo4j Error: ${e.message}` }],
            isError: true
          };
        } finally {
          await session.close();
          await driver.close();
        }
      }

      case "offload_exec": {
        const task = args?.task;
        const wait = args?.wait !== false; // default true (sync)
        const apiPort = process.env.BENNY_API_PORT || 8005;
        const apiHost = process.env.BENNY_API_HOST || "127.0.0.1";
        if (!task || typeof task !== "object") {
          return {
            content: [{ type: "text", text: "offload_exec requires a `task` manifest object." }],
            isError: true
          };
        }
        try {
          const res = await fetch(
            `http://${apiHost}:${apiPort}/api/offload/submit?wait=${wait ? 1 : 0}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Benny-API-Key": BENNY_API_KEY
              },
              body: JSON.stringify(task)
            }
          );
          const data = await res.json();
          if (!res.ok) {
            // surface validation problems / router refusal compactly
            return {
              content: [
                {
                  type: "text",
                  text: `Offload rejected (${res.status}): ${JSON.stringify(data.detail || data)}`
                }
              ],
              isError: true
            };
          }
          // Return ONLY the compact digest — never the raw artifact.
          return {
            content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
          };
        } catch (e) {
          return {
            content: [
              {
                type: "text",
                text: `Offload Error: ${e.message} (is the Benny runtime up on ${apiHost}:${apiPort}?)`
              }
            ],
            isError: true
          };
        }
      }

      // --- B2: coordination surface (shares one client with the `benny coord` CLI) ---
      case "coord_list":
      case "coord_claim":
      case "coord_report":
      case "coord_note": {
        const coord = await import("../runtime/benny/agentamp/coord_client.mjs");
        const ctx = await coord.connect({});
        const agent = args?.agent ?? "claude";
        let result;
        if (name === "coord_list") result = { ok: true, mode: ctx.mode, tasks: await coord.list(ctx) };
        else if (name === "coord_claim") result = await coord.claim(ctx, String(args.task_id), agent);
        else if (name === "coord_note")
          result = await coord.note(ctx, agent, { topic: args?.topic, text: String(args.text) });
        else {
          const verb = args.state === "done" ? coord.done : coord.progress;
          result = await verb(ctx, String(args.task_id), agent, { note: args?.text });
        }
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          isError: result.ok === false
        };
      }

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`
            }
          ],
          isError: true
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${error.message}`
        }
      ],
      isError: true
    };
  }
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Prime-Silo Nexus MCP Server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
