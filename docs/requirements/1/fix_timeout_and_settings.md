# Finalized AI Manifests: YAML Config, Discovery, and Governance

Based on your feedback, we'll implement **GitOps-style YAML manifests** for workspace configuration, with built-in versioning for auditability and a centralized discovery layer for observability.

## User Review Required

> [!IMPORTANT]
>
> - **YAML Manifests**: We will use `manifest.yaml` in each workspace root. This is the source of truth for basic config and discovery.
> - **Versioning**: Every manifest will include a `version` field. This enables schema migrations, rollback capabilities, and audit trails.
> - **Discovery Crawler**: The system will automatically harvest and display these settings in the centralized workspace list (`GET /api/workspaces`).

## Proposed Changes

### 1. Global Schema (Governance Gate)

#### [NEW] [schema.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/schema.py)

- Define `WorkspaceManifest` (Pydantic):
  - `version`: `str` (The schema version, e.g., "1.0.0")
  - `llm_timeout`: `float` (Customizable timeout for LLM calls)
  - `default_model`: `str` (The primary model for this workspace)
  - `governance_tags`: `List[str]` (Tags for auditing, security, and classification)
  - `metadata`: `Dict[str, Any]` (Arbritrary extension fields)

### 2. Workspace Layer (Decentralized YAML)

#### [MODIFY] [workspace.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/core/workspace.py)

- Integrate `PyYAML` for manifest management.
- `load_manifest(workspace_id)`: Loads and validates `manifest.yaml`.
- `save_manifest(workspace_id, manifest)`: Serializes back to YAML.
- **Discovery**: Update `list_workspaces()` to crawl and include manifest data in the returned workspace list.

### 3. API & Monitoring (Centralized Catalog)

#### [NEW] [workspace_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/workspace_routes.py)

- `GET /api/workspaces/{workspace_id}/manifest`: Returns JSON representation of the YAML manifest.
- `POST /api/workspaces/{workspace_id}/manifest`: Validates and saves changes to the YAML file.

#### [MODIFY] [server.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/server.py)

- Register `workspace_routes`.

### 4. Integration

#### [MODIFY] [graph_routes.py](file:///C:/Users/nsdha/OneDrive/code/benny/benny/api/graph_routes.py)

- Update code to read `llm_timeout` from the workspace YAML manifest.

## Open Questions

- None at this stage. We have alignment on YAML for storage/discovery and JSON for complex API interactions.

## Verification Plan

### Automated Tests

- Verify `manifest.yaml` creation and validation against the Pydantic schema.
- Test "Discovery" by checking if `list_workspaces` returns aggregated metadata from multiple YAML files.

### Manual Verification

- Edit a `manifest.yaml` manually in the IDE and verify the change shows up in the Discovery Catalog (UI/API).
- Attempt to set an invalid value (e.g., negative timeout) to verify schema enforcement.
