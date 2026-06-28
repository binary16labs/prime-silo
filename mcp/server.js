import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import neo4j from "neo4j-driver";

const server = new Server(
  {
    name: "prime-silo-nexus",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "execute_cypher",
        description: "Execute an arbitrary Cypher query on the Neo4j dual graph (contains both Tree-sitter code structures and Docling RAG concepts connected via CORRELATES_WITH).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The Cypher query to execute on Neo4j.",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "semantic_search",
        description: "Search the knowledge base semantically using vector embeddings stored in ChromaDB (via Benny API).",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The semantic search query.",
            },
            workspace: {
              type: "string",
              description: "The workspace to search (default: 'default').",
            },
            top_k: {
              type: "number",
              description: "Maximum number of results to return (default: 5).",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "get_graph_stats",
        description: "Get summary statistics of the dual graph (node counts by label, relationship counts by type) for a workspace.",
        inputSchema: {
          type: "object",
          properties: {
            workspace: {
              type: "string",
              description: "The workspace to summarize (default: 'default').",
            },
          },
        },
      },
      {
        name: "find_correlated_concepts",
        description: "Find concept/documentation nodes that correlate with code symbols (or vice versa) via the CORRELATES_WITH edges in the Neo4j dual graph.",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "Substring filter to search in symbol names or concept names.",
            },
            workspace: {
              type: "string",
              description: "The workspace context (default: 'default').",
            },
          },
          required: ["name"],
        },
      },
    ],
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "execute_cypher": {
        const query = String(args?.query);
        const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
        const user = process.env.NEO4J_USER || 'neo4j';
        const password = process.env.NEO4J_PASSWORD || 'primesilo_dev_password';

        const driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
        const session = driver.session();
        try {
          const result = await session.run(query);
          const records = result.records.map(r => r.toObject());
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
              "X-Benny-API-Key": "benny-mesh-2026-auth"
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
        const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
        const user = process.env.NEO4J_USER || 'neo4j';
        const password = process.env.NEO4J_PASSWORD || 'primesilo_dev_password';

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
          
          const nodeCounts = nodeResult.records.map(r => r.toObject());
          const relCounts = relResult.records.map(r => r.toObject());
          
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ workspace: ws, nodeCounts, relCounts }, null, 2)
            }]
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
        const uri = process.env.NEO4J_URI || 'bolt://localhost:7687';
        const user = process.env.NEO4J_USER || 'neo4j';
        const password = process.env.NEO4J_PASSWORD || 'primesilo_dev_password';

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
          const records = result.records.map(r => r.toObject());
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

      default:
        return {
          content: [
            {
              type: "text",
              text: `Unknown tool: ${name}`,
            },
          ],
          isError: true,
        };
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error executing tool ${name}: ${error.message}`,
        },
      ],
      isError: true,
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
