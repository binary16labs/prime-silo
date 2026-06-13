# AGENTS — integration manifests

## Purpose

`manifests/integrations/` holds **signed integration manifests** (`aamp.integration/1`): declarative records of every external-service integration the shell carries. Each manifest declares the integration's **data model** (entity ontology + per-endpoint payload contracts), its **process map** (the workflow DAG with `consumes`/`produces`/`health`/`owner` per node), its **config surface**, and its **conformance checks**. The code is a consumer of the manifest, never the other way around.

Current manifests:

- `memoray.integration.json` — the Memo-Ray memory graph (third graph of the cognitive mesh, beside the knowledge graph and the code graph).

## The maintenance loop (read this if you are an agent)

You do not need to spelunk the codebase to maintain an integration. The loop is:

1. **Read the manifest.** It tells you what the integration is supposed to look like: every endpoint shape, every config key, every owner file.
2. **Run the audit.** Any of these, all the same implementation (`server/lib/integration_audit.js`):
   - `GET /api/integration_audit` (shell HTTP, authenticated)
   - `node space memory audit` (CLI)
   - `node scripts/audit-integrations.mjs [--json]` (headless/CI; exit 1 on drift)
3. **For each `drift` finding, draft a fix at the finding's `owner` path.** A finding carries the exact repo + file where the fix belongs:
   - `payload_contracts` drift → either the upstream API changed (fix the consumer widgets listed in `owners`, then update the manifest contract) or the manifest is stale (update the contract). Decide which side moved; the detail string names the exact fields.
   - `config_surface` drift → `commands/params.yaml` lost a declared parameter.
   - `health` drift → the service is down or its base URL moved; check `config_surface` before touching code.
   - `owners` drift → a declared file moved; update the manifest's `owner.path`.
   - `signature` drift → the manifest was edited without re-signing (expected mid-edit; see step 5).
4. **Human review.** Per ADR-001, agents draft and humans pin: present the diff; do not self-approve.
5. **Re-sign after the human approves:** `node scripts/audit-integrations.mjs --sign` (HMAC-SHA256 with `BENNY_HMAC_KEY`, same canonical-payload scheme as `.aamp.view` pinning — see `server/lib/manifest_signing.js` and `runtime/benny/api/views_signing.py`).

A local LLM (e.g. via Lemonade) follows the identical loop: the audit JSON is its input, the `owner` paths are its work queue, and `--sign` stays a human step.

## Editing rules

- Never put secrets in a manifest. Config entries record key **names** and defaults, not values.
- Keep payload contracts honest: declare what consumers actually read, not the whole upstream response. A contract field nobody consumes is maintenance noise; a consumed field missing from the contract is a silent-drift trap (the `hotFiles.fileName`/`filePath` rename bug is the canonical example — the contract exists so the audit catches that class automatically).
- When you add a process-map node, give it an `owner` path and, if it is a service, a `health` probe.
- After any edit: run the audit, get human review, re-sign. An unsigned or stale-signed manifest is itself a drift finding.
