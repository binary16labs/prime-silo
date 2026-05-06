import asyncio
from benny.core.workspace import load_manifest
from benny.core.models import get_active_model

async def test():
    print("Loading manifest for c4_test...")
    manifest = load_manifest("c4_test")
    print(f"Manifest: {manifest}")
    print(f"Model roles: {manifest.model_roles}")
    
    try:
        print("\nResolving model for role 'swarm'...")
        model = await get_active_model(workspace_id="c4_test", role="swarm")
        print(f"Resolved model: {model}")
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    asyncio.run(test())
