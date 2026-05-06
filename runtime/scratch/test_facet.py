from benny.governance.lineage import AgentExecutionRecordFacet, BennyLineageClient
from openlineage.client.run import Run

def test_facet_init():
    try:
        facet = AgentExecutionRecordFacet(
            intent="Test Intent",
            observation="Test Observation",
            inference="Test Inference",
            plan="Test Plan",
            run_id="test-run-id"
        )
        print(f"Successfully initialized AgentExecutionRecordFacet")
        print(f"Producer: {facet._producer}")
        
        # Check if it has the required fields for OpenLineage serialization
        # OpenLineage BaseFacet often expects these
        assert hasattr(facet, "_producer")
        assert facet.intent == "Test Intent"
        
        print("Facet validation passed.")
    except Exception as e:
        print(f"Facet initialization FAILED: {e}")
        raise

if __name__ == "__main__":
    test_facet_init()
