# Benny Tool Registry

Master registry of all tools available to agents.

---

## Knowledge Tools

### `search_knowledge_workspace`

Search workspace knowledge base using semantic similarity.

```python
@tool
def search_knowledge_workspace(
    query: str,
    workspace: str = "default",
    top_k: int = 5
) -> str:
    """
    Args:
        query: Search query
        workspace: Workspace ID for scoped search
        top_k: Number of results

    Returns:
        Formatted search results with sources
    """
```

**Example:**

```
Action: search_knowledge_workspace
Action Input: {"query": "governance frameworks", "workspace": "default", "top_k": 5}
```

---

### `list_available_documents`

List all documents in a workspace's knowledge base.

```python
@tool
def list_available_documents(workspace: str = "default") -> str:
    """
    Returns:
        List of documents with chunk counts
    """
```

---

### `read_full_document`

Retrieve complete document content.

```python
@tool
def read_full_document(document_name: str, workspace: str = "default") -> str:
    """
    Args:
        document_name: Name of document to read
        workspace: Workspace ID

    Returns:
        Full document text (pass-by-reference if >5KB)
    """
```

---

## File Tools

### `write_file`

Write content to workspace file.

```python
@tool
def write_file(filename: str, content: str, workspace: str = "default") -> str:
    """
    Args:
        filename: Target filename
        content: Content to write
        workspace: Workspace ID

    Returns:
        Confirmation with download URL
    """
```

**Example:**

```
Action: write_file
Action Input: {"filename": "report.md", "content": "# Report\n...", "workspace": "default"}
Observation: Written to report.md
📥 Download: http://localhost:8000/api/files/default/report.md
```

---

### `read_file`

Read file from workspace.

```python
@tool
def read_file(filename: str, workspace: str = "default") -> str:
    """
    Args:
        filename: File to read
        workspace: Workspace ID

    Returns:
        File content (pass-by-reference if >5KB)
    """
```

---

## Data Processing Tools

### `extract_pdf_text`

Extract text content from PDF file.

```python
@tool
def extract_pdf_text(pdf_path: str, workspace: str = "default") -> str:
    """
    Args:
        pdf_path: Path to PDF file
        workspace: Workspace ID

    Returns:
        Extracted text content
    """
```

---

### `query_csv`

Query CSV file with Pandas.

```python
@tool
def query_csv(
    csv_path: str,
    query: str,
    workspace: str = "default"
) -> str:
    """
    Args:
        csv_path: Path to CSV file
        query: Pandas query string (e.g., "df[df['amount'] > 100]")
        workspace: Workspace ID

    Returns:
        Query results as formatted table
    """
```

---

## Tool Implementation Status

| Tool                         | Module           | Status |
| ---------------------------- | ---------------- | ------ |
| `search_knowledge_workspace` | knowledge_search | ✅     |
| `list_available_documents`   | knowledge_search | ✅     |
| `read_full_document`         | knowledge_search | ✅     |
| `write_file`                 | file_operations  | ✅     |
| `read_file`                  | file_operations  | ✅     |
| `extract_pdf_text`           | data_processing  | ✅     |
| `query_csv`                  | data_processing  | ✅     |

---

> **Version**: Benny v1.0  
> **Last Updated**: 2026-01-31
