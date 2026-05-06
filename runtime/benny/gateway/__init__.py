"""
MCP Gateway — Tool governance layer implementing Remix Servers and RBAC.

Architecture:
- Remix Servers: Virtualized, curated tool endpoints scoped per workflow
- RBAC: Role-based access control down to individual tool level
- Credential Vault: Encrypted credential storage with ephemeral tokens
"""
