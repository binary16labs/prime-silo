"""
Workflow Storage - File-based persistence for workflow definitions
"""

from pathlib import Path
from typing import List, Dict, Any, Optional
import json
import yaml
from datetime import datetime


# Storage locations
BASE_DIR = Path(__file__).parent.parent.parent
WORKSPACE_WORKFLOWS = BASE_DIR / "workspace" / "workflows"
EXAMPLE_WORKFLOWS = BASE_DIR / "benny" / "examples" / "workflows"


class WorkflowStorage:
    """Manage workflow persistence across user and system directories"""
    
    def __init__(self):
        # Ensure directories exist
        WORKSPACE_WORKFLOWS.mkdir(parents=True, exist_ok=True)
        EXAMPLE_WORKFLOWS.mkdir(parents=True, exist_ok=True)
        print(f"DEBUG: WorkflowStorage initialized at {BASE_DIR}")
        print(f"DEBUG: Workspace: {WORKSPACE_WORKFLOWS.absolute()}")
    
    def _get_strategy_visuals(self, data: Dict[str, Any], file_path: Path) -> Dict[str, Any]:
        """Generate visual nodes/edges for a non-visual strategy workflow"""
        nodes = []
        edges = []
        
        # 1. Input Data Nodes
        trigger_files = data.get("trigger", {}).get("files", [])
        for i, filename in enumerate(trigger_files):
            nodes.append({
                "id": f"input_{i}",
                "type": "data",
                "position": {"x": 50, "y": i * 80},
                "data": {"label": filename, "config": {"operation": "read"}}
            })
            edges.append({
                "id": f"ei_{i}",
                "source": f"input_{i}",
                "target": "strat_planner",
                "animated": True,
                "label": "source"
            })
        
        # 2. Core Swarm Components
        nodes.extend([
            {"id": "strat_planner", "type": "llm", "position": {"x": 300, "y": 0}, "data": {"label": "Planner (Bricoleur)", "config": {"persona": "Architect"}}},
            {"id": "strat_logic", "type": "logic", "position": {"x": 300, "y": 120}, "data": {"label": "Orchestrator", "config": {"operation": "Command"}}},
            {"id": "strat_worker", "type": "tool", "position": {"x": 300, "y": 240}, "data": {"label": "Executor Mesh", "config": {"tool": "swarm_execution"}}},
            {"id": "strat_data", "type": "data", "position": {"x": 300, "y": 360}, "data": {"label": "Aggregator (Kludge)", "config": {"operation": "combine"}}}
        ])
        
        edges.extend([
            {"id": "se1", "source": "strat_planner", "target": "strat_logic", "animated": True},
            {"id": "se2", "source": "strat_logic", "target": "strat_worker", "animated": True},
            {"id": "se3", "source": "strat_worker", "target": "strat_data", "animated": True}
        ])
        
        # 3. Output Data Nodes
        outputs = data.get("strategy", {}).get("outputs", [])
        for i, filename in enumerate(outputs):
            nodes.append({
                "id": f"output_{i}",
                "type": "data",
                "position": {"x": 550, "y": i * 80 + 320},
                "data": {"label": filename, "config": {"operation": "write"}}
            })
            edges.append({
                "id": f"eo_{i}",
                "source": "strat_data",
                "target": f"output_{i}",
                "animated": True,
                "label": "artifact"
            })
            
        return {
            "id": data.get("id", file_path.stem),
            "name": data.get("name", file_path.stem),
            "description": data.get("description", "Strategic Swarm Workflow"),
            "type": "strategy",
            "file_path": str(file_path),
            "nodes": nodes,
            "edges": edges
        }

    def list_workflows(self) -> List[Dict[str, Any]]:
        """List all available workflows (user + examples)"""
        workflows = []
        
        # Load user workflows
        if WORKSPACE_WORKFLOWS.exists():
            # JSON Workflows
            for file_path in WORKSPACE_WORKFLOWS.glob("*.json"):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        workflows.append({
                            **data,
                            "type": "user",
                            "file_path": str(file_path)
                        })
                except Exception as e:
                    print(f"ERROR: Failed to load JSON workflow {file_path}: {e}")
            
            # YAML Strategies
            for ext in ["*.yaml", "*.yml"]:
                for file_path in WORKSPACE_WORKFLOWS.glob(ext):
                    try:
                        print(f"DEBUG: Attempting to load YAML strategy: {file_path}")
                        with open(file_path, 'r', encoding='utf-8') as f:
                            data = yaml.safe_load(f)
                            if data:
                                workflows.append(self._get_strategy_visuals(data, file_path))
                                print(f"DEBUG: Successfully loaded strategy: {data.get('name')}")
                            else:
                                print(f"WARNING: YAML file is empty: {file_path}")
                    except Exception as e:
                        print(f"ERROR: Failed to load YAML strategy {file_path}: {e}")
                        import traceback
                        traceback.print_exc()
        
        # Load example workflows
        if EXAMPLE_WORKFLOWS.exists():
            for file_path in EXAMPLE_WORKFLOWS.glob("*.json"):
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        workflows.append({
                            **data,
                            "type": "example",
                            "readonly": True,
                            "file_path": str(file_path)
                        })
                except Exception:
                    pass
        
        # Add System Metadata
        response = {
            "workflows": workflows,
            "metadata": {
                "version": "1.0.1-strategic",
                "timestamp": datetime.now().isoformat(),
                "cwd": str(Path.cwd()),
                "workspace_path": str(WORKSPACE_WORKFLOWS.absolute())
            }
        }
        return response
    
    def get_workflow(self, workflow_id: str) -> Optional[Dict[str, Any]]:
        """Get a specific workflow by ID"""
        # Check user workflows first
        user_path = WORKSPACE_WORKFLOWS / f"{workflow_id}.json"
        if user_path.exists():
            with open(user_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return {**data, "type": "user"}
        
        # Check user YAML (strategy)
        for ext in [".yaml", ".yml"]:
            yaml_path = WORKSPACE_WORKFLOWS / f"{workflow_id}{ext}"
            if yaml_path.exists():
                try:
                    with open(yaml_path, 'r', encoding='utf-8') as f:
                        data = yaml.safe_load(f)
                        return self._get_strategy_visuals(data, yaml_path)
                except Exception as e:
                    print(f"ERROR: Failed to get YAML workflow {workflow_id}: {e}")
        
        # Check examples
        example_path = EXAMPLE_WORKFLOWS / f"{workflow_id}.json"
        if example_path.exists():
            with open(example_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
                return {**data, "type": "example", "readonly": True}
        
        return None
    
    def save_workflow(self, workflow: Dict[str, Any]) -> Dict[str, Any]:
        """Save a workflow to user directory"""
        workflow_id = workflow.get("id")
        if not workflow_id:
            raise ValueError("Workflow must have an 'id' field")
        
        # Add metadata
        workflow["updated_at"] = datetime.now().isoformat()
        if "created_at" not in workflow:
            workflow["created_at"] = workflow["updated_at"]
        
        # Save to user directory
        file_path = WORKSPACE_WORKFLOWS / f"{workflow_id}.json"
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(workflow, f, indent=2)
        
        return {"status": "saved", "id": workflow_id, "path": str(file_path)}
    
    def delete_workflow(self, workflow_id: str) -> Dict[str, Any]:
        """Delete a workflow (user workflows only)"""
        # Try JSON
        file_path = WORKSPACE_WORKFLOWS / f"{workflow_id}.json"
        if file_path.exists():
            file_path.unlink()
            return {"status": "deleted", "id": workflow_id}
            
        # Try YAML
        for ext in [".yaml", ".yml"]:
            file_path = WORKSPACE_WORKFLOWS / f"{workflow_id}{ext}"
            if file_path.exists():
                file_path.unlink()
                return {"status": "deleted", "id": workflow_id}
        
        raise FileNotFoundError(f"Workflow not found: {workflow_id}")
