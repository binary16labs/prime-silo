from dataclasses import dataclass
from typing import Optional, List, Dict, Any

# Mock BaseFacet to avoid importing openlineage
class BaseFacet:
    pass

@dataclass
class AgentExecutionRecordFacet(BaseFacet):
    intent: str
    observation: str
    inference: str = ""
    plan: str = ""
    run_id: Optional[str] = None
    _producer: str = "test-producer"
    _schemaURL: Optional[str] = None

def test():
    f = AgentExecutionRecordFacet(intent="i", observation="o")
    print(f"Producer: {f._producer}")
    assert f._producer == "test-producer"
    print("Dataclass test passed.")

if __name__ == "__main__":
    test()
