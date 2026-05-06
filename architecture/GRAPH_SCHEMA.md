# Graph Schema & Modeling: The Neural Nexus

This document details the schema of the spatial code graph (Neo4j) and how it is derived from source code via Tree-Sitter AST projection.

## 1. Node Classes

| Label | Description | Attributes |
| :--- | :--- | :--- |
| **`CodeEntity`** | Base label for all source symbols | `id`, `name`, `type`, `workspace`, `snapshot_id`, `created_at`, `updated_at`, `ast_range_start`, `ast_range_end` |
| **`File`** | A physical source file | `file_path`, `ext` |
| **`Class`** | A class definition | `name` |
| **`Function`** | A function or method | `name`, `is_method` |
| **`Folder`** | A directory entity | `path` |
| **`Concept`** | Semantic abstraction | `name`, `node_type: 'Concept'`, `created_at`, `updated_at` |
| **`Documentation`**| Ingested markdown/PDF | `filename`, `source_type`, `created_at`, `updated_at` |
| **`Document`** | Source document node in triple graph | `name`, `workspace`, `created_at`, `updated_at` |

### Temporal Properties (All Nodes)

| Property | Type | Description |
| :--- | :--- | :--- |
| `created_at` | datetime | When this node was first created via MERGE |
| `updated_at` | datetime | Last time a re-ingest touched this node |
| `superseded_by` | string (nullable) | ID of the node that replaced this one *(Phase 2 deferred)* |
| `superseded_at` | datetime (nullable) | When this node was superseded *(Phase 2 deferred)* |

### AST Range Properties (CodeEntity only)

| Property | Type | Description |
| :--- | :--- | :--- |
| `ast_range_start` | list [line, col] | Tree-sitter start position of the symbol |
| `ast_range_end` | list [line, col] | Tree-sitter end position of the symbol |

## 2. Relationship Types (Edge Modeling)

### 2.1 Structural Relationships (Static)
*   **`DEFINES`**: A file or class contains a symbol.
    *   `(File)-[:DEFINES]->(Class)`
    *   `(Class)-[:DEFINES]->(Function)`
*   **`INHERITS`**: Class hierarchy.
    *   `(Class)-[:INHERITS]->(ParentClass)`
*   **`DEPENDS_ON`**: Import-level dependency.
    *   `(File)-[:DEPENDS_ON]->(ExternalModule)`

### 2.2 Semantic Relationships (Inferred)
*   **`REPRESENTS`**: Bridge between a Code Symbol and a Semantic Concept.
    *   `(CodeEntity)-[:REPRESENTS]->(Concept)`
*   **`CORRELATES_WITH`**: Deep semantic link discovered via embeddings or exact name match.
    *   `(Concept)-[:CORRELATES_WITH {strategy: 'aggressive'}]->(CodeEntity)`
    *   **Required properties on every `CORRELATES_WITH` edge**:

| Property | Type | Description |
| :--- | :--- | :--- |
| `confidence` | float [0.0–1.0] | Cosine similarity score or 1.0 for exact match |
| `rationale` | string | Human-readable explanation of why this link exists |
| `strategy` | string | `'safe'` \| `'aggressive'` \| `'manual'` |
| `created_at` | timestamp | When the edge was first created |
| `updated_at` | timestamp | Last time the edge was refreshed |

*   **`REL`**: Directed knowledge triple relationship between two Concepts.
    *   `(Concept)-[:REL {predicate: 'causes'}]->(Concept)`
    *   **Required properties on every `REL` edge**:

| Property | Type | Description |
| :--- | :--- | :--- |
| `confidence` | float [0.0–1.0] | LLM-assigned confidence |
| `rationale` | string | `Extracted from '{file}' via '{strategy}' strategy using model '{model}'` |
| `strategy` | string | `'safe'` \| `'aggressive'` \| `'directed'` |
| `source_file` | string | Source document filename |
| `doc_fragment_id` | string | MD5 of source chunk text — enables DNA trace |
| `citation` | string | Exact excerpt that justifies the claim |
| `created_at` | timestamp | Edge creation time |
| `updated_at` | timestamp | Last refresh time |


## 3. Ingestion Pipeline (Tree-Sitter Logic)

The `CodeGraphAnalyzer` uses language-specific Tree-Sitter queries (UML Pattern Queries) to extract semantic blocks:

1.  **AST Generation**: Tree-Sitter parses source content into a concrete syntax tree.
2.  **Capture Refinement**: Predicates (e.g., `(class_definition name: (identifier) @class_name)`) isolate architectural symbols.
3.  **Entity Resolution**: Symbols are mapped to unique IDs (e.g., `path/to/file.py::ClassName`).
4.  **Batch Upsert**: The resulting JSON graph is synced to Neo4j using `MERGE` operations to maintain idempotency.

---

*Ref: See `benny/graph/code_analyzer.py` for query implementation.*

## 4. Observed Instance Stats (Live Scan)
**Workspace**: C:\Users\nsdha\OneDrive\code\benny
**Total Entities**: 1232
**Total Relationships**: 2248

| Entity Type | Count |
| :--- | :--- |
| Function | 694 |
| File | 211 |
| Class | 129 |
| Interface | 68 |
| Folder | 66 |
| Documentation | 55 |
| ExternalClass | 9 |

| Relationship Type | Count |
| :--- | :--- |
| DEPENDS_ON | 1167 |
| DEFINES | 943 |
| INHERITS | 92 |
| CONTAINS | 46 |
