import pytest
from benny.core.skill_registry import registry
from benny.governance.permission_manifest import create_ephemeral_manifest, register_manifest

def test_skill_registry_enforces_manifest():
    """Test that SkillRegistry blocks tools not in the manifest."""
    # 1. Setup ephemeral manifest for task_99
    # Task 99 is only allowed 'read_document'
    manifest = create_ephemeral_manifest("99", ["read_document"])
    register_manifest(manifest)
    
    # 2. Attempt to execute 'read_document' (allowed)
    # We mock the handler to avoid actual tool execution
    from benny.core.skill_registry import SKILL_HANDLERS
    SKILL_HANDLERS["read_document"] = lambda **kwargs: "success"
    
    res_allowed = registry.execute_skill("read_document", "default", agent_id="task_99")
    assert res_allowed == "success"
    
    # 3. Attempt to execute 'write_file' (blocked)
    res_blocked = registry.execute_skill("write_file", "default", agent_id="task_99")
    assert "SECURITY_PERMISSION_VIOLATION" in res_blocked
    assert "write_file" in res_blocked

def test_deny_by_default_no_manifest():
    """Test that SkillRegistry blocks all tools if no manifest exists."""
    # task_unknown has no manifest
    res = registry.execute_skill("read_document", "default", agent_id="task_unknown")
    assert "SECURITY_PERMISSION_VIOLATION" in res or "No permission manifest registered" in res
