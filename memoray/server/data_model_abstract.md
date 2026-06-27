# Agent OS Dashboard - Portable Entity Data Model

This document serves as the "Modeling Abstract" for the Agent OS Dashboard's backend data architecture. It defines the universal ontology and schema. Future AI agents reading this file will instantly know how to navigate the ecosystem's data without external context.

## 1. Architectural Pattern: Atomic File-System Database
To ensure infinite scalability, zero tribal knowledge overhead, and high readability, we use an **Atomic File-System Database**. 
- Every distinct piece of data (a session, a chat, a thought, a tool call, an artifact) is an **Entity**.
- Every Entity is stored as an individual JSON file in `server/data/entities/<EntityID>.json`.
- A master index (`server/data/index.json`) maintains a fast lookup table of all entities and last-modified timestamps for Delta Syncing.

## 2. Universal Ontology (Entity Schema)

Every JSON file in `server/data/entities/` adheres to the following base schema:

```json
{
  "id": "String (UUID or deterministic hash)",
  "type": "String (Enum: Session, Message, Thought, ToolCall, ToolResult, Artifact, CoWork)",
  "agent": "String (Claude | Antigravity | User)",
  "timestamp": "Number (Unix epoch ms)",
  "content": "String (The actual payload, text, or tool argument)",
  "metadata": {
    "model": "String",
    "cwd": "String",
    "fileName": "String (for artifacts)"
  },
  "parent_id": "String (ID of the node this branches from)",
  "children_ids": ["Array of child IDs"]
}
```

### 2.1 Entity Types
- **Session**: The root node for a specific project/thread.
- **User Input**: A prompt or command from the human user.
- **Thought**: The agent's internal reasoning or plan before acting.
- **Tool Call**: An action taken by the agent (e.g., read_file, run_command).
- **Artifact**: A generated document or file (e.g., PRD, Implementation Plan) linked to the session.
- **CoWork**: Sync events or data shared between agents.

## 3. How to Traverse the Graph
1. Read `server/data/index.json` to get a list of all Root **Session** entities.
2. Read a specific Session file: `server/data/entities/<session_id>.json`.
3. Follow the `children_ids` array to load the subsequent messages, thoughts, or artifacts.
4. Render the graph by recursively expanding `children_ids`.

## 4. Delta Sync Engine
To maintain performance, the system does not re-read raw agent logs on every boot. It maintains a `last_sync_timestamp` in `index.json`. 
When the server starts, it checks raw logs for files modified *after* `last_sync_timestamp`, parses only those files, extracts the new entities, writes the new JSON files, and updates the index.
