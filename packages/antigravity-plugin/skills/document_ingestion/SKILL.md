---
name: document-ingestion
description: Ingests documents, extracts entities/relationships, and populates the localized Neo4j Knowledge Graph.
---

# Document Ingestion Skill

This skill enables agents to seamlessly ingest unstructured documents into the project's isolated Neo4j Knowledge Graph.

## Capabilities

1. **Entity Extraction**: Extract entities (people, concepts, systems) from documents.
2. **Relationship Mapping**: Map the relationships between entities.
3. **Neo4j Integration**: Push the extracted nodes and edges into a local Neo4j instance to serve as the Knowledge Mesh brain for this project.

## When to use

Use this skill whenever a user uploads a new design document, requirements spec, or unstructured text file and wants it "ingested into the graph" or "added to the knowledge mesh".

## Instructions

1. Parse the target document.
2. Formulate Cypher queries to `MERGE` nodes and relationships.
3. Use your execution tools to run the Cypher queries against the Neo4j endpoint configured in the local workspace.
