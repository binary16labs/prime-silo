# Benny Documentation Directives (docs/AGENTS.md)

This directory contains Benny's documentation, including strict Six-Sigma requirements (`requirements/`) and operations guides (`operations/`).

## DeepWiki Integration (New)
Agents are now responsible for maintaining a human-readable narrative layer called "DeepWiki" alongside the strict matrix documents.
- When you update a requirement or an acceptance matrix, automatically reflect those changes in summary documents if applicable.
- Make the complex understandable. Humans read the summaries; agents and CI/CD pipelines read the strict matrices.

## Implementation Rules
1. **Traceability**: Every feature requirement must map to a test case in an `acceptance_matrix.md`.
2. **Clarity**: Keep the "Do Not Do" lists explicitly visible. 
3. **No Drift**: If you change code that invalidates a doc, update the doc immediately. Documentation drift is considered a critical failure.
