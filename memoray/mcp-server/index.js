import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { DataReader } from "./data-reader.js";

const server = new Server(
  {
    name: "mem0ray-mcp-server",
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
        name: "get_recent_sessions",
        description: "Get a list of the most recent agent sessions tracked by Mem0Ray. Use this to find out what agents have been doing recently, optionally filtering by agent name.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "number",
              description: "Maximum number of sessions to return (default: 10)",
            },
            agent: {
              type: "string",
              description: "Filter sessions by agent name (e.g. 'claude', 'antigravity')",
            },
          },
        },
      },
      {
        name: "get_project_activity",
        description: "Get recent agent activity (sessions) filtered by a specific project name or workspace path.",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "The project name or absolute path (e.g., 'benny' or 'c:/Users/nsdha/OneDrive/code/benny')",
            },
            limit: {
              type: "number",
              description: "Maximum number of sessions to return (default: 10)",
            },
          },
          required: ["projectPath"],
        },
      },
      {
        name: "get_session_timeline",
        description: "Fetch the complete timeline of events for a session, including all thoughts, tool calls, and results.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The ID of the session to fetch",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_session_timeline_window",
        description: "Fetch a sliding window slice of the session timeline, useful for keeping context sizes small.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The ID of the session to fetch",
            },
            limit: {
              type: "number",
              description: "Maximum number of events to return (default 50)",
            },
            offset: {
              type: "number",
              description: "Number of events to skip from the end of the timeline (default 0)",
            },
          },
          required: ["sessionId"],
        },
      },
      {
        name: "get_project_summary_and_skills",
        description: "Get a summary of a project's sessions, total steps, and extract learned skills from past agent interactions.",
        inputSchema: {
          type: "object",
          properties: {
            projectPath: {
              type: "string",
              description: "The project name or absolute path",
            },
          },
          required: ["projectPath"],
        },
      },
      {
        name: "get_graph_data",
        description: "Get graph-ready node/link data for a session, suitable for rendering force-directed or chronological visualisations on a canvas.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: {
              type: "string",
              description: "The ID of the session to build graph data for",
            },
          },
          required: ["sessionId"],
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
      case "get_recent_sessions": {
        const limit = args?.limit || 10;
        const agent = args?.agent || null;
        const sessions = await DataReader.getRecentSessions(limit, null, agent);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sessions, null, 2),
            },
          ],
        };
      }

      case "get_project_activity": {
        const projectPath = String(args?.projectPath);
        const limit = args?.limit || 10;
        const sessions = await DataReader.getRecentSessions(limit, projectPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sessions, null, 2),
            },
          ],
        };
      }

      case "get_session_timeline": {
        const sessionId = String(args?.sessionId);
        const timeline = await DataReader.getSessionTimeline(sessionId);
        
        if (!timeline || timeline.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `Session timeline not found or empty for ID: ${sessionId}`,
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(timeline, null, 2),
            },
          ],
        };
      }

      case "get_session_timeline_window": {
        const sessionId = String(args?.sessionId);
        const limit = args?.limit ? Number(args.limit) : 50;
        const offset = args?.offset ? Number(args.offset) : 0;
        
        const timelineWindow = await DataReader.getSessionTimelineWindow(sessionId, limit, offset);

        if (!timelineWindow) {
          return {
            content: [{ type: "text", text: `Session timeline not found: ${sessionId}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(timelineWindow, null, 2),
            },
          ],
        };
      }

      case "get_project_summary_and_skills": {
        const projectPath = String(args?.projectPath);
        const stats = await DataReader.getProjectStatsAndSkills(projectPath);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(stats, null, 2),
            },
          ],
        };
      }

      case "get_graph_data": {
        const sessionId = String(args?.sessionId);
        const graphData = await DataReader.getGraphData(sessionId);
        if (!graphData || graphData.nodes.length === 0) {
          return {
            content: [{ type: "text", text: `No graph data found for session: ${sessionId}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: JSON.stringify(graphData, null, 2) }],
        };
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
  console.error("Mem0Ray MCP Server running on stdio");
}

run().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
