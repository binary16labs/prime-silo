---
name: knowledge_search
description: Semantic search capability over the workspace Knowledge Graph using ChromaDB
---

## Usage

Use this skill when you need to answer questions or find information within the user's workspace documents. It is backed by ChromaDB and local embeddings. You can search semantically, list all available documents, or retrieve an entire document's contents.

## Tools

- `search_knowledge_workspace(query, workspace="default", top_k=20, active_nexus_id=None)` - Perform semantic search and return relevant text chunks with relevance scores.
- `list_available_documents(workspace="default")` - Returns a list of all documents currently ingested into the ChromaDB knowledge base.
- `read_full_document(document_name, workspace="default")` - Retrieves the complete text of a specified document.

## Examples

**Action:** search_knowledge_workspace
**Action Input:** `{"query": "governance policies for the Pypes engine"}`
**Observation:** Returns chunks of `requirement.md` discussing Pypes engine governance.
