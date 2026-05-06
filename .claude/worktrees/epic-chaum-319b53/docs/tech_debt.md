# Technical Debt Registry - Cognitive Mesh

This document tracks temporary compromises, hardcoded values, and non-standard implementations that require future remediation for enterprise-grade maturity.

| ID | Issue | Location | Risk | Remediation Path |
| :--- | :--- | :--- | :--- | :--- |
| **TD-001** | Hardcoded API Key | `server.py` | Low (Local) | Implement dynamic key generation per workspace or OIDC. |
| **TD-002** | JSON State Persistence | `task_manager.py` | Medium | Move to SQLite/PostgreSQL for concurrent write safety and better query support. |
| **TD-003** | Pseudo-BPMN Logic | `Studio` / `Executor` | Low | Implement full BPMN 2.0 XML export for formal regulatory compliance. |
| **TD-004** | Broad CORS (Localhost) | `server.py` | Low | Specific whitelist per workspace origin. |

## Remediation Tasks
- [ ] Implement `X-Benny-API-Key` rotation mechanism.
- [ ] Migrate `task_registry.json` to relational schema.
- [ ] Add BPMN XML Export button to Studio.
