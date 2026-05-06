"""
Credential Vault — Encrypted credential storage.

Uses Fernet symmetric encryption. Master key is derived from environment variable.
Credentials stored at: workspace/credentials/vault.json (encrypted)
"""

from __future__ import annotations

import os
import json
import logging
import hashlib
import base64
from typing import Optional, Dict
from pathlib import Path
from datetime import datetime

from ..core.workspace import get_workspace_path
from ..governance.audit import emit_governance_event

logger = logging.getLogger(__name__)

# Vault master key from environment (MUST be set for production)
VAULT_KEY_ENV = "BENNY_VAULT_KEY"
DEFAULT_KEY = "benny-dev-vault-key-2026-unsafe"


def _get_fernet():
    """Get Fernet encryption instance."""
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        logger.warning("cryptography package not installed. Vault will use base64 encoding (NOT SECURE).")
        return None
    
    raw_key = os.getenv(VAULT_KEY_ENV, DEFAULT_KEY)
    # Derive a 32-byte key using SHA-256, then base64-encode for Fernet
    key_bytes = hashlib.sha256(raw_key.encode()).digest()
    fernet_key = base64.urlsafe_b64encode(key_bytes)
    return Fernet(fernet_key)


def _vault_path(workspace: str) -> Path:
    """Get vault file path."""
    cred_dir = get_workspace_path(workspace) / "credentials"
    cred_dir.mkdir(parents=True, exist_ok=True)
    return cred_dir / "vault.json"


def _load_vault(workspace: str) -> Dict[str, str]:
    """Load the encrypted vault."""
    path = _vault_path(workspace)
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_vault(workspace: str, vault: Dict[str, str]) -> None:
    """Save the encrypted vault."""
    path = _vault_path(workspace)
    path.write_text(json.dumps(vault, indent=2), encoding="utf-8")


def store_credential(workspace: str, name: str, value: str) -> Dict:
    """
    Store an encrypted credential.
    
    Args:
        workspace: Target workspace
        name: Credential name (e.g., "openai_api_key")
        value: Plain-text credential value
    
    Returns:
        Status dict
    """
    fernet = _get_fernet()
    vault = _load_vault(workspace)
    
    if fernet:
        encrypted = fernet.encrypt(value.encode()).decode()
    else:
        # Fallback: base64 (NOT secure, only for dev)
        encrypted = base64.b64encode(value.encode()).decode()
    
    vault[name] = encrypted
    _save_vault(workspace, vault)
    
    _audit_credential_access(workspace, name, "store")
    
    return {"status": "stored", "name": name}


def get_credential(workspace: str, name: str) -> Optional[str]:
    """
    Retrieve and decrypt a credential.
    
    Args:
        workspace: Target workspace
        name: Credential name
    
    Returns:
        Decrypted credential value, or None if not found
    """
    fernet = _get_fernet()
    vault = _load_vault(workspace)
    
    encrypted = vault.get(name)
    if encrypted is None:
        _audit_credential_access(workspace, name, "get_not_found")
        return None
    
    _audit_credential_access(workspace, name, "get")
    
    try:
        if fernet:
            return fernet.decrypt(encrypted.encode()).decode()
        else:
            return base64.b64decode(encrypted.encode()).decode()
    except Exception as e:
        logger.error("Failed to decrypt credential '%s': %s", name, e)
        return None


def list_credentials(workspace: str) -> list:
    """List credential names (NOT values)."""
    vault = _load_vault(workspace)
    return list(vault.keys())


def delete_credential(workspace: str, name: str) -> Dict:
    """Delete a credential."""
    vault = _load_vault(workspace)
    if name in vault:
        del vault[name]
        _save_vault(workspace, vault)
        _audit_credential_access(workspace, name, "delete")
        return {"status": "deleted", "name": name}
    return {"status": "not_found", "name": name}


def _audit_credential_access(workspace: str, name: str, operation: str):
    """Audit log every credential access."""
    try:
        emit_governance_event(
            event_type="CREDENTIAL_ACCESS",
            data={
                "credential_name": name,
                "operation": operation,
                "timestamp": datetime.utcnow().isoformat(),
            },
            workspace_id=workspace
        )
    except Exception:
        pass
